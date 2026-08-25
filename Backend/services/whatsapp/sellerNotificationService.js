const WhatsAppConfig = require('../../models/WhatsAppConfig');
const User = require('../../models/User');
const SellerNotificationLog = require('../../models/SellerNotificationLog');
const sellerEvolution = require('./sellerEvolutionClient');
const { resolveOutboundRecipient } = require('./jidRoutingStore');

/**
 * Notification categories and whether they can be disabled by the seller.
 * 'critical' category notifications are ALWAYS sent, regardless of preferences.
 */
const NOTIFICATION_CATEGORIES = {
    new_order:              { prefKey: 'newOrders',           critical: false },
    order_update:           { prefKey: 'orderUpdates',        critical: false },
    return_request:         { prefKey: 'orderUpdates',        critical: false },
    return_update:          { prefKey: 'orderUpdates',        critical: false },
    subscription_activated: { prefKey: 'subscriptionAlerts',  critical: false },
    subdomain_payment:      { prefKey: 'subscriptionAlerts',  critical: false },
    subscription_ending:    { prefKey: 'subscriptionAlerts',  critical: false },
    payment_failed:         { prefKey: null,                  critical: true  }, // CRITICAL
    payment_recovered:      { prefKey: 'subscriptionAlerts',  critical: false },
    payment_risk:           { prefKey: null,                  critical: true  },
    plan_change_action_required: { prefKey: null,              critical: true  },
    trial_expiring:         { prefKey: null,                  critical: true  }, // CRITICAL
    account_blocked:        { prefKey: null,                  critical: true  }, // CRITICAL
    product_blocked:        { prefKey: null,                  critical: true  }, // CRITICAL
    seller_welcome:         { prefKey: null,                  critical: true  }, // CRITICAL
    payout_account_updated: { prefKey: null,                  critical: true  }, // SECURITY-SENSITIVE
    withdrawal_update:      { prefKey: null,                  critical: false },
    bonus_expiring:         { prefKey: 'bonusAlerts',         critical: false },
    bonus_expired:          { prefKey: 'bonusAlerts',         critical: false },
    store_verified:         { prefKey: 'storeAlerts',         critical: false },
    store_created:          { prefKey: 'storeAlerts',         critical: false },
    store_verification_approved: { prefKey: 'storeAlerts',    critical: false },
    store_verification_rejected: { prefKey: 'storeAlerts',    critical: false },
    store_verification_removed: { prefKey: 'storeAlerts',     critical: false },
    store_review:           { prefKey: 'storeAlerts',         critical: false },
    downgrade_scheduled:    { prefKey: 'subscriptionAlerts',  critical: false },
    upgrade_completed:      { prefKey: 'subscriptionAlerts',  critical: false },
};

// ── Rate limiting & throttling ──────────────────────────────────────────────
// WhatsApp aggressively bans numbers that spam. We protect the seller instance
// by enforcing:
//   1. An hourly cap (default 60 msgs/hr, tracked on WhatsAppConfig singleton).
//   2. A sequential in-process queue so parallel order/webhook storms don't hit
//      WhatsApp all at once. There is no artificial send delay.
//
// This sender is a simpler cousin of services/whatsapp/queue.js. Transactional
// seller events are persisted by NotificationOutbox before reaching this
// process-local serialization step; direct legacy callers do not gain that
// durability merely by calling this service.

const configuredHourlyCap = Number(process.env.SELLER_WA_HOURLY_CAP || 60);
const HOURLY_CAP = Number.isSafeInteger(configuredHourlyCap)
    && configuredHourlyCap >= 1
    && configuredHourlyCap <= 10_000
    ? configuredHourlyCap
    : 60;

let chain = Promise.resolve(); // serial queue

/**
 * Atomically increment sentInLastHour on the seller singleton and return
 * whether the cap has been reached. Resets the counter if the hour window
 * has rolled over.
 */
async function tryReserveHourlySlot() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Reserve the first slot while rolling an expired window in one atomic
    // write. If another replica wins that reset, this query no longer matches
    // and the loser proceeds to the current-window reservation below.
    const resetReservation = await WhatsAppConfig.findOneAndUpdate({
        singletonKey: 'seller',
        $or: [
            { sentWindowStartedAt: null },
            { sentWindowStartedAt: { $lt: oneHourAgo } },
        ],
    }, {
        $set: {
            sentWindowStartedAt: now,
            sentInLastHour: 1,
            lastSeen: now,
        },
    }, { new: true });
    if (resetReservation) return { allowed: true };

    // `$expr` handles a legacy missing counter as zero. The update pipeline
    // then increments that normalized value atomically across all replicas.
    const currentReservation = await WhatsAppConfig.findOneAndUpdate({
        singletonKey: 'seller',
        sentWindowStartedAt: { $gte: oneHourAgo },
        $expr: {
            $lt: [{ $ifNull: ['$sentInLastHour', 0] }, HOURLY_CAP],
        },
    }, [{
        $set: {
            sentInLastHour: { $add: [{ $ifNull: ['$sentInLastHour', 0] }, 1] },
            lastSeen: now,
        },
    }], { new: true });
    if (currentReservation) return { allowed: true };

    const configured = await WhatsAppConfig.exists({ singletonKey: 'seller' });
    return configured
        ? { allowed: false, reason: 'hourly_cap_reached' }
        : { allowed: false, reason: 'no_seller_config' };
}

/**
 * Core: check gating, reserve quota, send, with full error handling.
 */
async function sendNow(sellerId, category, message) {
    // 1. Seller instance connected?
    const cfg = await WhatsAppConfig.findOne({ singletonKey: 'seller' });
    if (!cfg || cfg.status !== 'connected') {
        await logNotification(sellerId, category, message, 'skipped', 'seller_instance_not_connected');
        return { sent: false, reason: 'seller_instance_not_connected' };
    }

    // 2. Seller exists and is verified?
    const seller = await User.findById(sellerId).select('sellerInfo whatsappNotificationPrefs');
    if (!seller) {
        await logNotification(sellerId, category, message, 'skipped', 'seller_not_found');
        return { sent: false, reason: 'seller_not_found' };
    }

    const whatsappNumber = seller.sellerInfo?.whatsappNumber;
    const whatsappVerified = seller.sellerInfo?.whatsappVerified;
    if (!whatsappNumber || !whatsappVerified) {
        await logNotification(sellerId, category, message, 'skipped', 'whatsapp_not_verified');
        return { sent: false, reason: 'whatsapp_not_verified' };
    }

    // 3. Category & preferences check
    const catConfig = NOTIFICATION_CATEGORIES[category];
    if (!catConfig) {
        console.warn(`[sellerNotification] Unknown category: ${category}`);
        await logNotification(sellerId, category, message, 'skipped', 'unknown_category');
        return { sent: false, reason: 'unknown_category' };
    }
    if (!catConfig.critical) {
        const prefs = seller.whatsappNotificationPrefs || {};
        if (prefs.enabled === false) {
            await logNotification(sellerId, category, message, 'skipped', 'notifications_disabled');
            return { sent: false, reason: 'notifications_disabled' };
        }
        if (catConfig.prefKey && prefs[catConfig.prefKey] === false) {
            await logNotification(sellerId, category, message, 'skipped', `category_disabled:${catConfig.prefKey}`);
            return { sent: false, reason: `category_disabled:${catConfig.prefKey}` };
        }
    }

    // 4. Normalize phone
    const digits = whatsappNumber.replace(/\D/g, '');
    if (!digits) {
        await logNotification(sellerId, category, message, 'failed', 'invalid_number');
        return { sent: false, reason: 'invalid_number' };
    }

    // 5. Hourly cap (reserve slot before sending; if send fails we accept the
    //    small over-count — much better than racing the cap)
    const slot = await tryReserveHourlySlot();
    if (!slot.allowed) {
        console.warn(`[sellerNotification] ${slot.reason} — skipping ${category} to ${sellerId}`);
        await logNotification(sellerId, category, message, 'skipped', slot.reason);
        return { sent: false, reason: slot.reason };
    }

    // 6. Send
    try {
        const recipient = await resolveOutboundRecipient(digits, digits, { instanceType: 'seller' });
        const providerResult = await sellerEvolution.sendText(recipient, message);
        await logNotification(sellerId, category, message, 'sent', '', '', seller.sellerInfo, digits);
        return { sent: true, messageId: String(providerResult?.messageId || '') };
    } catch (err) {
        console.error(`[sellerNotification] sendText failed for ${category} to ${sellerId}:`, err.message);
        await logNotification(sellerId, category, message, 'failed', 'send_error', err.message, seller.sellerInfo, digits);
        return { sent: false, reason: 'send_error', error: err.message };
    }
}

/**
 * Log a notification attempt for admin visibility.
 */
async function logNotification(sellerId, category, message, status, reason, error, sellerInfo, phone) {
    try {
        const p = phone || '';
        const maskedPhone = p.length > 6 ? `${p.slice(0, 3)}••••${p.slice(-3)}` : p;
        await SellerNotificationLog.create({
            seller: sellerId,
            sellerName: sellerInfo?.shopName || sellerInfo?.storeName || '',
            phone: maskedPhone,
            category,
            message: message?.slice(0, 500) || '',
            status,
            reason: reason || '',
            error: error || '',
        });
    } catch (err) {
        // Non-critical — don't break the notification flow
        console.error('[sellerNotification] logNotification error:', err.message);
    }
}

/**
 * Send a WhatsApp notification to a seller. Queued serially so parallel callers
 * (e.g. multi-seller order, webhook storm) don't hammer WhatsApp all at once.
 *
 * @param {string|ObjectId} sellerId - The User._id of the seller
 * @param {string} category - One of NOTIFICATION_CATEGORIES keys
 * @param {string} message - WhatsApp message text (supports *bold* _italic_)
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
function notifySeller(sellerId, category, message) {
    const sellerIdStr = sellerId?.toString?.() || String(sellerId || '');
    if (!sellerIdStr) return Promise.resolve({ sent: false, reason: 'missing_seller_id' });

    // Chain on the serial queue so we send one-at-a-time without artificial delay.
    const task = chain.then(async () => {
        try {
            const result = await sendNow(sellerIdStr, category, message);
            return result;
        } catch (err) {
            console.error(`[sellerNotification] Unexpected error in queue for ${category}:`, err.message);
            return { sent: false, reason: 'queue_error', error: err.message };
        }
    });

    // Swallow errors from the chain so one failure doesn't break the queue
    chain = task.catch(() => null);
    return task;
}

/**
 * Helper: Check if seller WhatsApp notifications are available for a given seller.
 */
async function isSellerWhatsAppAvailable(sellerId) {
    try {
        const cfg = await WhatsAppConfig.findOne({ singletonKey: 'seller' });
        if (!cfg || cfg.status !== 'connected') return false;

        const seller = await User.findById(sellerId);
        return !!(seller?.sellerInfo?.whatsappNumber && seller?.sellerInfo?.whatsappVerified);
    } catch {
        return false;
    }
}

module.exports = {
    notifySeller,
    isSellerWhatsAppAvailable,
    NOTIFICATION_CATEGORIES,
    _tryReserveHourlySlot: tryReserveHourlySlot,
};
