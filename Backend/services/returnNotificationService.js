'use strict';

const Notification = require('../models/Notification');
const ReturnRequest = require('../models/ReturnRequest');
const User = require('../models/User');
const { notifySeller } = require('./whatsapp/sellerNotificationService');
const sellerTemplates = require('./whatsapp/sellerMessageTemplates');
const { enqueueTextNotification } = require('./whatsapp/queue');
const { sendPushToUser } = require('../utils/expoPush');
const { formatMoneySync, normalizeCurrency } = require('./currencyService');
const { RETURN_STATUS_LABELS } = require('./returnPolicyService');

const notificationBody = value => String(value || '').trim().slice(0, 1000);

const buyerReturnLink = (returnRequest) =>
  `/user-dashboard/order/detail/${returnRequest.order}?returnId=${returnRequest._id}`;

const sellerReturnLink = (returnRequest) =>
  `/seller-dashboard/order-management?tab=returns&returnId=${returnRequest._id}`;

const formatReturnAmount = (returnRequest) => formatMoneySync(
  returnRequest?.refund?.totalAmount || 0,
  normalizeCurrency(returnRequest?.currency || 'USD'),
  { sourceCurrency: normalizeCurrency(returnRequest?.currency || 'USD') }
);

const statusNotificationKey = (returnRequest) => {
  const history = returnRequest?.statusHistory || [];
  const matchingEntry = [...history].reverse().find(entry => entry.status === returnRequest.status);
  const timestamp = matchingEntry?.changedAt || returnRequest?.updatedAt || returnRequest?.createdAt || new Date(0);
  return `buyer-status:${returnRequest.status}:${new Date(timestamp).getTime()}`;
};

const notificationAttemptSucceeded = (result, requiresSentFlag = false) => (
  result?.status === 'fulfilled' && (!requiresSentFlag || result.value?.sent === true)
);

const sendBuyerWhatsApp = async (order, message, dedupeKey) => {
  const digits = String(order?.shippingInfo?.phone || '').replace(/\D/g, '');
  if (digits.length < 8) return { sent: false, reason: 'invalid_phone' };
  const queued = await enqueueTextNotification({ order, phone: digits, message, dedupeKey });
  return queued ? { sent: true, queued: true } : { sent: false, reason: 'enqueue_failed' };
};

const sendSellerReturnWhatsApp = async (returnRequest, order) => {
  const seller = await User.findById(returnRequest?.seller)
    .select('sellerInfo.whatsappNumber sellerInfo.whatsappVerified')
    .lean();
  const digits = String(seller?.sellerInfo?.whatsappNumber || '').replace(/\D/g, '');
  if (!seller?.sellerInfo?.whatsappVerified || digits.length < 8) {
    return { sent: false, reason: 'seller_whatsapp_not_verified' };
  }
  const queued = await enqueueTextNotification({
    order,
    phone: digits,
    message: sellerTemplates.return_requested(returnRequest),
    dedupeKey: `return-request:${returnRequest._id}:seller`,
  });
  return queued ? { sent: true, queued: true } : { sent: false, reason: 'enqueue_failed' };
};

const notifySellerReturnRequested = async (returnRequest, order) => {
  const claimed = await ReturnRequest.findOneAndUpdate(
    { _id: returnRequest?._id, requestedNotificationSentAt: null },
    { $set: { requestedNotificationSentAt: new Date() } },
    { new: true }
  );
  const current = claimed || returnRequest;
  if (!current) return false;

  const buyerName = order?.shippingInfo?.fullName || 'A buyer';
  const body = `${buyerName} requested a return for order #${current.orderId}. Reason: ${current.reasonDetails}`;

  const appResults = claimed ? await Promise.allSettled([
    Notification.create({
      user: current.seller,
      title: 'New return request',
      body: notificationBody(body),
      category: 'order',
      linkTo: sellerReturnLink(current),
      source: 'system',
    }),
    sendPushToUser(current.seller, {
      title: 'New return request',
      body: notificationBody(body),
      channelId: 'seller',
      data: {
        type: 'return_requested',
        returnRequestId: String(current._id),
        orderId: String(current.order),
      },
    }),
  ]) : [];
  const appSent = !claimed || appResults.some(result => notificationAttemptSucceeded(result));
  if (claimed && !appSent) {
    await ReturnRequest.updateOne(
      { _id: claimed._id, requestedNotificationSentAt: claimed.requestedNotificationSentAt },
      { $set: { requestedNotificationSentAt: null } }
    ).catch(() => {});
  }
  const whatsapp = await sendSellerReturnWhatsApp(current, order);
  return appSent && whatsapp?.sent === true;
};

const notifyBuyerReturnStatus = async (returnRequest, order, note = '') => {
  const notificationKey = statusNotificationKey(returnRequest);
  const claimed = await ReturnRequest.findOneAndUpdate(
    { _id: returnRequest?._id, notificationKeys: { $ne: notificationKey } },
    { $addToSet: { notificationKeys: notificationKey } },
    { new: true }
  );
  const current = claimed || returnRequest;
  if (!current) return false;

  const label = RETURN_STATUS_LABELS[current.status] || current.status;
  const amountText = formatReturnAmount(current);
  const refundLine = current.status === 'returned'
    ? ` ${amountText} has been credited to your Rozare Wallet.`
    : '';
  const noteLine = note ? ` Note: ${note}` : '';
  const body = `Return #${current.returnNumber} for order #${current.orderId} is now ${label.toLowerCase()}.${refundLine}${noteLine}`;

  const appResults = claimed ? await Promise.allSettled([
    Notification.create({
      user: current.buyer,
      title: label,
      body: notificationBody(body),
      category: 'order',
      linkTo: buyerReturnLink(current),
      source: 'system',
    }),
    sendPushToUser(current.buyer, {
      title: label,
      body: notificationBody(body),
      channelId: 'orders',
      data: {
        type: 'return_status_update',
        returnRequestId: String(current._id),
        orderId: String(current.order),
        status: current.status,
      },
    }),
  ]) : [];
  const appSent = !claimed || appResults.some(result => notificationAttemptSucceeded(result));
  if (claimed && !appSent) {
    await ReturnRequest.updateOne(
      { _id: current._id },
      { $pull: { notificationKeys: notificationKey } }
    ).catch(() => {});
  }

  // WhatsApp has its own durable dedupe key. Always attempt the enqueue even
  // when the in-app notification was already claimed on an earlier call.
  const whatsappResult = await sendBuyerWhatsApp(order, [
      'Rozare Return Update',
      '',
      `Return: #${current.returnNumber}`,
      `Order: #${current.orderId}`,
      `Status: ${label}`,
      current.status === 'returned' ? `Wallet credit: ${amountText}` : '',
      note ? `Note: ${note}` : '',
      '',
      'Open your Rozare account for details.',
    ].filter(Boolean).join('\n'), `return:${current._id}:${notificationKey}`);

  return appSent && whatsappResult?.sent === true;
};

const notifySellerReturnSettled = async (returnRequest) => {
  const amountText = formatReturnAmount(returnRequest);
  await Promise.allSettled([
    Notification.create({
      user: returnRequest.seller,
      title: 'Return refund completed',
      body: `${amountText} was credited to the buyer wallet for return #${returnRequest.returnNumber}.`,
      category: 'seller',
      linkTo: sellerReturnLink(returnRequest),
      source: 'system',
    }),
    notifySeller(
      returnRequest.seller,
      'return_update',
      sellerTemplates.return_settled(returnRequest, amountText)
    ),
  ]);
};

const notifyReturnSettlementCompleted = async (returnRequest, order) => {
  const claimed = await ReturnRequest.findOneAndUpdate(
    {
      _id: returnRequest?._id,
      status: 'returned',
      'settlement.status': 'completed',
      'settlement.notificationSentAt': null,
    },
    { $set: { 'settlement.notificationSentAt': new Date() } },
    { new: true }
  );
  if (!claimed) return false;
  try {
    await Promise.all([
      notifyBuyerReturnStatus(claimed, order),
      notifySellerReturnSettled(claimed),
    ]);
    return true;
  } catch (error) {
    await ReturnRequest.updateOne(
      { _id: claimed._id, 'settlement.notificationSentAt': claimed.settlement?.notificationSentAt },
      { $set: { 'settlement.notificationSentAt': null } }
    ).catch(() => {});
    throw error;
  }
};

module.exports = {
  buyerReturnLink,
  sellerReturnLink,
  formatReturnAmount,
  sendBuyerWhatsApp,
  sendSellerReturnWhatsApp,
  notifySellerReturnRequested,
  notifyBuyerReturnStatus,
  notifySellerReturnSettled,
  notifyReturnSettlementCompleted,
};
