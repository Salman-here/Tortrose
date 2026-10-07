'use strict';
// Read-only Sandbox proof of saved-card setup/reuse. No secrets, links, PAN or CVC.
const dns = require('node:dns');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const Payment = require('../models/SafepayPayment');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient } = require('../services/safepayClient');

async function main() {
  const email = String(process.argv[2] || '').toLowerCase();
  if (!/^rozare-safepay-[a-z0-9-]+@mailinator\.com$/.test(email)) throw new Error('QA_SCOPE_REQUIRED');
  const recordsOnly = process.argv.includes('--records-only');
  const config = recordsOnly ? null : readSafepayConfig(process.env, { requireWebhook: true });
  if (config && config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  dns.setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const user = await User.findOne({ email }).select('_id').lean();
  if (!user) throw new Error('QA_ACCOUNT_NOT_FOUND');
  const payments = await Payment.find({ user: user._id, environment: 'sandbox' })
    .sort({ createdAt: -1 }).limit(6).select('+cardId').lean();
  const client = config ? createSafepayClient({ config }) : null;
  const results = [];
  for (const payment of payments) {
    const row = { paymentId: String(payment._id), purpose: payment.purpose, status: payment.status,
      amountMinor: payment.amountMinor, currency: payment.currency, createdAt: payment.createdAt,
      appliedAt: payment.appliedAt, capturedMinor: payment.capturedMinor,
      hasCustomer: !!payment.customerId, hasSelectedCard: !!payment.cardId,
      providerEntryMode: payment.providerEntryMode || null };
    if (payment.tracker && client) {
      try {
        const tracker = await client.getTracker(payment.tracker, payment);
        row.providerState = tracker.state;
        row.providerMode = tracker.mode;
        row.providerEntryMode = tracker.entry_mode;
        row.nextAction = tracker.next_actions?.CYBERSOURCE?.kind;
        row.providerChargeAmountMinor = tracker.charge?.amount?.amount;
        row.providerChargeCurrency = tracker.charge?.amount?.currency;
      } catch (error) { row.providerReadError = error.code || 'PROVIDER_READ_FAILED'; }
    }
    const transactions = await WalletTransaction.find({ safepayPaymentId: payment._id, user: user._id })
      .select('amount currency direction status balanceAfter').lean();
    row.walletEffects = transactions.map(tx => ({ amount: tx.amount, currency: tx.currency,
      direction: tx.direction, status: tx.status, balanceAfter: tx.balanceAfter }));
    results.push(row);
  }
  console.log(JSON.stringify({ sandbox: true, recordsOnly, account: email, payments: results }, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ error: error.code || error.message || 'QA_AUDIT_FAILED' })); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
