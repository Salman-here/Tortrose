'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber');
const User = require('../../models/User');
const WhatsAppOTP = require('../../models/WhatsAppOTP');
const { consumeVerifiedWhatsAppNumber } = require('../../controllers/sellerWhatsappController');
const { runInTransaction } = require('../../services/walletService');

let replicaSet;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
  await Promise.all([
    AdminWhatsAppNumber.init(),
    User.init(),
    WhatsAppOTP.init(),
  ]);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

beforeEach(async () => {
  await Promise.all([
    AdminWhatsAppNumber.deleteMany({}),
    User.deleteMany({}),
    WhatsAppOTP.deleteMany({}),
  ]);
});

test('verified seller WhatsApp proof rolls back with a failed onboarding transaction', async () => {
  const number = '923001234567';
  await WhatsAppOTP.create({
    number,
    otp: '123456',
    verified: true,
    verifiedAt: new Date(),
  });

  await expect(runInTransaction(async session => {
    await expect(consumeVerifiedWhatsAppNumber(`+${number}`, null, { session })).resolves.toBe(true);
    throw new Error('simulate store/outbox failure');
  })).rejects.toThrow('simulate store/outbox failure');

  expect(await WhatsAppOTP.countDocuments({ number, verified: true })).toBe(1);

  await expect(runInTransaction(session => (
    consumeVerifiedWhatsAppNumber(`+${number}`, null, { session })
  ))).resolves.toBe(true);
  expect(await WhatsAppOTP.countDocuments({ number })).toBe(0);
});
