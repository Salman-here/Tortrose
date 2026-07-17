/**
 * WhatsApp message templates for seller notifications.
 * Keep these concise because WhatsApp delivery is more reliable with short text.
 */

const { normalizeCurrency } = require('../currencyService');
const {
    formatOrderMoney,
    orderItemLineText,
    paymentMethodLabel,
} = require('../../utils/orderPresentation');

const orderCurrency = (order) => normalizeCurrency(order?.currency || order?.displayCurrency || 'USD');

const orderNumber = (order) => order?.orderId || order?._id || 'Unknown';

const orderTotal = (order) => {
    const currency = orderCurrency(order);
    const total = Number(order?.orderSummary?.totalAmount ?? order?.totalAmount ?? order?.total ?? 0);
    return formatOrderMoney(Number.isFinite(total) ? total : 0, currency);
};

const itemLines = (order, limit = 8) => {
    const items = order?.orderItems || [];
    const lines = items
        .slice(0, limit)
        .map(item => orderItemLineText(item, orderCurrency(order)));
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
            ? `Your seller account is created and "${storeName}" is live.`
            : 'Your seller account is created.';
        return [
            'Congratulations!',
            '',
            liveLine,
            '',
            'You can manage your store directly from the seller dashboard, or chat with me here. I can help add products, update prices and stock, improve descriptions, create coupons, check orders, manage store details, and more.',
        ].join('\n');
    },

    new_order: (order) => {
        const count = order?.orderItems?.length || 0;
        return [
            'New Order Received',
            '',
            `Order: #${orderNumber(order)}`,
            `Item count: ${count}`,
            orderLinesBlock(order),
            `Total: ${orderTotal(order)}`,
            `Payment: ${paymentMethodLabel(order?.paymentMethod)}`,
            '',
            'Check your dashboard to process this order.',
        ].join('\n');
    },

    order_confirmed: (order) => [
        'Order Confirmed',
        '',
        `Order #${orderNumber(order)} has been confirmed by the buyer.`,
        orderLinesBlock(order),
        '',
        'Please prepare the order for shipping.',
    ].join('\n'),

    order_cancelled: (order) => [
        'Order Cancelled',
        '',
        `Order #${orderNumber(order)} has been cancelled by the buyer.`,
        orderLinesBlock(order),
    ].join('\n'),

    return_requested: (returnRequest) => [
        'New Return Request',
        '',
        `Return: #${returnRequest?.returnNumber || 'Unknown'}`,
        `Order: #${returnRequest?.orderId || 'Unknown'}`,
        `Buyer reason: ${returnRequest?.reasonDetails || 'No reason provided'}`,
        '',
        'Open Seller Dashboard > Orders > Return Orders to review it.',
    ].join('\n'),

    return_settled: (returnRequest, amountText) => [
        'Return Refund Completed',
        '',
        `Return: #${returnRequest?.returnNumber || 'Unknown'}`,
        `Order: #${returnRequest?.orderId || 'Unknown'}`,
        `Refund: ${amountText}`,
        '',
        'The buyer wallet was credited and the return is now complete.',
    ].join('\n'),

    subscription_activated: (planName, freePeriodDays) => {
        const freeStr = freePeriodDays > 0 ? `\nFree period: ${freePeriodDays} days` : '';
        return `${planName} Activated\n\nYour seller subscription is now active.${freeStr}\n\nYour store is live and visible to customers.`;
    },

    subscription_ending_soon: (daysLeft) =>
        `Subscription Ending Soon\n\nYour subscription ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nPlease ensure your payment method is up to date to avoid service interruption.`,

    payment_failed: () =>
        "Payment Failed\n\nWe couldn't process your subscription payment. Your store may be blocked if payment isn't resolved soon.\n\nPlease update your payment method in the dashboard.",

    payment_recovered: () =>
        'Payment Successful\n\nYour subscription payment has been processed successfully. Your account is now in good standing.',

    trial_expiring: (daysLeft) =>
        `Trial Expiring\n\nYour free trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.\n\nSubscribe to keep your store active and visible to customers.`,

    account_blocked: (reason) =>
        `Store Blocked\n\nYour store has been blocked${reason ? `: ${reason}` : ''}.\n\nCustomers can no longer see your products. Subscribe or contact support to reactivate.`,

    product_blocked: (productName, reason) =>
        `Product Blocked\n\n"${productName || 'Your product'}" was blocked because ${reason || 'it looks like test or placeholder content'}.\n\nIt is saved in your Products tab as blocked, but customers cannot see it. Edit it with a real product name and description to make it available again.`,

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
