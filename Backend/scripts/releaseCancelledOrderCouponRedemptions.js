'use strict';

const mongoose = require('mongoose');
const CouponRedemption = require('../models/CouponRedemption');
const Order = require('../models/Order');
const { releaseOrderCouponsInSession } = require('../services/couponUsageService');

const write = process.argv.includes('--write');
const migrationReason = 'Backfill released capacity for a cancelled unpaid order.';

const databaseUrl = () => (
  process.env.MONGO_URI
  || process.env.MONGODB_URI
  || process.env.DATABASE_URL
  || ''
);

async function findCandidateOrders() {
  const consumedOrderIds = await CouponRedemption.distinct('order', { status: 'consumed' });
  if (!consumedOrderIds.length) return [];
  return Order.find({
    _id: { $in: consumedOrderIds },
    orderStatus: 'cancelled',
    isPaid: false,
  })
    .select('_id orderId currency createdAt')
    .sort({ _id: 1 })
    .lean();
}

async function releaseCandidate(orderId) {
  let released = 0;
  await mongoose.connection.transaction(async session => {
    const order = await Order.findOne({
      _id: orderId,
      orderStatus: 'cancelled',
      isPaid: false,
    }).session(session);
    if (!order) return;
    released = await releaseOrderCouponsInSession(
      order,
      session,
      migrationReason,
      new Date(),
      { includeConsumed: true },
    );
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  return released;
}

async function main() {
  const uri = databaseUrl();
  if (!uri) throw new Error('A MongoDB connection URL is required.');
  await mongoose.connect(uri);
  const candidates = await findCandidateOrders();
  console.log(JSON.stringify({
    mode: write ? 'write' : 'dry-run',
    candidateOrders: candidates.length,
    orders: candidates.map(order => ({
      id: String(order._id),
      orderId: order.orderId,
      currency: order.currency,
      createdAt: order.createdAt,
    })),
  }, null, 2));

  if (!write) return;
  let releasedRedemptions = 0;
  for (const candidate of candidates) {
    releasedRedemptions += await releaseCandidate(candidate._id);
  }
  console.log(JSON.stringify({
    mode: 'write-complete',
    processedOrders: candidates.length,
    releasedRedemptions,
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

