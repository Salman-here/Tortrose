'use strict';

const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Order = require('../models/Order');
const Product = require('../models/Product');

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

const toStripeMinorUnits = (amount, currency) => {
  const normalized = normalizeWalletCurrency(currency);
  const value = Math.max(0, Number(amount) || 0);
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? Math.round(value) : Math.round(value * 100);
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

const completeWalletTopUp = async (stripeSession) => {
  const transactionId = stripeSession?.metadata?.walletTransactionId;
  if (!transactionId) return null;
  if (stripeSession.payment_status !== 'paid') {
    const error = new Error('Stripe has not marked this wallet top-up as paid.');
    error.code = 'TOP_UP_NOT_PAID';
    throw error;
  }

  return runInTransaction(async (session) => {
    const transaction = await WalletTransaction.findOne({
      _id: transactionId,
      type: 'top_up',
      stripeSessionId: stripeSession.id,
    }).session(session);

    if (!transaction) {
      const error = new Error(`Wallet top-up transaction ${transactionId} was not found.`);
      error.code = 'TOP_UP_TRANSACTION_NOT_FOUND';
      throw error;
    }
    if (transaction.status === 'completed') return transaction;
    if (transaction.status !== 'pending') {
      const error = new Error(`Wallet top-up cannot complete from status ${transaction.status}.`);
      error.code = 'INVALID_TOP_UP_STATUS';
      throw error;
    }

    const expectedMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
    const receivedCurrency = String(stripeSession.currency || '').toUpperCase();
    if (Number(stripeSession.amount_total) !== expectedMinor || receivedCurrency !== transaction.currency) {
      const error = new Error('Stripe top-up amount or currency did not match the stored transaction.');
      error.code = 'TOP_UP_AMOUNT_MISMATCH';
      throw error;
    }

    const wallet = await ensureWallet(transaction.user, session);
    if (wallet.status !== 'active') {
      const error = new Error('Wallet is locked.');
      error.code = 'WALLET_LOCKED';
      throw error;
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: wallet._id, status: 'active' },
      { $inc: { [balancePath(transaction.currency)]: transaction.amount } },
      { new: true, session }
    );

    transaction.wallet = wallet._id;
    transaction.status = 'completed';
    transaction.balanceAfter = roundMoney(updatedWallet.balances?.[transaction.currency] || 0);
    transaction.stripePaymentIntentId = stripeSession.payment_intent || null;
    transaction.completedAt = new Date();
    await transaction.save({ session });
    return transaction;
  });
};

const failWalletTopUp = async (stripeSession, reason = 'Stripe checkout expired or failed.') => {
  const transactionId = stripeSession?.metadata?.walletTransactionId;
  if (!transactionId) return null;
  return WalletTransaction.findOneAndUpdate(
    { _id: transactionId, type: 'top_up', status: 'pending' },
    { $set: { status: 'failed', failureReason: reason } },
    { new: true }
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
    transactions,
  };
};

module.exports = {
  WALLET_CURRENCIES,
  roundMoney,
  normalizeWalletCurrency,
  toStripeMinorUnits,
  runInTransaction,
  ensureWallet,
  creditWalletInSession,
  debitWalletInSession,
  completeWalletTopUp,
  failWalletTopUp,
  payOrderWithWallet,
  getWalletSummary,
};
