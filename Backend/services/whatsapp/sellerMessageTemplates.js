/**
 * WhatsApp message templates for seller notifications.
 * Keep these concise because WhatsApp delivery is more reliable with short text.
 */

const {
    formatOrderMoney,
    getOrderCurrency,
    orderItemLineText,
    paymentMethodLabel,
} = require('../../utils/orderPresentation');

const orderCurrency = (order) => getOrderCurrency(order);
const inlineText = (value, maxLength = 300) => String(value ?? '')
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const orderNumber = (order) => order?.orderId || order?._id || 'Unknown';

const orderTotal = (order) => {
    const currency = orderCurrency(order);
    const total = order?.orderSummary?.totalAmount ?? order?.totalAmount ?? order?.total;
    return formatOrderMoney(total, currency);
};

const itemLines = (order, limit = 8) => {
    const items = order?.orderItems || [];
    const lines = items
        .slice(0, limit)
        .map(item => inlineText(orderItemLineText(item, orderCurrency(order))));
    if (items.length > limit) {
        const remaining = items.length - limit;
        lines.push(`...and ${remaining} more item${remaining !== 1 ? 's' : ''}`);
    }
    return lines;
};

const orderLinesBlock = (order) => {
    const lines = itemLines(order);
    return lines.length ? ['Items:', ...lines].join('\n') : 'Items: Not available';
};

const templates = {
    seller_welcome: (storeName) => {
        const liveLine = storeName
            ? `Your seller account and ${inlineText(storeName)} have been created.`
            : 'Your seller account has been created.';
        return [
            '*Welcome to selling on Rozare*',
            '',
            liveLine,
            '',
            'Open your seller dashboard to complete store setup, add products and configure shipping. Your dashboard shows whether your store is available to buyers.',
        ].join('\n');
    },

    new_order: (order) => {
        const count = order?.orderItems?.length || 0;
        return [
            '*New order received*',
            '',
            `Order: #${orderNumber(order)}`,
            `Product lines: ${count}`,
            orderLinesBlock(order),
            `Buyer order total: ${orderTotal(order)}`,
            `Payment: ${paymentMethodLabel(order?.paymentMethod)}`,
            '',
            'Open the order in your seller dashboard to review its details and next steps.',
        ].join('\n');
    },

    order_confirmed: (order) => [
        '*Order confirmed by buyer*',
        '',
        `Order #${orderNumber(order)} has been confirmed by the buyer.`,
        orderLinesBlock(order),
        '',
        'Open the order in your seller dashboard to begin processing it.',
    ].join('\n'),

    order_cancelled: (order) => [
        '*Order cancelled*',
        '',
        `Order #${orderNumber(order)} has been cancelled by the buyer.`,
        orderLinesBlock(order),
    ].join('\n'),

    return_requested: (returnRequest) => [
        '*New return request*',
        '',
        `Return: #${returnRequest?.returnNumber || 'Unknown'}`,
        `Order: #${returnRequest?.orderId || 'Unknown'}`,
        `Buyer reason: ${inlineText(returnRequest?.reasonDetails, 500) || 'No reason provided'}`,
        '',
        'Open the Returns tab in Order Management to review and respond.',
    ].join('\n'),

    return_settled: (returnRequest, amountText) => [
        '*Return refund completed*',
        '',
        `Return: #${returnRequest?.returnNumber || 'Unknown'}`,
        `Order: #${returnRequest?.orderId || 'Unknown'}`,
        `Refund: ${amountText}`,
        '',
        'Open the return record in Order Management to review the completed refund.',
    ].join('\n'),

    subscription_activated: (planName, freePeriodDays) => {
        const freeStr = freePeriodDays > 0 ? `\nFree period: ${freePeriodDays} days` : '';
        return `*${inlineText(planName)} activated*\n\nYour seller subscription is active.${freeStr}\n\nOpen Subscription in your seller dashboard to review your plan and next billing date.`;
    },

    subscription_ending_soon: (daysLeft) =>
        `*Subscription ending soon*\n\nYour subscription ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nOpen Subscription in your seller dashboard to review your plan and available options.`,

    payment_failed: () =>
        "*Subscription payment unsuccessful*\n\nYour subscription payment could not be completed.\n\nOpen Subscription in your seller dashboard to review its status, update your payment method and retry.",

    payment_recovered: () =>
        '*Subscription payment confirmed*\n\nYour subscription payment was completed. Open Subscription in your seller dashboard to review your plan and next billing date.',

    plan_change_action_required: () =>
        '*Complete your plan-change payment*\n\nYour requested plan change is waiting for payment verification. Your current plan remains unchanged.\n\nOpen Subscription in your seller dashboard to complete this payment securely.',

    trial_expiring: (daysLeft) =>
        `*Free trial ending soon*\n\nYour free trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nOpen Subscription in your seller dashboard to choose a plan and continue selling.`,

    account_blocked: (reason) =>
        '*Your store is unavailable*\n\nYour store is currently hidden from buyers.\n\nReview the reason in your seller dashboard. For help, contact support@rozare.com.',

    product_blocked: () =>
        '*Product listing needs changes*\n\nA product listing is hidden from customers. Review its moderation reason in Product Management and update the affected details.',

    bonus_expiring: (daysLeft) =>
        `Bonus Features Expiring\n\nYour bonus features expire in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nUpgrade to Rozare Elite to keep them permanently.`,

    bonus_expired: () =>
        'Bonus Features Expired\n\nYour bonus features period has ended. Your Starter plan features remain active.\n\nUpgrade to Rozare Elite for permanent bonus features.',

    downgrade_scheduled: () =>
        'Downgrade Scheduled\n\nYour plan will switch to Rozare Starter at the end of your current billing period.',

    upgrade_completed: () =>
        'Upgraded to Rozare Elite\n\nYou now have access to all Elite features including permanent bonus features.',

    store_verified: () =>
        'Store Verified\n\nYour store verification has been approved. Your store now has the verified badge.',
};

module.exports = templates;
