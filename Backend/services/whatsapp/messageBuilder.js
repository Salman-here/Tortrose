// Builds the WhatsApp message we send to the buyer to confirm an order.
//
// Flow (button/list only):
//   1. Send an interactive "native flow" message with 2 reply buttons:
//        [✅ Confirm order]   [❌ Cancel order]
//      Each button carries a stable id of the form
//        confirm_ORD-xxxxxxxxx     or     cancel_ORD-xxxxxxxxx
//      so the webhook can detect the buyer's choice unambiguously.
//
//   2. When the tap comes back, WhatsApp may deliver it as any of:
//        - buttonsResponseMessage.selectedButtonId  (older clients)
//        - interactiveResponseMessage               (v2 native flow)
//        - templateButtonReplyMessage               (template flow)
//        - listResponseMessage.singleSelectReply     (list fallback)
//      Interactive paths are handled in webhookHandler.extractDecision.
//
//   3. Text replies are intentionally not accepted as order decisions. If
//      interactive messages fail, the queue records a send failure instead of
//      falling back to a typed-reply flow.

const {
    formatOrderMoney,
    formatItemOptionsText,
    getOrderCurrency,
    orderItemLineSubtotal,
    orderItemName,
    requirePresentationMoney,
} = require('../../utils/orderPresentation');
const { toMinorUnits } = require('../moneyMath');

const presentationIntegrityError = (message) => {
    const error = new Error(message);
    error.statusCode = 409;
    error.code = 'ORDER_PRESENTATION_DATA_INVALID';
    return error;
};

const orderCurrency = (order) => {
    const storedCurrency = order?.currency;
    const currency = getOrderCurrency({ currency: storedCurrency }, null);
    if (typeof storedCurrency !== 'string' || storedCurrency !== currency) {
        throw presentationIntegrityError('The stored order currency is invalid.');
    }
    return currency;
};
const formatMoney = (n, currency) => formatOrderMoney(n, currency);

const exactMinor = (value, label) => BigInt(toMinorUnits(
    requirePresentationMoney(value, label),
));

// COD confirmations are frozen financial messages. Do not generate one from a
// partial/legacy-looking object: every displayed line and the displayed total
// must reconcile with the authoritative checkout snapshot before it reaches
// the durable WhatsApp queue.
const assertCodConfirmationMoneyIntegrity = (order) => {
    const currency = orderCurrency(order);
    if (!Array.isArray(order?.orderItems) || order.orderItems.length === 0) {
        throw presentationIntegrityError('The stored order items are invalid.');
    }
    if (!order?.orderSummary || typeof order.orderSummary !== 'object') {
        throw presentationIntegrityError('The stored order summary is invalid.');
    }

    let lineSubtotalMinor = 0n;
    for (const item of order.orderItems) {
        const quantity = item?.quantity;
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
            throw presentationIntegrityError('The stored order item quantity is invalid.');
        }
        lineSubtotalMinor += exactMinor(orderItemLineSubtotal({
            price: item.price,
            lineSubtotal: item.lineSubtotal,
            quantity,
        }), 'order item line subtotal');
    }

    const subtotalMinor = exactMinor(order.orderSummary.subtotal, 'order subtotal');
    const shippingMinor = exactMinor(order.orderSummary.shippingCost, 'order shipping');
    const taxMinor = exactMinor(order.orderSummary.tax, 'order tax');
    const discountMinor = exactMinor(order.orderSummary.couponDiscount, 'order coupon discount');
    const totalMinor = exactMinor(order.orderSummary.totalAmount, 'order total');
    if (
        lineSubtotalMinor !== subtotalMinor
        || subtotalMinor + shippingMinor + taxMinor - discountMinor !== totalMinor
    ) {
        throw presentationIntegrityError('The stored order total does not reconcile with its item and summary snapshots.');
    }
    return currency;
};

const itemStoreName = (it) =>
    it?.store?.storeName ||
    it?.productId?.store?.storeName ||
    it?.product?.store?.storeName ||
    it?.storeName ||
    '';

const buildProductLine = (it, currency) => {
    const qty = it.quantity;
    if (!Number.isSafeInteger(qty) || qty < 1) {
        const error = new Error('The stored order item quantity is invalid.');
        error.statusCode = 409;
        error.code = 'ORDER_PRESENTATION_DATA_INVALID';
        throw error;
    }
    const price = formatOrderMoney(orderItemLineSubtotal({
        price: it.price,
        lineSubtotal: it.lineSubtotal,
        quantity: qty,
    }), currency);
    const store = itemStoreName(it);
    const options = formatItemOptionsText(it);
    return `- ${orderItemName(it)}${options ? ` (${options})` : ''} x${qty} - ${price}${store ? ` _(from ${store})_` : ''}`;
};

const buildStoresLine = (order) => {
    const names = Array.from(new Set(
        (order.orderItems || []).map(itemStoreName).filter(Boolean)
    ));
    if (names.length === 0) return '';
    if (names.length === 1) return `🏬 Sold by: *${names[0]}*`;
    return `🏬 Sold by: *${names.join(', ')}*`;
};

// ──────────────────────────────────────────────────────────────────────────
// Button ids — MUST start with these prefixes. Webhook handler uses the
// prefix to classify the click, and the suffix (orderId) to double-check
// we're reacting to the right order.
// ──────────────────────────────────────────────────────────────────────────
const CONFIRM_BTN_PREFIX = 'confirm_';
const CANCEL_BTN_PREFIX  = 'cancel_';
const RECONFIRM_BTN_PREFIX = 'reconfirm_';
const KEEPCANCEL_BTN_PREFIX = 'keepcancel_';

exports.buildConfirmButtonId = (orderId) => `${CONFIRM_BTN_PREFIX}${orderId}`;
exports.buildCancelButtonId  = (orderId) => `${CANCEL_BTN_PREFIX}${orderId}`;
exports.buildReconfirmButtonId = (orderId) => `${RECONFIRM_BTN_PREFIX}${orderId}`;
exports.buildKeepCancelButtonId = (orderId) => `${KEEPCANCEL_BTN_PREFIX}${orderId}`;

exports.CONFIRM_BTN_PREFIX = CONFIRM_BTN_PREFIX;
exports.CANCEL_BTN_PREFIX  = CANCEL_BTN_PREFIX;
exports.RECONFIRM_BTN_PREFIX = RECONFIRM_BTN_PREFIX;
exports.KEEPCANCEL_BTN_PREFIX = KEEPCANCEL_BTN_PREFIX;

// ──────────────────────────────────────────────────────────────────────────
// Outgoing — interactive buttons payload (primary) + plain text body that
// sits above the buttons and provides a full fallback.
// ──────────────────────────────────────────────────────────────────────────

exports.buildOrderButtonsPayload = (order) => {
    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const itemCount = order.orderItems?.length || 0;
    const currency = assertCodConfirmationMoneyIntegrity(order);
    const total = formatMoney(order.orderSummary?.totalAmount, currency);
    const city = order.shippingInfo?.city || 'your location';

    // Build product list
    const productLines = (order.orderItems || []).map(it => buildProductLine(it, currency)).slice(0, 5);
    if (itemCount > 5) productLines.push(`  _...and ${itemCount - 5} more item${itemCount - 5 > 1 ? 's' : ''}_`);
    const storesLine = buildStoresLine(order);

    return {
        title: `Rozare — Order #${order.orderId}`,
        description: [
            `Hey ${buyerName}! 👋`,
            ``,
            `Thanks for your order with Rozare! 🎉`,
            ``,
            ...productLines,
            ``,
            ...(storesLine ? [storesLine] : []),
            `💰 Total: *${total}*`,
            `📍 Shipping to ${city}`,
            ``,
            `Please tap a button below to confirm or cancel.`,
        ].join('\n'),
        footer: `Rozare order confirmation · Tap a button to decide`,
        buttons: [
            {
                type: 'reply',
                displayText: '✅ Confirm order',
                id: exports.buildConfirmButtonId(order.orderId),
            },
            {
                type: 'reply',
                displayText: '❌ Cancel order',
                id: exports.buildCancelButtonId(order.orderId),
            },
        ],
    };
};

// ──────────────────────────────────────────────────────────────────────────
// Build a LIST-message payload for the buyer. This is the reliable path
// that actually renders on WhatsApp today — uses the legacy SINGLE_SELECT
// listType (Evolution's `sendList`, fixed in the homolog/develop build).
// ──────────────────────────────────────────────────────────────────────────
exports.buildOrderListPayload = (order) => {
    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const itemCount = order.orderItems?.length || 0;
    const currency = assertCodConfirmationMoneyIntegrity(order);
    const total = formatMoney(order.orderSummary?.totalAmount, currency);
    const city = order.shippingInfo?.city || 'your location';

    const productLines = (order.orderItems || []).map(it => buildProductLine(it, currency)).slice(0, 5);
    if (itemCount > 5) productLines.push(`  _...and ${itemCount - 5} more_`);
    const storesLine = buildStoresLine(order);

    return {
        title: `Rozare — Order #${order.orderId}`,
        description: [
            `Hey ${buyerName}! 👋`,
            ``,
            `Thanks for your order with Rozare! 🎉`,
            ``,
            ...productLines,
            ``,
            ...(storesLine ? [storesLine] : []),
            `💰 Total: *${total}*`,
            `📍 Shipping to ${city}`,
            ``,
            `Tap the button below to confirm or cancel your order.`,
        ].join('\n'),
        buttonText: 'Confirm or Cancel',
        footerText: 'Rozare order confirmation · choose an option to decide',
        sections: [{
            title: 'Your decision',
            rows: [
                {
                    title: '✅ Confirm order',
                    description: 'Start processing right away',
                    rowId: exports.buildConfirmButtonId(order.orderId),
                },
                {
                    title: '❌ Cancel order',
                    description: 'Nothing will be charged',
                    rowId: exports.buildCancelButtonId(order.orderId),
                },
            ],
        }],
    };
};

// Plain text summary retained for legacy display/tests. The live queue does
// not use this as a decision fallback.
exports.buildOrderConfirmationMessage = (order) => {
    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const itemCount = order.orderItems?.length || 0;
    const currency = assertCodConfirmationMoneyIntegrity(order);
    const total = formatMoney(order.orderSummary?.totalAmount, currency);
    const city = order.shippingInfo?.city || 'your location';

    const productLines = (order.orderItems || []).map(it => buildProductLine(it, currency)).slice(0, 5);
    if (itemCount > 5) productLines.push(`  _...and ${itemCount - 5} more_`);
    const storesLine = buildStoresLine(order);

    return [
        `Hey ${buyerName}! 👋`,
        ``,
        `Thanks for your order with Rozare! 🎉`,
        ``,
        `📦 *Order #${order.orderId}*`,
        ``,
        ...productLines,
        ``,
        ...(storesLine ? [storesLine] : []),
        `💰 Total: *${total}*`,
        `📍 Shipping to ${city}`,
        ``,
        `Please confirm your order from the WhatsApp buttons message.`,
        ``,
        `Typed replies are not accepted for order confirmation.`,
    ].join('\n');
};

// ──────────────────────────────────────────────────────────────────────────
// Incoming — classify the buyer's reply.
//
// Sources we handle (checked in this order):
//   1. Button click  → extractButtonDecision() below, called from the
//                      webhook handler with the raw Baileys message.
//                      Returns { decision: 'yes'|'no', orderId: 'ORD-xxx' }
//                      or null.
// Text replies are deliberately ignored for order decisions.
// ──────────────────────────────────────────────────────────────────────────

exports.parseConfirmReply = () => null;

// Decide action from a button id string (e.g. "confirm_ORD-123", "reconfirm_ORD-123").
// Returns 'yes' | 'no' | 'reconfirm' | 'keepcancel' | null.
exports.parseButtonId = (id) => {
    if (!id || typeof id !== 'string') return null;
    if (id.startsWith(RECONFIRM_BTN_PREFIX)) return 'reconfirm';
    if (id.startsWith(KEEPCANCEL_BTN_PREFIX))  return 'keepcancel';
    if (id.startsWith(CONFIRM_BTN_PREFIX)) return 'yes';
    if (id.startsWith(CANCEL_BTN_PREFIX))  return 'no';
    return null;
};

// ──────────────────────────────────────────────────────────────────────────
// Phone normalisation for already-authoritative internal destinations. Raw
// order input is canonicalized with country context before reaching this path.
// ──────────────────────────────────────────────────────────────────────────
exports.normalizePhone = (raw) => {
    if (!raw) return '';
    let p = String(raw).trim();
    const hadDoubleZero = /^00\d/.test(p);
    p = p.replace(/[^\d]/g, '');
    if (!p) return '';
    if (hadDoubleZero) p = p.replace(/^00/, '');
    return /^[1-9]\d{7,14}$/.test(p) ? p : '';
};

// ──────────────────────────────────────────────────────────────────────────
// Legacy (kept so any caller still referencing it won't break)
// ──────────────────────────────────────────────────────────────────────────
exports.buildOrderSummaryText = exports.buildOrderConfirmationMessage;
exports.buildPollPayload = (order) => ({
    name: `Ready to confirm? 🤔`,
    selectableCount: 1,
    values: ['✅ Yes, confirm my order!', '❌ No, cancel it'],
});

// ──────────────────────────────────────────────────────────────────────────
// Info-only message for online-paid (Stripe) orders. The buyer already
// committed by paying, so we DON'T ask them to confirm again — we just let
// them know the order is placed, list the items + stores, and thank them.
// ──────────────────────────────────────────────────────────────────────────
exports.buildOrderPlacedInfoMessage = (order) => {
    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const itemCount = order.orderItems?.length || 0;
    const currency = orderCurrency(order);
    const total = formatMoney(order.orderSummary?.totalAmount, currency);
    const city = order.shippingInfo?.city || 'your location';

    const productLines = (order.orderItems || []).map(it => buildProductLine(it, currency)).slice(0, 5);
    if (itemCount > 5) productLines.push(`  _...and ${itemCount - 5} more_`);
    const storesLine = buildStoresLine(order);

    return [
        `Hey ${buyerName}! 👋`,
        ``,
        `Your payment was successful — your order is confirmed! 🎉`,
        ``,
        `📦 *Order #${order.orderId}*`,
        ``,
        ...productLines,
        ``,
        ...(storesLine ? [storesLine] : []),
        `💰 Total paid: *${total}*`,
        `📍 Shipping to ${city}`,
        ``,
        `We'll keep you posted as your order is prepared and shipped.`,
        `Thank you for shopping with Rozare! 💜`,
    ].join('\n');
};

// ──────────────────────────────────────────────────────────────────────────
// Buyer order-status update — sent when a seller/admin moves the order to a
// new status (confirmed / processing / shipped / delivered / cancelled).
// Returns '' for statuses that should not message the buyer (e.g. pending).
// ──────────────────────────────────────────────────────────────────────────
const STATUS_UPDATE_LINES = {
    confirmed: {
        headline: `Your order has been confirmed! ✅`,
        detail: `The seller has accepted your order and will start preparing it soon.`,
    },
    processing: {
        headline: `Your order is being prepared! 📦`,
        detail: `The seller is packing your items now — shipping is next.`,
    },
    shipped: {
        headline: `Your order is on the way! 🚚`,
        detail: `It has been handed to the courier and is heading to you.`,
    },
    delivered: {
        headline: `Your order has been delivered! 🎉`,
        detail: `We hope you love it. Need to return something? You can request a return from your Rozare account.`,
    },
    cancelled: {
        headline: `Your order has been cancelled. ❌`,
        detail: `Nothing more is needed from you. If this is unexpected, please contact Rozare support or the store.`,
    },
};

exports.buildOrderStatusUpdateMessage = (order, status) => {
    const lines = STATUS_UPDATE_LINES[String(status || '').toLowerCase()];
    if (!lines) return '';

    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const storesLine = buildStoresLine(order);

    return [
        `Hey ${buyerName}! 👋`,
        ``,
        lines.headline,
        ``,
        `📦 Order: *#${order.orderId}*`,
        ...(storesLine ? [storesLine] : []),
        ``,
        lines.detail,
        ``,
        `Track it anytime in your Rozare account. 💜`,
    ].join('\n');
};

// ──────────────────────────────────────────────────────────────────────────
// Re-confirm buttons payload — sent when buyer taps confirm on a cancelled order
// ──────────────────────────────────────────────────────────────────────────
exports.buildReconfirmButtonsPayload = (order, contextMessage) => {
    const buyerName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
    const currency = orderCurrency(order);
    const total = formatMoney(order.orderSummary?.totalAmount, currency);
    const itemCount = order.orderItems?.length || 0;

    const productLines = (order.orderItems || []).map(it => buildProductLine(it, currency)).slice(0, 5);
    if (itemCount > 5) productLines.push(`  _...and ${itemCount - 5} more_`);
    const storesLine = buildStoresLine(order);

    return {
        title: `Re-confirm Order #${order.orderId}?`,
        description: [
            contextMessage || `Hey ${buyerName}! This order was cancelled.`,
            ``,
            `Here's what was in your order:`,
            ...productLines,
            ``,
            ...(storesLine ? [storesLine] : []),
            `💰 Total: *${total}*`,
            ``,
            `Are you sure you want to confirm this order again?`,
        ].join('\n'),
        footer: `Rozare · Tap a button to decide`,
        buttons: [
            {
                type: 'reply',
                displayText: '✅ Yes, confirm again',
                id: exports.buildReconfirmButtonId(order.orderId),
            },
            {
                type: 'reply',
                displayText: '❌ No, keep cancelled',
                id: exports.buildKeepCancelButtonId(order.orderId),
            },
        ],
    };
};
