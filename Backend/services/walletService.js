'use strict';

const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { formatMoneySync } = require('./currencyService');
const { STRIPE_MODE } = require('../config/stripe');

const WALLET_CURRENCIES = Object.freeze(['USD', 'PKR', 'EUR', 'GBP']);
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const balancePath = (currency) => `balances.${normalizeWalletCurrency(currency)}`;

const normalizeWalletCurrency = (value) => {
  const currency = String(value || 'USD').trim().toUpperCase();
  if (!WALLET_CURRENCIES.includes(currency)) {
    const error = new Error('This currency is not supported by Rozare Wallet.');
    error.statusCode = 400;
    error.code = 'WALLET_CURRENCY_NOT_SUPPORTED';
    throw error;
  }
  return currency;
};

const formatWalletMoney = (amount, currency) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  return formatMoneySync(roundMoney(amount), normalizedCurrency, {
    sourceCurrency: normalizedCurrency,
  });
};

const walletTopUpDescription = (amount, currency) =>
  `Rozare Wallet top-up of ${formatWalletMoney(amount, currency)}`;

const getWalletTransactionDescription = (transaction) => {
  if (transaction?.type === 'top_up') {
    return walletTopUpDescription(transaction.amount, transaction.currency);
  }
  return String(transaction?.description || '').trim();
};

const toStripeMinorUnits = (amount, currency) => {
  const normalized = normalizeWalletCurrency(currency);
  const value = Math.max(0, Number(amount) || 0);
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? Math.round(value) : Math.round(value * 100);
};

const fromStripeMinorUnits = (amount, currency) => {
  const normalized = normalizeWalletCurrency(currency);
  const value = Math.max(0, Number(amount) || 0);
  return roundMoney(ZERO_DECIMAL_CURRENCIES.has(normalized) ? value : value / 100);
};

const runInTransaction = async (work) => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const ensureWallet = async (userId, session = null) => Wallet.findOneAndUpdate(
  { user: userId },
  { $setOnInsert: { user: userId, status: 'active' } },
  { new: true, upsert: true, setDefaultsOnInsert: true, session }
);

const creditWalletInSession = async ({
  userId,
  amount,
  currency,
  type,
  referenceType,
  referenceId,
  idempotencyKey,
  description,
  metadata = {},
  allowLocked = false,
}, session) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const normalizedAmount = roundMoney(amount);
  if (normalizedAmount <= 0) {
    const error = new Error('Wallet credit amount must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
  if (existing?.status === 'completed') return existing;
  if (existing) {
    const error = new Error('A wallet transaction with this reference is already pending.');
    error.statusCode = 409;
    error.code = 'WALLET_TRANSACTION_PENDING';
    throw error;
  }

  const wallet = await ensureWallet(userId, session);
  if (wallet.status !== 'active' && !allowLocked) {
    const error = new Error('Your Rozare Wallet is currently locked. Please contact support.');
    error.statusCode = 423;
    error.code = 'WALLET_LOCKED';
    throw error;
  }

  const updatedWallet = await Wallet.findOneAndUpdate(
    { _id: wallet._id, ...(allowLocked ? {} : { status: 'active' }) },
    { $inc: { [balancePath(normalizedCurrency)]: normalizedAmount } },
    { new: true, session }
  );

  const [transaction] = await WalletTransaction.create([{
    user: userId,
    wallet: wallet._id,
    type,
    direction: 'credit',
    status: 'completed',
    amount: normalizedAmount,
    currency: normalizedCurrency,
    balanceAfter: roundMoney(updatedWallet.balances?.[normalizedCurrency] || 0),
    description,
    referenceType,
    referenceId: String(referenceId),
    idempotencyKey,
    metadata,
    completedAt: new Date(),
  }], { session });

  return transaction;
};

const debitWalletInSession = async ({
  userId,
  amount,
  currency,
  type,
  referenceType,
  referenceId,
  idempotencyKey,
  description,
  metadata = {},
}, session) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const normalizedAmount = roundMoney(amount);
  if (normalizedAmount <= 0) {
    const error = new Error('Wallet debit amount must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
  if (existing?.status === 'completed') return existing;
  if (existing) {
    const error = new Error('A wallet transaction with this reference is already pending.');
    error.statusCode = 409;
    error.code = 'WALLET_TRANSACTION_PENDING';
    throw error;
  }

  const wallet = await ensureWallet(userId, session);
  if (wallet.status !== 'active') {
    const error = new Error('Your Rozare Wallet is currently locked. Please contact support.');
    error.statusCode = 423;
    error.code = 'WALLET_LOCKED';
    throw error;
  }

  const path = balancePath(normalizedCurrency);
  const updatedWallet = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      status: 'active',
      [path]: { $gte: normalizedAmount },
    },
    { $inc: { [path]: -normalizedAmount } },
    { new: true, session }
  );

  if (!updatedWallet) {
    const available = roundMoney(wallet.balances?.[normalizedCurrency] || 0);
    const error = new Error(`Insufficient Rozare Wallet balance. Available: ${available} ${normalizedCurrency}.`);
    error.statusCode = 400;
    error.code = 'INSUFFICIENT_WALLET_BALANCE';
    error.availableBalance = available;
    error.currency = normalizedCurrency;
    throw error;
  }

  const [transaction] = await WalletTransaction.create([{
    user: userId,
    wallet: wallet._id,
    type,
    direction: 'debit',
    status: 'completed',
    amount: normalizedAmount,
    currency: normalizedCurrency,
    balanceAfter: roundMoney(updatedWallet.balances?.[normalizedCurrency] || 0),
    description,
    referenceType,
    referenceId: String(referenceId),
    idempotencyKey,
    metadata,
    completedAt: new Date(),
  }], { session });

  return transaction;
};

const walletPaymentError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const stripeLivemodeMatches = (stripeObject, stripeMode) => (
  typeof stripeObject?.livemode !== 'boolean'
  || stripeObject.livemode === (stripeMode === 'live')
);

const validateWalletTopUpPaymentIntent = (transaction, paymentIntent) => {
  if (!transaction || transaction.paymentFlow !== 'payment_sheet') {
    throw walletPaymentError('This is not a native Wallet top-up.', 'NOT_PAYMENT_SHEET_TOP_UP');
  }
  const metadata = paymentIntent?.metadata || {};
  const customerId = typeof paymentIntent?.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent?.customer?.id;
  if (
    !paymentIntent?.id
    || paymentIntent.id !== transaction.stripePaymentIntentId
    || metadata.type !== 'wallet_top_up'
    || metadata.paymentFlow !== 'payment_sheet'
    || String(metadata.walletTransactionId || '') !== String(transaction._id || '')
    || String(metadata.userId || '') !== String(transaction.user || '')
  ) {
    throw walletPaymentError('Wallet top-up ownership is invalid.', 'TOP_UP_TRANSACTION_MISMATCH');
  }
  if (!transaction.stripeCustomerId || customerId !== transaction.stripeCustomerId) {
    throw walletPaymentError('Wallet top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
  }
  const expectedMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
  if (
    Number(paymentIntent.amount) !== expectedMinor
    || Number(metadata.amountMinor) !== expectedMinor
    || String(paymentIntent.currency || '').toUpperCase() !== transaction.currency
  ) {
    throw walletPaymentError('Wallet top-up amount or currency is invalid.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  if (
    !transaction.stripeMode
    || metadata.stripeMode !== transaction.stripeMode
    || !stripeLivemodeMatches(paymentIntent, transaction.stripeMode)
  ) {
    throw walletPaymentError('Wallet top-up Stripe mode is invalid.', 'TOP_UP_MODE_MISMATCH');
  }
  return true;
};

const validateWalletTopUpCheckoutSession = (transaction, checkoutSession) => {
  const metadata = checkoutSession?.metadata || {};
  const customerId = typeof checkoutSession?.customer === 'string'
    ? checkoutSession.customer
    : checkoutSession?.customer?.id;
  if (
    !transaction
    || transaction.paymentFlow !== 'checkout_session'
    || checkoutSession?.id !== transaction.stripeSessionId
    || checkoutSession?.mode !== 'payment'
    || metadata.type !== 'wallet_top_up'
    || metadata.paymentFlow !== 'checkout_session'
    || String(metadata.walletTransactionId || '') !== String(transaction._id || '')
    || String(metadata.userId || '') !== String(transaction.user || '')
  ) {
    throw walletPaymentError('Wallet top-up Checkout ownership is invalid.', 'TOP_UP_TRANSACTION_MISMATCH');
  }
  if (!transaction.stripeCustomerId || customerId !== transaction.stripeCustomerId) {
    throw walletPaymentError('Wallet top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
  }
  if (
    Number(checkoutSession.amount_total) !== toStripeMinorUnits(transaction.amount, transaction.currency)
    || String(checkoutSession.currency || '').toUpperCase() !== transaction.currency
  ) {
    throw walletPaymentError('Wallet top-up amount or currency is invalid.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  if (
    !transaction.stripeMode
    || metadata.stripeMode !== transaction.stripeMode
    || !stripeLivemodeMatches(checkoutSession, transaction.stripeMode)
  ) {
    throw walletPaymentError('Wallet top-up Stripe mode is invalid.', 'TOP_UP_MODE_MISMATCH');
  }
  return true;
};

const settleWalletTopUp = async ({
  transactionId,
  stripeObjectId,
  paymentIntentId,
  chargeId,
  customerId,
  amountMinor,
  currency,
  userId,
  stripeMode,
  eventId,
  sourceField,
  stripeObject,
}) => {
  if (!transactionId) return null;
  return runInTransaction(async (session) => {
    const transaction = await WalletTransaction.findOne({
      _id: transactionId,
      type: 'top_up',
      [sourceField]: stripeObjectId,
    }).session(session);

    if (!transaction) {
      const error = new Error(`Wallet top-up transaction ${transactionId} was not found.`);
      error.code = 'TOP_UP_TRANSACTION_NOT_FOUND';
      throw error;
    }
    if (transaction.status === 'completed') return transaction;
    if (!['pending', 'failed', 'cancelled', 'expired'].includes(transaction.status)) {
      const error = new Error(`Wallet top-up cannot complete from status ${transaction.status}.`);
      error.code = 'INVALID_TOP_UP_STATUS';
      throw error;
    }

    const expectedMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
    const receivedCurrency = String(currency || '').toUpperCase();
    if (Number(amountMinor) !== expectedMinor || receivedCurrency !== transaction.currency) {
      throw walletPaymentError(
        'Stripe top-up amount or currency did not match the stored transaction.',
        'TOP_UP_AMOUNT_MISMATCH',
      );
    }
    if (String(userId || '') !== String(transaction.user)) {
      throw walletPaymentError('Stripe top-up user ownership is invalid.', 'TOP_UP_USER_MISMATCH');
    }
    if (transaction.stripeCustomerId && String(customerId || '') !== transaction.stripeCustomerId) {
      throw walletPaymentError('Stripe top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
    }
    const expectedMode = transaction.stripeMode || stripeMode || STRIPE_MODE;
    if (
      (transaction.paymentFlow === 'payment_sheet' && stripeMode !== expectedMode)
      || (transaction.paymentFlow !== 'payment_sheet' && stripeMode && stripeMode !== expectedMode)
    ) {
      throw walletPaymentError('Stripe top-up mode is invalid.', 'TOP_UP_MODE_MISMATCH');
    }
    if (!stripeLivemodeMatches(stripeObject, expectedMode)) {
      throw walletPaymentError('Stripe top-up live mode is invalid.', 'TOP_UP_MODE_MISMATCH');
    }

    const wallet = await ensureWallet(transaction.user, session);
    // Stripe has already captured the money. Credit even if an operational
    // lock was added while payment was in flight; the lock still prevents use.
    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: wallet._id },
      { $inc: { [balancePath(transaction.currency)]: transaction.amount } },
      { new: true, session }
    );

    transaction.wallet = wallet._id;
    transaction.status = 'completed';
    transaction.balanceAfter = roundMoney(updatedWallet.balances?.[transaction.currency] || 0);
    transaction.stripePaymentIntentId = paymentIntentId || transaction.stripePaymentIntentId || null;
    transaction.stripeChargeId = chargeId || transaction.stripeChargeId || null;
    transaction.stripeCustomerId = customerId || transaction.stripeCustomerId || null;
    transaction.stripeWebhookEventId = eventId || transaction.stripeWebhookEventId || null;
    transaction.failureReason = '';
    transaction.completedAt = new Date();
    await transaction.save({ session });
    return transaction;
  });
};

const completeWalletTopUp = async (stripeSession, eventId = null) => {
  if (stripeSession?.payment_status !== 'paid') {
    throw walletPaymentError('Stripe has not marked this wallet top-up as paid.', 'TOP_UP_NOT_PAID', 409);
  }
  if (stripeSession.metadata?.type && stripeSession.metadata.type !== 'wallet_top_up') {
    throw walletPaymentError('Stripe top-up metadata type is invalid.', 'TOP_UP_TYPE_MISMATCH');
  }
  return settleWalletTopUp({
    transactionId: stripeSession?.metadata?.walletTransactionId,
    stripeObjectId: stripeSession?.id,
    paymentIntentId: typeof stripeSession?.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession?.payment_intent?.id,
    chargeId: null,
    customerId: typeof stripeSession?.customer === 'string'
      ? stripeSession.customer
      : stripeSession?.customer?.id,
    amountMinor: stripeSession?.amount_total,
    currency: stripeSession?.currency,
    userId: stripeSession?.metadata?.userId,
    stripeMode: stripeSession?.metadata?.stripeMode,
    eventId,
    sourceField: 'stripeSessionId',
    stripeObject: stripeSession,
  });
};

const completeWalletTopUpFromPaymentIntent = async (paymentIntent, eventId = null) => {
  if (paymentIntent?.status !== 'succeeded') {
    throw walletPaymentError('Stripe has not confirmed this Wallet top-up.', 'TOP_UP_NOT_PAID', 409);
  }
  if (
    paymentIntent.metadata?.type !== 'wallet_top_up'
    || paymentIntent.metadata?.paymentFlow !== 'payment_sheet'
  ) {
    throw walletPaymentError('Stripe top-up metadata is invalid.', 'TOP_UP_TYPE_MISMATCH');
  }
  const amountReceived = Number(paymentIntent.amount_received);
  if (amountReceived !== Number(paymentIntent.amount)) {
    throw walletPaymentError('Stripe did not capture the complete Wallet top-up.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  return settleWalletTopUp({
    transactionId: paymentIntent.metadata.walletTransactionId,
    stripeObjectId: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
    chargeId: typeof paymentIntent.latest_charge === 'string'
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id,
    customerId: typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : paymentIntent.customer?.id,
    amountMinor: amountReceived,
    currency: paymentIntent.currency,
    userId: paymentIntent.metadata.userId,
    stripeMode: paymentIntent.metadata.stripeMode,
    eventId,
    sourceField: 'stripePaymentIntentId',
    stripeObject: paymentIntent,
  });
};

const failWalletTopUp = async (stripeSession, reason = 'Stripe checkout expired or failed.') => {
  const transactionId = stripeSession?.metadata?.walletTransactionId;
  if (!transactionId) return null;
  return WalletTransaction.findOneAndUpdate(
    { _id: transactionId, type: 'top_up', status: 'pending', stripeSessionId: stripeSession.id },
    { $set: { status: 'failed', failureReason: reason } },
    { new: true }
  );
};

const recordWalletTopUpPaymentFailure = async (paymentIntent, eventId = null) => {
  if (
    paymentIntent?.metadata?.type !== 'wallet_top_up'
    || paymentIntent?.metadata?.paymentFlow !== 'payment_sheet'
  ) return null;
  const transaction = await WalletTransaction.findOne({
    _id: paymentIntent.metadata.walletTransactionId,
    user: paymentIntent.metadata.userId,
    type: 'top_up',
    status: 'pending',
    stripePaymentIntentId: paymentIntent.id,
    stripeCustomerId: typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : paymentIntent.customer?.id,
  });
  if (!transaction) throw walletPaymentError('Wallet top-up ownership is invalid.', 'TOP_UP_TRANSACTION_NOT_FOUND');
  validateWalletTopUpPaymentIntent(transaction, paymentIntent);

  // A failed attempt can return to requires_payment_method and then succeed.
  // Keep the transaction pending and reusable until explicit cancel/expiry.
  transaction.failureReason = String(
    paymentIntent.last_payment_error?.message || 'The card was declined. Try another payment method.'
  ).slice(0, 500);
  transaction.stripeWebhookEventId = eventId || transaction.stripeWebhookEventId;
  await transaction.save();
  return transaction;
};

const cancelWalletTopUpFromPaymentIntent = async (
  paymentIntent,
  { eventId = null, status = 'cancelled', reason = 'Payment was cancelled.' } = {},
) => {
  if (
    paymentIntent?.metadata?.type !== 'wallet_top_up'
    || paymentIntent?.metadata?.paymentFlow !== 'payment_sheet'
  ) return null;
  const customerId = typeof paymentIntent.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent.customer?.id;
  const transaction = await WalletTransaction.findOne({
    _id: paymentIntent.metadata.walletTransactionId,
    user: paymentIntent.metadata.userId,
    type: 'top_up',
    status: 'pending',
    stripePaymentIntentId: paymentIntent.id,
    stripeCustomerId: customerId,
    stripeMode: paymentIntent.metadata.stripeMode,
  });
  if (!transaction) return null;
  validateWalletTopUpPaymentIntent(transaction, paymentIntent);
  return WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      status: 'pending',
    },
    {
      $set: {
        status,
        failureReason: String(reason).slice(0, 500),
        stripeWebhookEventId: eventId,
      },
    },
    { new: true },
  );
};

const payOrderWithWallet = async ({ orderId, userId }) => runInTransaction(async (session) => {
  const order = await Order.findOne({ _id: orderId, user: userId }).session(session);
  if (!order) {
    const error = new Error('Order not found.');
    error.statusCode = 404;
    throw error;
  }
  if (order.paymentMethod !== 'wallet') {
    const error = new Error('This order is not configured for wallet payment.');
    error.statusCode = 400;
    throw error;
  }
  if (order.isPaid && !order.awaitingPayment) return order;
  if (order.orderStatus === 'cancelled' || order.confirmation?.declinedAt) {
    const error = new Error('This order was cancelled and can no longer be paid.');
    error.statusCode = 409;
    error.code = 'ORDER_CANCELLED';
    throw error;
  }
  if (!order.awaitingPayment) {
    const error = new Error('This order is not awaiting Wallet payment.');
    error.statusCode = 409;
    error.code = 'ORDER_NOT_AWAITING_PAYMENT';
    throw error;
  }

  const transaction = await debitWalletInSession({
    userId,
    amount: order.orderSummary.totalAmount,
    currency: order.currency,
    type: 'order_payment',
    referenceType: 'order',
    referenceId: order._id,
    idempotencyKey: `wallet-order:${order._id}`,
    description: `Payment for order ${order.orderId}`,
    metadata: { orderId: order.orderId },
  }, session);

  if (!order.inventoryCommitted) {
    for (const item of order.orderItems || []) {
      const result = await Product.updateOne(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity, totalSales: item.quantity } },
        { session }
      );
      if (result.modifiedCount !== 1) {
        const error = new Error(`There is no longer enough stock for ${item.name || 'an item'} in this order.`);
        error.statusCode = 409;
        error.code = 'ORDER_STOCK_CHANGED';
        throw error;
      }
    }
    order.inventoryCommitted = true;
  }

  order.awaitingPayment = false;
  order.isPaid = true;
  order.paidAt = new Date();
  order.orderStatus = 'confirmed';
  for (const fulfillment of order.sellerFulfillment || []) {
    if (fulfillment.status === 'pending') {
      fulfillment.status = 'confirmed';
      fulfillment.updatedAt = new Date();
    }
  }
  order.paymentResult = order.paymentResult || {};
  order.paymentResult.walletTransactionId = transaction._id;
  order.paymentFulfilledAt = order.paymentFulfilledAt || new Date();
  order.confirmation = order.confirmation || {};
  order.confirmation.confirmedAt = order.confirmation.confirmedAt || new Date();
  order.confirmation.confirmedVia = 'wallet_payment';
  await order.save({ session });
  return order;
});

const getWalletSummary = async (userId, { limit = 50 } = {}) => {
  const wallet = await ensureWallet(userId);
  const transactions = await WalletTransaction.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();
  return {
    wallet: {
      _id: wallet._id,
      balances: {
        USD: roundMoney(wallet.balances?.USD || 0),
        PKR: roundMoney(wallet.balances?.PKR || 0),
        EUR: roundMoney(wallet.balances?.EUR || 0),
        GBP: roundMoney(wallet.balances?.GBP || 0),
      },
      status: wallet.status,
      lockedReason: wallet.lockedReason || '',
      updatedAt: wallet.updatedAt,
    },
    transactions: transactions.map(serializeWalletTransaction),
  };
};

const serializeWalletTransaction = (transaction) => ({
  _id: transaction._id,
  type: transaction.type,
  direction: transaction.direction,
  status: transaction.status,
  amount: roundMoney(transaction.amount),
  currency: transaction.currency,
  balanceAfter: transaction.balanceAfter == null ? null : roundMoney(transaction.balanceAfter),
  description: getWalletTransactionDescription(transaction),
  referenceType: transaction.referenceType,
  failureReason: transaction.failureReason || '',
  completedAt: transaction.completedAt || null,
  createdAt: transaction.createdAt,
  updatedAt: transaction.updatedAt,
});

module.exports = {
  WALLET_CURRENCIES,
  roundMoney,
  normalizeWalletCurrency,
  formatWalletMoney,
  walletTopUpDescription,
  getWalletTransactionDescription,
  toStripeMinorUnits,
  fromStripeMinorUnits,
  runInTransaction,
  ensureWallet,
  creditWalletInSession,
  debitWalletInSession,
  completeWalletTopUp,
  completeWalletTopUpFromPaymentIntent,
  failWalletTopUp,
  recordWalletTopUpPaymentFailure,
  cancelWalletTopUpFromPaymentIntent,
  payOrderWithWallet,
  getWalletSummary,
  serializeWalletTransaction,
  validateWalletTopUpPaymentIntent,
  validateWalletTopUpCheckoutSession,
};
