// Builds the WhatsApp message we send to the buyer to confirm an order.
//
// Flow (button-first, text-safe fallback):
//   1. Send an interactive "native flow" message with 2 reply buttons:
//        [✅ Confirm order]   [❌ Cancel order]
//      Each button carries a stable id of the form
//        confirm_ORD-xxxxxxxxx     or     cancel_ORD-xxxxxxxxx
//      so the webhook can detect the buyer's choice unambiguously — even
//      if the button chips fail to render and the buyer types "yes" / "no"
//      or anything else in their own words.
//
//   2. When the tap comes back, WhatsApp may deliver it as any of:
//        - buttonsResponseMessage.selectedButtonId  (older clients)
//        - interactiveResponseMessage               (v2 native flow)
//        - templateButtonReplyMessage               (template flow)
//        - plain conversation text  (modern WA reflects the displayText
//                                    as a regular message from the buyer)
//      All four paths are handled in webhookHandler.extractReplyText.
//
//   3. If Evolution can't render buttons for a specific phone (very rare in
//      practice, but possible on outdated clients), the underlying text is
//      still human-readable — "Please tap a button OR reply YES / NO" — so
//      no buyer is ever stuck.

const { normalizeCurrency } = require('../currencyService');
const {
    formatOrderMoney,
    formatItemOptionsText,
    orderItemName,
} = require('../../utils/orderPresentation');

const orderCurrency = (order) => normalizeCurrency(order?.currency || order?.displayCurrency || 'USD');
const formatMoney = (n, currency) => formatOrderMoney(n, currency || 'USD');

const itemStoreName = (it) =>
    it?.store?.storeName ||
    it?.productId?.store?.storeName ||
    it?.product?.store?.storeName ||
    it?.storeName ||
    '';

const buildProductLine = (it, currency) => {
    const qty = Number(it.quantity || it.qty || 1) || 1;
    const price = formatOrderMoney((Number(it.price) || 0) * qty, currency);
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
    const currency = orderCurrency(order);
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
        footer: `Rozare order confirmation · You can also reply YES or NO`,
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
    const currency = orderCurrency(order);
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
        footerText: 'Rozare order confirmation · or reply YES / NO',
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

// A plain-text fallback used only if sendButtons fails entirely (network
// error etc.) — we still want the buyer to be able to decide.
exports.buildOrderConfirmationMessage = (order) => {
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
        `Please confirm your order by replying:`,
        ``,
        `   *✅ YES*  — to confirm & start processing`,
        `   *❌ NO*   — to cancel this order`,
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
//   2. Text reply    → parseConfirmReply() uses a multilingual YES/NO
//                      dictionary and tolerates emoji/punctuation.
// ──────────────────────────────────────────────────────────────────────────

const YES_WORDS = [
    'yes', 'y', 'yeah', 'yep', 'yup', 'yess', 'yesss',
    'ok', 'okay', 'kk',
    'confirm', 'confirmed', 'confirming',
    'done', 'accept', 'accepted', 'approve', 'approved',
    'proceed', 'go', 'alright',
    // Urdu / Roman-Urdu
    'han', 'haan', 'ji', 'jee', 'theek', 'theeq',
    // Arabic (romanised)
    'naam', 'aiwa',
    // Hindi
    'haa', 'haaji',
    // Single-digit shortcut
    '1',
];

const NO_WORDS = [
    'no', 'nope', 'nah', 'nay',
    'cancel', 'cancelled', 'cancelling', 'canceled',
    'reject', 'rejected', 'decline', 'declined',
    'stop', 'abort', 'dont', "don't",
    // Urdu / Roman-Urdu
    'nahi', 'nahin', 'nhi', 'mana',
    // Arabic (romanised)
    'la',
    // Single-digit shortcut
    '2',
];

const CONFIRM_REPLY_FILLER_WORDS = [
    'please', 'pls', 'plz',
    'order', 'my', 'this', 'it',
    'thanks', 'thank', 'you',
];

const normaliseReply = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

exports.parseConfirmReply = (text) => {
    const clean = normaliseReply(text);
    if (!clean) return null;

    const tokens = clean.split(' ');
    const decisionTokens = tokens.filter((t) => YES_WORDS.includes(t) || NO_WORDS.includes(t));
    if (!decisionTokens.length) return null;

    const isShortExplicitReply = tokens.length <= 4 && tokens.every((t) =>
        YES_WORDS.includes(t) ||
        NO_WORDS.includes(t) ||
        CONFIRM_REPLY_FILLER_WORDS.includes(t)
    );
    if (!isShortExplicitReply) return null;

    const hasYes = tokens.some((t) => YES_WORDS.includes(t));
    const hasNo = tokens.some((t) => NO_WORDS.includes(t));

    if (hasYes && hasNo) {
        for (const t of tokens) {
            if (YES_WORDS.includes(t)) return 'yes';
            if (NO_WORDS.includes(t)) return 'no';
        }
    }
    if (hasYes) return 'yes';
    if (hasNo) return 'no';

    return null;
};

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
// Phone normalisation (unchanged)
// ──────────────────────────────────────────────────────────────────────────
const DEFAULT_COUNTRY_CODE = String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '92')
    .replace(/[^\d]/g, '') || '92';

exports.normalizePhone = (raw) => {
    if (!raw) return '';
    let p = String(raw).trim();

    const hadPlus = p.startsWith('+');
    const hadDoubleZero = /^00\d/.test(p);

    p = p.replace(/[^\d]/g, '');
    if (!p) return '';

    if (hadPlus) return p;
    if (hadDoubleZero) return p.replace(/^00/, '');

    p = p.replace(/^0+/, '');
    if (p.length > 0 && p.length <= 10) p = DEFAULT_COUNTRY_CODE + p;

    return p;
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
