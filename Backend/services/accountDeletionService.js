'use strict';

const User = require('../models/User');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const ShippingMethod = require('../models/ShippingMethod');
const SellerAdRequest = require('../models/SellerAdRequest');
const SellerSubscription = require('../models/SellerSubscription');
const SellerPaymentAccount = require('../models/SellerPaymentAccount');
const SellerCheckoutClaim = require('../models/SellerCheckoutClaim');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const SellerNotificationLog = require('../models/SellerNotificationLog');
const StoreReview = require('../models/StoreReview');
const StoreTrust = require('../models/StoreTrust');
const StoreView = require('../models/StoreView');
const Notification = require('../models/Notification');
const NotificationOutbox = require('../models/NotificationOutbox');
const ChatHistory = require('../models/ChatHistory');
const Cart = require('../models/Cart');
const OTP = require('../models/OTP');
const WhatsAppOTP = require('../models/WhatsAppOTP');
const WhatsAppOTPRateEvent = require('../models/WhatsAppOTPRateEvent');
const WhatsAppAIChatRateLimit = require('../models/WhatsAppAIChatRateLimit');
const AIRateLimit = require('../models/AIRateLimit');
const AIChatDailyUsage = require('../models/AIChatDailyUsage');
const AIActionReceipt = require('../models/AIActionReceipt');
const WhatsAppJidMapping = require('../models/WhatsAppJidMapping');
const AdminWhatsAppNumber = require('../models/AdminWhatsAppNumber');
const ExpoPushTokenRegistration = require('../models/ExpoPushTokenRegistration');
const SubscriptionPromotion = require('../models/SubscriptionPromotion');
const WhatsAppPendingMessage = require('../models/WhatsAppPendingMessage');
const WhatsAppInboundReceipt = require('../models/WhatsAppInboundReceipt');
const UserBlock = require('../models/UserBlock');
const Complaint = require('../models/Complaint');
const { normalizePhoneDigits } = require('../utils/phoneNumber');
const { teardownAccountBilling } = require('./accountBillingTeardownService');

class AccountDeletionError extends Error {
    constructor(phase, failures) {
        super(`Account deletion failed during ${phase}`);
        this.name = 'AccountDeletionError';
        this.code = 'ACCOUNT_DELETION_PARTIAL_FAILURE';
        this.phase = phase;
        this.failures = failures.map(({ name, reason }) => ({
            name,
            message: reason?.message || String(reason),
        }));
    }
}

const runPhase = async (phase, operations) => {
    const entries = Object.entries(operations);
    const results = await Promise.allSettled(entries.map(([, operation]) => operation()));
    const failures = results
        .map((result, index) => ({ ...result, name: entries[index][0] }))
        .filter(result => result.status === 'rejected');
    if (failures.length) throw new AccountDeletionError(phase, failures);
};

const uniquePhones = (user) => [...new Set([
    user?.sellerInfo?.whatsappDigits,
    user?.sellerInfo?.whatsappNumber,
    user?.sellerInfo?.phoneNumber,
    user?.whatsappInfo?.number,
].map(normalizePhoneDigits).filter(Boolean))];

/**
 * Removes account-owned marketplace and operational state while intentionally
 * retaining immutable commerce/financial evidence (orders, returns, wallets,
 * ledger transactions, settlements and withdrawal records).
 *
 * Every operation is idempotent and the User document is removed last. If a
 * phase partially fails, a retry can safely finish the same deletion.
 */
async function deleteAccountCascade(userId, { allowAdminDeletion = false } = {}) {
    const user = await User.findById(userId)
        .select('role email sellerInfo whatsappInfo +stripeCustomers')
        .lean();
    if (!user) {
        return { found: false, deleted: false, alreadyDeleted: true };
    }
    if (user.role === 'admin' && !allowAdminDeletion) {
        const error = new Error('Administrator accounts cannot be deleted through this action.');
        error.code = 'ADMIN_ACCOUNT_DELETE_FORBIDDEN';
        throw error;
    }

    const now = new Date();
    const sellerId = user._id;
    const [stores, subscription] = await Promise.all([
        Store.find({ seller: sellerId }).select('_id').lean(),
        SellerSubscription.findOne({ seller: sellerId })
            .select('stripeCustomerId stripeSubscriptionId')
            .lean(),
    ]);
    const storeIds = stores.map(store => store._id);
    const phones = uniquePhones(user);

    // Hide first so a partial cleanup can never leave seller inventory visible.
    await runPhase('marketplace-hide', {
        stores: () => Store.updateMany(
            { seller: sellerId },
            { $set: { isActive: false, blockedAt: now } }
        ),
        products: () => Product.updateMany(
            { seller: sellerId },
            {
                $set: {
                    isBlocked: true,
                    blockedAt: now,
                    blockedReason: 'Seller account removed',
                    moderationStatus: 'blocked',
                    moderationReason: 'Seller account removed',
                    moderationReviewedAt: now,
                    isFeatured: false,
                },
            }
        ),
    });

    // Stop external recurring billing before erasing the local IDs needed to
    // find it. Stripe resource-missing/already-cancelled responses are treated
    // as idempotent success; real gateway failures keep the account retryable.
    await runPhase('external-billing-teardown', {
        stripe: () => teardownAccountBilling({
            subscription,
            stripeCustomers: user.stripeCustomers,
        }),
    });

    await runPhase('operational-cleanup', {
        sellerAds: () => SellerAdRequest.deleteMany({ seller: sellerId }),
        coupons: () => Coupon.deleteMany({ seller: sellerId }),
        shippingMethods: () => ShippingMethod.deleteMany({ seller: sellerId }),
        subscription: () => SellerSubscription.deleteMany({ seller: sellerId }),
        paymentAccount: () => SellerPaymentAccount.deleteMany({ seller: sellerId }),
        checkoutClaims: () => SellerCheckoutClaim.deleteMany({ seller: sellerId }),
        settlementLocks: () => SellerSettlementLock.deleteMany({ seller: sellerId }),
        notificationLogs: () => SellerNotificationLog.deleteMany({ seller: sellerId }),
        notifications: () => Notification.deleteMany({ user: sellerId }),
        notificationOutbox: () => NotificationOutbox.deleteMany({ 'recipient.user': sellerId }),
        chatHistory: () => ChatHistory.deleteMany({ user: sellerId }),
        cart: () => Cart.deleteMany({ user: sellerId }),
        emailOtps: () => OTP.deleteMany({
            $or: [
                { 'userData.sellerId': sellerId },
                ...(user.email ? [{ email: String(user.email).toLowerCase() }] : []),
            ],
        }),
        whatsappOtps: () => WhatsAppOTP.deleteMany({
            $or: [
                { sellerId },
                ...(phones.length ? [{ number: { $in: phones } }] : []),
            ],
        }),
        whatsappOtpRateEvents: () => WhatsAppOTPRateEvent.deleteMany({
            $or: [
                { sellerId },
                ...(phones.length ? [{ number: { $in: phones } }] : []),
            ],
        }),
        whatsappAiRateLimits: () => WhatsAppAIChatRateLimit.deleteMany({
            $or: [
                { user: sellerId },
                ...(phones.length ? [{ phone: { $in: phones } }] : []),
            ],
        }),
        aiRateLimits: () => AIRateLimit.deleteMany({ userId: sellerId }),
        aiChatDailyUsage: () => AIChatDailyUsage.deleteMany({ userId: sellerId }),
        aiActionReceipts: () => AIActionReceipt.deleteMany({ user: sellerId }),
        pendingWhatsappMessages: () => WhatsAppPendingMessage.deleteMany(
            phones.length ? { phone: { $in: phones } } : { _id: { $exists: false } }
        ),
        inboundWhatsappReceipts: () => WhatsAppInboundReceipt.deleteMany(
            phones.length ? { phone: { $in: phones } } : { _id: { $exists: false } }
        ),
        jidMappings: () => WhatsAppJidMapping.deleteMany(
            phones.length ? { phone: { $in: phones } } : { _id: { $exists: false } }
        ),
        adminNumbers: () => AdminWhatsAppNumber.deleteMany({
            $or: [
                { addedBy: sellerId },
                ...(phones.length ? [{ number: { $in: phones } }] : []),
            ],
        }),
        pushTokens: () => User.updateOne(
            { _id: sellerId },
            { $set: { expoPushTokens: [] } }
        ),
        pushTokenRegistrations: () => ExpoPushTokenRegistration.deleteMany({ user: sellerId }),
        userBlocks: () => UserBlock.deleteMany({
            $or: [{ blocker: sellerId }, { blocked: sellerId }],
        }),
        safetyReportsByAccount: () => Complaint.updateMany(
            { user: sellerId },
            { $set: { user: null, 'report.reporterType': 'anonymous' } },
        ),
        safetyReportsAboutAccount: () => Complaint.updateMany(
            { 'report.targetUser': sellerId },
            { $set: { 'report.targetUser': null } },
        ),
        promotionReservations: () => SubscriptionPromotion.updateMany(
            { 'reservations.seller': sellerId },
            { $pull: { reservations: { seller: sellerId } } }
        ),
    });

    await runPhase('marketplace-cleanup', {
        storeReviews: () => StoreReview.deleteMany({
            $or: [
                { user: sellerId },
                ...(storeIds.length ? [{ store: { $in: storeIds } }] : []),
            ],
        }),
        storeReviewHelpfulVotes: () => StoreReview.updateMany(
            { helpfulBy: sellerId },
            { $pull: { helpfulBy: sellerId } }
        ),
        storeTrust: () => StoreTrust.deleteMany({
            $or: [
                { user: sellerId },
                ...(storeIds.length ? [{ store: { $in: storeIds } }] : []),
            ],
        }),
        storeViews: () => StoreView.deleteMany(
            storeIds.length ? { store: { $in: storeIds } } : { _id: { $exists: false } }
        ),
        reviewsOnOtherProducts: () => Product.updateMany(
            { seller: { $ne: sellerId }, 'reviews.user': sellerId },
            { $pull: { reviews: { user: sellerId } } }
        ),
        products: () => Product.deleteMany({ seller: sellerId }),
        stores: () => Store.deleteMany({ seller: sellerId }),
    });

    const result = await User.deleteOne({ _id: sellerId });
    if (!result.deletedCount) {
        throw new AccountDeletionError('account-delete', [{
            name: 'user',
            reason: new Error('User disappeared before deletion completed'),
        }]);
    }

    return {
        found: true,
        deleted: true,
        alreadyDeleted: false,
        preserved: [
            'orders',
            'return requests',
            'wallets',
            'wallet transactions',
            'seller balance transactions',
            'withdrawal requests',
        ],
    };
}

module.exports = {
    AccountDeletionError,
    deleteAccountCascade,
    runPhase,
};
