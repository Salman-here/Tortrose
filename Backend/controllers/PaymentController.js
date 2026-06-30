const Product = require('../models/Product');
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const Notification = require('../models/Notification');
const SellerPaymentAccount = require('../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../models/SellerWithdrawalRequest');
const { normalizeCurrency, convertToUSD, formatMoneySync } = require('../services/currencyService');
const { notifySeller } = require('../services/whatsapp/sellerNotificationService');

const ACTIVE_WITHDRAWAL_STATUSES = ['pending', 'approved', 'processing', 'paid'];
const CURRENCY_CODES = ['USD', 'PKR', 'EUR', 'GBP'];

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const isDelivered = (order) => order?.orderStatus === 'delivered' || order?.isDelivered === true;
const isLiveOrder = (order) => order?.awaitingPayment !== true && order?.orderStatus !== 'cancelled';
const isSupportedCurrency = (currency) => CURRENCY_CODES.includes(String(currency || '').trim().toUpperCase());

const getOrderCurrency = (order) => {
    const explicitCurrency = String(order?.currency || '').trim().toUpperCase();
    if (isSupportedCurrency(explicitCurrency)) return explicitCurrency;

    const itemCurrencies = new Set(
        (order?.orderItems || [])
            .map((item) => item?.currency || item?.orderCurrency || item?.priceCurrency || item?.sourceCurrency)
            .map((currency) => String(currency || '').trim().toUpperCase())
            .filter(isSupportedCurrency)
    );
    return itemCurrencies.size === 1 ? [...itemCurrencies][0] : 'USD';
};

const convertOrderRevenueToUSD = async (amount, order) =>
    roundMoney(await convertToUSD(roundMoney(amount), getOrderCurrency(order)));

const last4 = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const compact = raw.replace(/\s+/g, '');
    return compact.slice(-4);
};

const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);

const maskFromLast4 = (suffix) => suffix ? `**** ${suffix}` : '';

const serializePaymentAccount = (account, { includeSensitive = false } = {}) => {
    if (!account) return null;
    const doc = account.toObject ? account.toObject() : account;
    const base = {
        _id: doc._id,
        accountHolderName: doc.accountHolderName || '',
        bankName: doc.bankName || '',
        accountNumberLast4: doc.accountNumberLast4 || '',
        ibanLast4: doc.ibanLast4 || '',
        maskedAccountNumber: maskFromLast4(doc.accountNumberLast4),
        maskedIban: maskFromLast4(doc.ibanLast4),
        swiftCode: doc.swiftCode || '',
        country: doc.country || '',
        currency: normalizeCurrency(doc.currency || 'USD'),
        payoutInstructions: doc.payoutInstructions || '',
        isActive: doc.isActive !== false,
        updatedAt: doc.updatedAt,
    };
    if (includeSensitive) {
        base.accountNumber = doc.accountNumber || '';
        base.iban = doc.iban || '';
    }
    return base;
};

const sellerRevenueForOrder = (order, sellerId, sellerProductIdSet) => {
    const sellerItems = (order.orderItems || []).filter((item) =>
        sellerProductIdSet.has(toId(item.productId))
    );
    if (!sellerItems.length) {
        return { itemCount: 0, units: 0, subtotal: 0, shipping: 0, tax: 0, discount: 0, total: 0 };
    }

    const subtotal = sellerItems.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
    const orderSubtotal = Number(order.orderSummary?.subtotal) ||
        (order.orderItems || []).reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
    const sellerShare = orderSubtotal > 0 ? subtotal / orderSubtotal : 0;
    const shipping = Number((order.sellerShipping || []).find((entry) => toId(entry.seller) === toId(sellerId))?.shippingMethod?.price) ||
        (toId(order.shippingMethod?.seller) === toId(sellerId) ? Number(order.shippingMethod?.price) || 0 : 0);
    const tax = (Number(order.orderSummary?.tax) || 0) * sellerShare;
    const discount = (Number(order.orderSummary?.couponDiscount) || 0) * sellerShare;
    const total = Math.max(0, subtotal + shipping + tax - discount);

    return {
        itemCount: sellerItems.length,
        units: sellerItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
        subtotal: roundMoney(subtotal),
        shipping: roundMoney(shipping),
        tax: roundMoney(tax),
        discount: roundMoney(discount),
        total: roundMoney(total),
    };
};

const emptyRevenueSummary = () => ({
    stripeDeliveredRevenue: 0,
    stripePendingRevenue: 0,
    codDeliveredRevenue: 0,
    codPendingRevenue: 0,
    totalDeliveredRevenue: 0,
    estimatedRevenue: 0,
    withdrawableBalance: 0,
    pendingWithdrawalAmount: 0,
    approvedWithdrawalAmount: 0,
    processingWithdrawalAmount: 0,
    totalWithdrawn: 0,
    totalReservedOrWithdrawn: 0,
    deliveredStripeOrders: 0,
    pendingStripeOrders: 0,
    deliveredCodOrders: 0,
    pendingCodOrders: 0,
    totalRelevantOrders: 0,
});

const buildSellerPaymentSummary = async (sellerId) => {
    const sellerIdStr = toId(sellerId);
    const [products, paymentAccount, withdrawals] = await Promise.all([
        Product.find({ seller: sellerIdStr }).select('_id').lean(),
        SellerPaymentAccount.findOne({ seller: sellerIdStr }).lean(),
        SellerWithdrawalRequest.find({ seller: sellerIdStr }).sort({ createdAt: -1 }).lean(),
    ]);

    const productIds = products.map((product) => product._id);
    const productIdSet = new Set(productIds.map(toId));
    const revenue = emptyRevenueSummary();

    let recentStripeOrders = [];
    let recentCodOrders = [];

    if (productIds.length) {
        const orders = await Order.find({
            awaitingPayment: { $ne: true },
            orderStatus: { $ne: 'cancelled' },
            'orderItems.productId': { $in: productIds },
        })
            .select('orderId orderItems sellerShipping shippingMethod orderSummary paymentMethod isPaid paidAt orderStatus isDelivered deliveredAt createdAt currency')
            .sort({ createdAt: -1 })
            .lean();

        revenue.totalRelevantOrders = orders.length;

        for (const order of orders) {
            if (!isLiveOrder(order)) continue;
            const sellerRevenue = sellerRevenueForOrder(order, sellerIdStr, productIdSet);
            if (sellerRevenue.total <= 0) continue;

            const sourceCurrency = getOrderCurrency(order);
            const sellerRevenueUSD = await convertOrderRevenueToUSD(sellerRevenue.total, order);
            if (sellerRevenueUSD <= 0) continue;

            const delivered = isDelivered(order);
            const paymentMethod = order.paymentMethod || 'cash_on_delivery';

            if (paymentMethod === 'stripe' && order.isPaid) {
                if (delivered) {
                    revenue.stripeDeliveredRevenue += sellerRevenueUSD;
                    revenue.deliveredStripeOrders += 1;
                } else {
                    revenue.stripePendingRevenue += sellerRevenueUSD;
                    revenue.pendingStripeOrders += 1;
                }
                if (recentStripeOrders.length < 5) {
                    recentStripeOrders.push({
                        _id: order._id,
                        orderId: order.orderId,
                        status: order.orderStatus,
                        amount: sellerRevenueUSD,
                        amountCurrency: 'USD',
                        sourceAmount: sellerRevenue.total,
                        sourceCurrency,
                        delivered,
                        createdAt: order.createdAt,
                    });
                }
                continue;
            }

            if (paymentMethod === 'cash_on_delivery') {
                if (delivered) {
                    revenue.codDeliveredRevenue += sellerRevenueUSD;
                    revenue.deliveredCodOrders += 1;
                } else {
                    revenue.codPendingRevenue += sellerRevenueUSD;
                    revenue.pendingCodOrders += 1;
                }
                if (recentCodOrders.length < 5) {
                    recentCodOrders.push({
                        _id: order._id,
                        orderId: order.orderId,
                        status: order.orderStatus,
                        amount: sellerRevenueUSD,
                        amountCurrency: 'USD',
                        sourceAmount: sellerRevenue.total,
                        sourceCurrency,
                        delivered,
                        createdAt: order.createdAt,
                    });
                }
            }
        }
    }

    const withdrawalTotals = {
        pending: 0,
        approved: 0,
        processing: 0,
        paid: 0,
        rejected: 0,
        cancelled: 0,
    };

    for (const request of withdrawals) {
        const status = request.status || 'pending';
        if (withdrawalTotals[status] === undefined) withdrawalTotals[status] = 0;
        withdrawalTotals[status] += Number(request.amount) || 0;
    }

    revenue.stripeDeliveredRevenue = roundMoney(revenue.stripeDeliveredRevenue);
    revenue.stripePendingRevenue = roundMoney(revenue.stripePendingRevenue);
    revenue.codDeliveredRevenue = roundMoney(revenue.codDeliveredRevenue);
    revenue.codPendingRevenue = roundMoney(revenue.codPendingRevenue);
    revenue.pendingWithdrawalAmount = roundMoney(withdrawalTotals.pending);
    revenue.approvedWithdrawalAmount = roundMoney(withdrawalTotals.approved);
    revenue.processingWithdrawalAmount = roundMoney(withdrawalTotals.processing);
    revenue.totalWithdrawn = roundMoney(withdrawalTotals.paid);
    revenue.totalReservedOrWithdrawn = roundMoney(ACTIVE_WITHDRAWAL_STATUSES.reduce((sum, status) => sum + (withdrawalTotals[status] || 0), 0));
    revenue.totalDeliveredRevenue = roundMoney(revenue.stripeDeliveredRevenue + revenue.codDeliveredRevenue);
    revenue.estimatedRevenue = roundMoney(revenue.totalDeliveredRevenue + revenue.stripePendingRevenue + revenue.codPendingRevenue);
    revenue.withdrawableBalance = roundMoney(Math.max(0, revenue.stripeDeliveredRevenue - revenue.totalReservedOrWithdrawn));

    return {
        revenue,
        paymentAccount: serializePaymentAccount(paymentAccount),
        withdrawals,
        recentStripeOrders,
        recentCodOrders,
    };
};

const createInAppNotification = (user, title, body, linkTo, category = 'seller') =>
    Notification.create({
        user,
        title,
        body,
        category,
        linkTo,
        source: 'system',
    }).catch((err) => console.error('[payments] notification failed:', err.message));

const notifyAdmins = async (title, body, linkTo) => {
    const admins = await User.find({ role: 'admin' }).select('_id').lean();
    if (!admins.length) return;
    await Notification.insertMany(
        admins.map((admin) => ({
            user: admin._id,
            title,
            body,
            category: 'system',
            linkTo,
            source: 'system',
        })),
        { ordered: false }
    ).catch((err) => console.error('[payments] admin notification failed:', err.message));
};

exports.buildSellerPaymentSummary = buildSellerPaymentSummary;

exports.getSellerPaymentSummary = async (req, res) => {
    try {
        if (req.user?.role !== 'seller' && req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.role === 'admin' && req.query.sellerId ? req.query.sellerId : req.user.id;
        const summary = await buildSellerPaymentSummary(sellerId);

        return res.status(200).json({
            success: true,
            ...summary,
        });
    } catch (error) {
        console.error('[payments] seller summary error:', error);
        return res.status(500).json({ msg: 'Failed to fetch payment summary' });
    }
};

exports.upsertSellerPaymentAccount = async (req, res) => {
    try {
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.id;
        const {
            accountHolderName,
            bankName,
            accountNumber,
            iban,
            swiftCode,
            country,
            currency,
            payoutInstructions,
        } = req.body || {};

        const existing = await SellerPaymentAccount.findOne({ seller: sellerId }).select('+accountNumber +iban');
        const cleanAccountNumber = cleanText(accountNumber, 80);
        const cleanIban = cleanText(iban, 80);

        if (!cleanText(accountHolderName, 120)) {
            return res.status(400).json({ msg: 'Account holder name is required' });
        }
        if (!cleanText(bankName, 120)) {
            return res.status(400).json({ msg: 'Bank name is required' });
        }
        if (!cleanAccountNumber && !cleanIban && !existing?.accountNumber && !existing?.iban) {
            return res.status(400).json({ msg: 'Please enter a bank account number or IBAN' });
        }

        const update = {
            seller: sellerId,
            accountHolderName: cleanText(accountHolderName, 120),
            bankName: cleanText(bankName, 120),
            swiftCode: cleanText(swiftCode, 20).toUpperCase(),
            country: cleanText(country, 80),
            currency: CURRENCY_CODES.includes(String(currency || '').toUpperCase())
                ? String(currency).toUpperCase()
                : normalizeCurrency(req.user.currency || 'USD'),
            payoutInstructions: cleanText(payoutInstructions, 500),
            isActive: true,
            updatedBy: sellerId,
        };

        if (cleanAccountNumber) {
            update.accountNumber = cleanAccountNumber;
            update.accountNumberLast4 = last4(cleanAccountNumber);
        } else if (existing?.accountNumber) {
            update.accountNumberLast4 = last4(existing.accountNumber);
        }

        if (cleanIban) {
            update.iban = cleanIban;
            update.ibanLast4 = last4(cleanIban);
        } else if (existing?.iban) {
            update.ibanLast4 = last4(existing.iban);
        }

        const account = await SellerPaymentAccount.findOneAndUpdate(
            { seller: sellerId },
            { $set: update },
            { new: true, upsert: true, runValidators: true }
        );

        await createInAppNotification(
            sellerId,
            'Payment account updated',
            'Your payout bank details were saved successfully.',
            '/seller-dashboard/payments',
            'seller'
        );

        return res.status(200).json({
            success: true,
            msg: 'Payment account saved',
            paymentAccount: serializePaymentAccount(account),
        });
    } catch (error) {
        console.error('[payments] account save error:', error);
        return res.status(500).json({ msg: 'Failed to save payment account' });
    }
};

exports.createWithdrawalRequest = async (req, res) => {
    try {
        if (req.user?.role !== 'seller') {
            return res.status(403).json({ msg: 'Seller access required' });
        }

        const sellerId = req.user.id;
        const requestedCurrency = normalizeCurrency(req.body?.requestedCurrency || req.body?.currency || req.user.currency || 'USD');
        const requestedAmount = Number(req.body?.requestedAmount ?? req.body?.amount);
        const amount = req.body?.amountUSD != null
            ? roundMoney(req.body.amountUSD)
            : roundMoney(await convertToUSD(req.body?.amount, requestedCurrency));

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ msg: 'Withdrawal amount must be greater than zero' });
        }

        const account = await SellerPaymentAccount.findOne({ seller: sellerId, isActive: true }).lean();
        if (!account) {
            return res.status(400).json({ msg: 'Add your bank account before requesting a withdrawal' });
        }

        const summary = await buildSellerPaymentSummary(sellerId);
        if (amount > summary.revenue.withdrawableBalance) {
            return res.status(400).json({
                msg: `You can withdraw up to ${formatMoneySync(summary.revenue.withdrawableBalance, requestedCurrency)} right now.`,
                availableBalance: summary.revenue.withdrawableBalance,
            });
        }

        const request = await SellerWithdrawalRequest.create({
            seller: sellerId,
            amount,
            currency: 'USD',
            requestedAmount: Number.isFinite(requestedAmount) ? roundMoney(requestedAmount) : amount,
            requestedCurrency,
            sellerNote: cleanText(req.body?.sellerNote, 500),
            paymentAccountSnapshot: {
                accountHolderName: account.accountHolderName || '',
                bankName: account.bankName || '',
                accountNumberLast4: account.accountNumberLast4 || '',
                ibanLast4: account.ibanLast4 || '',
                swiftCode: account.swiftCode || '',
                country: account.country || '',
                currency: normalizeCurrency(account.currency || 'USD'),
            },
        });

        const formatted = formatMoneySync(amount, requestedCurrency);
        await createInAppNotification(
            sellerId,
            'Withdrawal request sent',
            `Your withdrawal request for ${formatted} is now pending admin review.`,
            '/seller-dashboard/payments',
            'seller'
        );
        await notifyAdmins(
            'New seller withdrawal request',
            `${req.user.username || 'A seller'} requested ${formatted}.`,
            '/admin-dashboard/payments'
        );
        notifySeller(
            sellerId,
            'withdrawal_update',
            `Withdrawal request received\n\nAmount: ${formatted}\nStatus: Pending admin review\n\nYou can track it in Seller Dashboard > Payments.`
        ).catch(() => {});

        return res.status(201).json({
            success: true,
            msg: 'Withdrawal request submitted',
            withdrawal: request,
        });
    } catch (error) {
        console.error('[payments] withdrawal create error:', error);
        return res.status(500).json({ msg: 'Failed to create withdrawal request' });
    }
};

exports.getSellerWithdrawals = async (req, res) => {
    try {
        if (req.user?.role !== 'seller' && req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Seller access required' });
        }
        const sellerId = req.user.role === 'admin' && req.query.sellerId ? req.query.sellerId : req.user.id;
        const withdrawals = await SellerWithdrawalRequest.find({ seller: sellerId }).sort({ createdAt: -1 }).lean();
        return res.status(200).json({ success: true, withdrawals });
    } catch (error) {
        console.error('[payments] withdrawal list error:', error);
        return res.status(500).json({ msg: 'Failed to fetch withdrawals' });
    }
};

exports.getAdminPaymentsOverview = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        const sellers = await User.find({ role: 'seller' }).select('_id username email currency sellerInfo createdAt').lean();
        const stores = await Store.find({ seller: { $in: sellers.map((seller) => seller._id) } })
            .select('seller storeName storeSlug verification')
            .lean();
        const storeBySeller = new Map(stores.map((store) => [toId(store.seller), store]));

        const sellerRows = [];
        const rowErrors = [];
        const totals = emptyRevenueSummary();

        for (const seller of sellers) {
            try {
                const summary = await buildSellerPaymentSummary(seller._id);
                Object.keys(totals).forEach((key) => {
                    if (typeof totals[key] === 'number') totals[key] += Number(summary.revenue[key]) || 0;
                });
                const accountWithSensitive = await SellerPaymentAccount.findOne({ seller: seller._id })
                    .select('+accountNumber +iban')
                    .lean();
                sellerRows.push({
                    seller: {
                        _id: seller._id,
                        username: seller.username,
                        email: seller.email,
                        currency: normalizeCurrency(seller.currency || 'USD'),
                    },
                    store: storeBySeller.get(toId(seller._id)) || null,
                    revenue: summary.revenue,
                    paymentAccount: serializePaymentAccount(accountWithSensitive, { includeSensitive: true }),
                });
            } catch (sellerError) {
                console.error(`[payments] admin overview seller ${seller._id} failed:`, sellerError);
                rowErrors.push({
                    sellerId: seller._id,
                    username: seller.username || '',
                    msg: sellerError.message || 'Failed to load seller payment row',
                });
                sellerRows.push({
                    seller: {
                        _id: seller._id,
                        username: seller.username,
                        email: seller.email,
                        currency: normalizeCurrency(seller.currency || 'USD'),
                    },
                    store: storeBySeller.get(toId(seller._id)) || null,
                    revenue: emptyRevenueSummary(),
                    paymentAccount: null,
                    loadError: true,
                });
            }
        }

        Object.keys(totals).forEach((key) => {
            if (typeof totals[key] === 'number') totals[key] = roundMoney(totals[key]);
        });

        const withdrawals = await SellerWithdrawalRequest.find()
            .populate('seller', 'username email currency')
            .populate('processedBy', 'username email')
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        return res.status(200).json({
            success: true,
            summary: totals,
            sellers: sellerRows,
            withdrawals,
            errors: rowErrors,
        });
    } catch (error) {
        console.error('[payments] admin overview error:', error);
        return res.status(500).json({ msg: 'Failed to fetch admin payments overview' });
    }
};

exports.updateWithdrawalRequestStatus = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        const { status, adminNote } = req.body || {};
        const validStatuses = ['pending', 'approved', 'processing', 'paid', 'rejected', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ msg: 'Invalid withdrawal status' });
        }

        const request = await SellerWithdrawalRequest.findById(req.params.id);
        if (!request) {
            return res.status(404).json({ msg: 'Withdrawal request not found' });
        }

        request.status = status;
        request.adminNote = cleanText(adminNote, 1000);
        request.processedBy = req.user.id;
        if (['paid', 'rejected', 'cancelled'].includes(status)) {
            request.processedAt = new Date();
        }
        await request.save();

        const seller = await User.findById(request.seller).select('currency').lean();
        const displayCurrency = normalizeCurrency(seller?.currency || request.requestedCurrency || 'USD');
        const amountText = formatMoneySync(request.amount, displayCurrency);
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

        await createInAppNotification(
            request.seller,
            `Withdrawal ${statusLabel}`,
            `Your withdrawal request for ${amountText} is now ${statusLabel.toLowerCase()}.${request.adminNote ? ` Note: ${request.adminNote}` : ''}`,
            '/seller-dashboard/payments',
            'seller'
        );
        notifySeller(
            request.seller,
            'withdrawal_update',
            `Withdrawal update\n\nAmount: ${amountText}\nStatus: ${statusLabel}${request.adminNote ? `\nNote: ${request.adminNote}` : ''}\n\nOpen Seller Dashboard > Payments for details.`
        ).catch(() => {});

        return res.status(200).json({
            success: true,
            msg: 'Withdrawal request updated',
            withdrawal: request,
        });
    } catch (error) {
        console.error('[payments] withdrawal update error:', error);
        return res.status(500).json({ msg: 'Failed to update withdrawal request' });
    }
};
