'use strict';
// Read-only evidence for the one named buyer's earlier mixed QA purchase.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
async function main() {
  const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  require('node:dns').setServers(['1.1.1.1', '8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  const buyer = await require('../models/User').findOne({ email: 'rozare-safepay-buyer-20260925@mailinator.com' }).select('_id').lean();
  const seller = await require('../models/User').findOne({ email: 'rozare-safepay-seller-20260925@mailinator.com' }).select('_id').lean();
  const order = buyer && await require('../models/Order').findOne({ _id: '6ac689d5aa0ee55b9c02764a', user: buyer._id,
    paymentMethod: 'safepay', safepayEnvironment: 'sandbox' }).lean();
  if (!order || !seller) throw new Error('QA_SCOPE_REQUIRED');
  const payment = await require('../models/SafepayPayment').findOne({ _id: order.safepayPaymentId, user: buyer._id, environment: 'sandbox' }).lean();
  const tracker = await require('../services/safepayClient').createSafepayClient({ config }).getTracker(payment.tracker, payment);
  const wallet = await require('../models/Wallet').findOne({ user: buyer._id }).select('balances').lean();
  const summary = await require('../services/sellerNativeAccountingService').buildNativeSellerPaymentSummary(seller._id, { displayCurrency: 'PKR' });
  const product = await require('../models/Product').findById('6ab76c69f1585bb3833af7d9').select('stock totalSales').lean();
  const cancellations = await require('../models/OrderCancellation').find({ order: order._id }).lean();
  console.log(JSON.stringify({ sandbox: true, orderId: order.orderId, orderCurrency: order.currency, originalSummary: order.orderSummary,
    fulfillment: order.sellerFulfillment.map(row => ({ seller: String(row.seller), status: row.status, cancellation: row.cancellation || null })),
    payment: { id: String(payment._id), status: payment.status, capturedMinor: payment.capturedMinor,
      refundedMinor: payment.refundedMinor, walletRefundMinor: payment.walletRefundMinor, riskPending: payment.riskPending,
      providerState: tracker.state, quote: tracker.purchase_totals?.quote_amount,
      capture: tracker.charge?.capture?.totals, remaining: tracker.charge?.balance },
    cancellations: cancellations.map(row => ({ id: String(row._id), seller: String(row.seller), currency: row.currency,
      grossMinor: row.amountMinor, refundMinor: row.refundAmountMinor, deductionMinor: row.deductionMinor,
      destination: row.refundDestination, status: row.refundStatus, refundedAt: row.refundedAt })),
    buyerWallet: wallet?.balances, qaProduct: product,
    qaSeller: { gross: summary.revenue.onlineGrossEarnings, fee: summary.revenue.processingFeeAndTax,
      pendingNet: summary.revenue.pendingOnlineNetBalance, available: summary.revenue.withdrawableBalance,
      reportingEstimate: summary.displayRevenue.estimatedRevenue } }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message || 'QA_AUDIT_FAILED'); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
