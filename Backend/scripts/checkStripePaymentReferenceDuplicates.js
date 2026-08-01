'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');

const duplicateValues = (Model, field) => Model.aggregate([
  { $match: { [field]: { $type: 'string', $ne: '' } } },
  { $group: { _id: `$${field}`, count: { $sum: 1 }, documents: { $push: '$_id' } } },
  { $match: { count: { $gt: 1 } } },
  { $limit: 20 },
]);

const run = async () => {
  await connectDB();
  const checks = [
    ['Order.stripeSessionId', Order, 'stripeSessionId'],
    ['Order.stripePaymentIntentId', Order, 'stripePaymentIntentId'],
    ['WalletTransaction.stripeSessionId', WalletTransaction, 'stripeSessionId'],
    ['WalletTransaction.stripePaymentIntentId', WalletTransaction, 'stripePaymentIntentId'],
  ];
  let failed = false;
  for (const [label, Model, field] of checks) {
    const duplicates = await duplicateValues(Model, field);
    if (duplicates.length) {
      failed = true;
      console.error(`${label}: found ${duplicates.length} duplicate reference value(s).`);
      for (const duplicate of duplicates) {
        console.error(`  ${duplicate._id}: ${duplicate.count} documents (${duplicate.documents.join(', ')})`);
      }
    } else {
      console.log(`${label}: no duplicates found.`);
    }
  }
  if (failed) process.exitCode = 1;
};

run()
  .catch(error => {
    console.error('Stripe payment reference preflight failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
