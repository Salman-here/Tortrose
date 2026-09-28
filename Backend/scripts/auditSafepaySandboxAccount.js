'use strict';
// Read-only release evidence for the explicitly named Safepay QA accounts.
// Never exports checkout URLs, tokens, saved-card ids or billing contacts.
const dns = require('node:dns');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const User = require('../models/User');
const Payment = require('../models/SafepayPayment');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Order = require('../models/Order');
const Operation = require('../models/SafepayBillingOperation');

async function main() {
  const email = String(process.argv[2] || '').toLowerCase();
  const since = new Date(process.argv[3] || '2026-09-28T00:00:00Z');
  if (!/^rozare-safepay-[a-z0-9-]+@mailinator\.com$/.test(email) || !Number.isFinite(since.getTime())) {
    throw Object.assign(new Error('Supply a Safepay QA Mailinator account and a valid start date.'), { code: 'QA_SCOPE_REQUIRED' });
  }
  if (!process.env.MONGO_URI) throw Object.assign(new Error('Database configuration unavailable.'), { code: 'DATABASE_NOT_CONFIGURED' });
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const user = await User.findOne({ email }).select('_id email role').lean();
  if (!user) throw Object.assign(new Error('QA account not found.'), { code: 'QA_ACCOUNT_NOT_FOUND' });
  const [wallet, payments, transactions, orders, billing] = await Promise.all([
    Wallet.findOne({ user: user._id }).select('balances status').lean(),
    Payment.find({ user: user._id, environment: 'sandbox', createdAt: { $gte: since } })
      .select('_id purpose status currency amountMinor tracker providerState appliedAt paidAt order refundedMinor lastErrorCode lastReconciledAt updatedAt')
      .sort({ createdAt: -1 }).limit(50).lean(),
    WalletTransaction.find({ user: user._id, createdAt: { $gte: since } })
      .select('_id type status direction amount currency balanceAfter referenceType safepayPaymentId creditedAmount appliedToLiability remainingLiability')
      .sort({ createdAt: -1 }).limit(50).lean(),
    Order.find({ user: user._id, createdAt: { $gte: since } })
      .select('_id orderId currency paymentMethod isPaid orderStatus orderSummary safepayPaymentId sellerCurrencyMoney orderItems.name orderItems.qty orderItems.price orderItems.selectedOptions')
      .sort({ createdAt: -1 }).limit(30).lean(),
    Operation.find({ seller: user._id, environment: 'sandbox', createdAt: { $gte: since } })
      .select('_id kind status appliedAt payment terms.plan terms.monthlyMinor terms.dueMinor terms.currency terms.trialDays')
      .sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  const walletCreditCounts = transactions.filter(row => row.type === 'top_up' && row.status === 'completed')
    .reduce((counts, row) => { const key = String(row.safepayPaymentId); counts[key] = (counts[key] || 0) + 1; return counts; }, {});
  console.log(JSON.stringify({ account: user, since, wallet, payments, transactions, walletCreditCounts, orders, billing }, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ error: error.code || error.name || 'AUDIT_FAILED' })); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
