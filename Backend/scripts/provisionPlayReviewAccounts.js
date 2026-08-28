'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const ConnectDB = require('../config/db');
const User = require('../models/User');
const Store = require('../models/Store');
const { initializeSubscription } = require('../controllers/subscriptionController');

const APPLY_FLAG = '--apply';
const ROTATE_FLAG = '--rotate-passwords';
const RESERVED_EMAIL_PATTERN = /^play-review-(buyer|seller)@rozare\.com$/i;

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const requireStrongPassword = (name) => {
  const value = required(name);
  if (value.length < 16 || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw new Error(`${name} must contain at least 16 characters with upper, lower, number, and symbol.`);
  }
  return value;
};

async function uniqueAccountByEmail(email) {
  const matches = await User.find({ email: email.toLowerCase() }).limit(2);
  if (matches.length > 1) throw new Error(`Multiple accounts already use ${email}; stop and resolve them manually.`);
  return matches[0] || null;
}

async function provisionUser({ email, password, username, role, rotatePasswords }) {
  let user = await uniqueAccountByEmail(email);
  if (user && user.role !== role) throw new Error(`${email} exists with role ${user.role}; refusing to change its role.`);
  if (!user) {
    user = new User({ username, email, password, role, status: 'active', isVerified: true });
  } else {
    user.username = username;
    user.status = 'active';
    user.isVerified = true;
    if (rotatePasswords) user.password = password;
  }
  await user.save();
  return user;
}

async function run() {
  if (!process.argv.includes(APPLY_FLAG)) {
    throw new Error(`This command changes production-capable account data. Re-run with ${APPLY_FLAG} after reviewing the configured emails.`);
  }
  const rotatePasswords = process.argv.includes(ROTATE_FLAG);
  const buyerEmail = required('PLAY_REVIEW_BUYER_EMAIL').toLowerCase();
  const sellerEmail = required('PLAY_REVIEW_SELLER_EMAIL').toLowerCase();
  if (!RESERVED_EMAIL_PATTERN.test(buyerEmail) || !RESERVED_EMAIL_PATTERN.test(sellerEmail) || buyerEmail === sellerEmail) {
    throw new Error('Reviewer emails must be the distinct reserved addresses play-review-buyer@rozare.com and play-review-seller@rozare.com.');
  }

  const buyerPassword = requireStrongPassword('PLAY_REVIEW_BUYER_PASSWORD');
  const sellerPassword = requireStrongPassword('PLAY_REVIEW_SELLER_PASSWORD');
  await ConnectDB();
  if (mongoose.connection.readyState !== 1) throw new Error('Database connection is unavailable.');

  const buyer = await provisionUser({
    email: buyerEmail,
    password: buyerPassword,
    username: 'Play Review Buyer',
    role: 'user',
    rotatePasswords,
  });
  const seller = await provisionUser({
    email: sellerEmail,
    password: sellerPassword,
    username: 'Play Review Seller',
    role: 'seller',
    rotatePasswords,
  });

  const existingStore = await Store.findOne({ seller: seller._id });
  if (!existingStore) {
    await Store.create({
      seller: seller._id,
      storeName: 'Rozare Play Review Store',
      storeSlug: 'rozare-play-review-store',
      description: 'A private reviewer-ready store account used to verify Rozare seller features.',
      visibility: { mode: 'global', label: 'Visible globally' },
      isActive: true,
    });
  }
  await initializeSubscription(seller._id);

  // Never print passwords or connection details. This output is safe for CI
  // and confirms only the identities that were provisioned.
  console.log(JSON.stringify({
    ok: true,
    buyer: { id: String(buyer._id), email: buyer.email, role: buyer.role },
    seller: { id: String(seller._id), email: seller.email, role: seller.role },
    passwordsRotated: rotatePasswords,
  }, null, 2));
}

run()
  .catch(error => {
    console.error(`Reviewer provisioning failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
