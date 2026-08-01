'use strict';

const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const {
  runInTransaction,
  fromStripeMinorUnits,
  roundMoney,
} = require('./walletService');

const paymentIntentIdOf = (charge) => (
  typeof charge?.payment_intent === 'string'
    ? charge.payment_intent
    : charge?.payment_intent?.id
);

/**
 * Refunds/disputes are operationally sensitive because a buyer might already
 * have spent a top-up. Lock the wallet immediately and create one pending
 * reversal/review ledger entry per signed Stripe event. Support can then
 * reconcile without silently leaving disputed funds spendable.
 */
const flagWalletTopUpPaymentRisk = async ({ charge, eventId, eventType }) => {
  const paymentIntentId = paymentIntentIdOf(charge);
  if (!paymentIntentId || !eventId) return null;
  const source = await WalletTransaction.findOne({
    type: 'top_up',
    status: 'completed',
    stripePaymentIntentId: paymentIntentId,
  });
  if (!source) return null;

  const isRefund = eventType === 'charge.refunded';
  const referenceType = isRefund ? 'stripe_refund' : 'stripe_dispute';
  const amountMinor = isRefund
    ? Number(charge.amount_refunded || charge.amount)
    : Number(charge.amount);
  const amount = Math.min(
    source.amount,
    fromStripeMinorUnits(amountMinor, source.currency),
  );
  const idempotencyKey = `wallet-risk:${eventId}`;

  return runInTransaction(async (session) => {
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return existing;
    const wallet = await Wallet.findOne({ user: source.user }).session(session);
    if (!wallet) return null;

    const reason = isRefund
      ? `Stripe reported a refund for Wallet top-up ${source._id}. Manual reconciliation is required.`
      : `Stripe reported a card dispute for Wallet top-up ${source._id}. Manual reconciliation is required.`;
    wallet.status = 'locked';
    wallet.lockedReason = reason.slice(0, 300);
    await wallet.save({ session });

    const [review] = await WalletTransaction.create([{
      user: source.user,
      wallet: wallet._id,
      type: 'reversal',
      direction: 'debit',
      status: 'pending',
      amount: Math.max(0.01, roundMoney(amount || source.amount)),
      currency: source.currency,
      balanceAfter: roundMoney(wallet.balances?.[source.currency] || 0),
      description: reason,
      referenceType,
      referenceId: eventId,
      idempotencyKey,
      stripeChargeId: charge.id || source.stripeChargeId || null,
      stripeCustomerId: source.stripeCustomerId || null,
      stripeMode: source.stripeMode || null,
      metadata: {
        sourceTopUpTransactionId: String(source._id),
        stripeEventType: eventType,
        stripeEventId: eventId,
        amountMinor,
      },
    }], { session });
    return review;
  });
};

module.exports = { flagWalletTopUpPaymentRisk };
