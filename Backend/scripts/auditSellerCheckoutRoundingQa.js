'use strict';

// Read-only evidence for the explicitly authorised disposable Sandbox accounts.
// Never emits credentials, card identifiers, contact fields or checkout URLs.
const dns = require('node:dns');
const mongoose = require('mongoose');
require('dotenv').config({ quiet:true });
const id = value => String(value?._id || value || '');
const sellerEmails = ['rozare-safepay-seller-20260925@mailinator.com','rozare.seller.82901@mailinator.com','rozare.seller.82904@mailinator.com'];

async function main() {
  const config = require('../config/safepay').readSafepayConfig(process.env,{ requireWebhook:true });
  if (config.environment !== 'sandbox') throw new Error('SANDBOX_REQUIRED');
  const settings = { environment:config.environment,webEnabled:process.env.SAFEPAY_WEB_ENABLED === 'true',
    mobileEnabled:process.env.SAFEPAY_MOBILE_ENABLED === 'true',stripeEnabled:process.env.STRIPE_ENABLED === 'true' };
  if (process.argv.includes('--config-only')) { console.log(JSON.stringify(settings)); return; }
  const reference = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (reference && !/^[a-f0-9]{24}$/i.test(reference)) throw new Error('QA_ORDER_ID_REQUIRED');
  dns.setServers(['1.1.1.1','8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI,{ autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000 });
  const User = require('../models/User'), Order = require('../models/Order');
  const buyer = await User.findOne({ email:'rozare-safepay-buyer-20260925@mailinator.com' }).select('_id').lean();
  const sellers = await User.find({ email:{ $in:sellerEmails } }).select('_id email').lean();
  if (!buyer || sellers.length !== sellerEmails.length) throw new Error('QA_ACCOUNTS_REQUIRED');
  const orders = await Order.find({ user:buyer._id,...(reference ? { _id:reference } : { sellerCurrencyMoneyVersion:2 }) }).sort({ createdAt:-1 }).limit(12).lean();
  if (reference && !orders.length) throw new Error('QA_ORDER_NOT_FOUND');
  const rows = [];
  for (const order of orders) {
    if (order.orderItems.some(item => !sellers.some(seller => id(seller) === id(item.seller)))) throw new Error('QA_SELLER_SCOPE_REQUIRED');
    const native = require('../services/orderMoneyService').getFrozenSellerCurrencyMoney(order);
    const payment = order.safepayPaymentId ? await require('../models/SafepayPayment').findById(order.safepayPaymentId).lean() : null;
    if (payment && payment.environment !== 'sandbox') throw new Error('SANDBOX_PAYMENT_REQUIRED');
    let provider = null;
    if (payment?.tracker && process.argv.includes('--provider')) {
      const tracker = await require('../services/safepayClient').createSafepayClient({ config }).getTracker(payment.tracker,payment);
      provider = { state:tracker.state,environment:tracker.environment,currency:tracker.purchase_totals?.quote_amount?.currency,
        amountMinor:tracker.purchase_totals?.quote_amount?.amount };
    }
    const cancellations = await require('../models/OrderCancellation').find({ order:order._id })
      .select('seller currency amountMinor refundAmountMinor deductionMinor refundStatus refundDestination').lean();
    const returns = await require('../models/ReturnRequest').find({ order:order._id })
      .select('seller currency status refund settlement.fundingSource settlement.status settlement.funded settlement.safepayPaymentId').lean();
    const returnIds = returns.map(entry => id(entry));
    const returnDebits = await require('../models/SellerBalanceTransaction').find({ order:order._id,type:'return_refund' })
      .select('seller referenceId sourceAmount sourceCurrency amountUSD status metadata.nativeFundingVersion metadata.nativeCurrency metadata.nativeDebitMinor').lean();
    const returnCredits = await require('../models/WalletTransaction').find({ user:buyer._id,referenceType:'return_request',referenceId:{ $in:returnIds } })
      .select('referenceId amount currency direction status').lean();
    const returnPayments = [];
    for (const entry of returns.filter(entry => entry.settlement?.safepayPaymentId)) {
      const funding = await require('../models/SafepayPayment').findById(entry.settlement.safepayPaymentId).lean();
      if (!funding || funding.environment !== 'sandbox' || id(funding.user) !== id(entry.seller)) throw new Error('QA_RETURN_PAYMENT_BINDING_REQUIRED');
      let providerState = null;
      if (process.argv.includes('--provider')) {
        const tracker = await require('../services/safepayClient').createSafepayClient({ config }).getTracker(funding.tracker,funding);
        providerState = { state:tracker.state,currency:tracker.purchase_totals?.quote_amount?.currency,amountMinor:tracker.purchase_totals?.quote_amount?.amount };
      }
      returnPayments.push({ returnId:id(entry),status:funding.status,purpose:funding.purpose,currency:funding.currency,
        amountMinor:funding.amountMinor,capturedMinor:funding.capturedMinor,provider:providerState });
    }
    const products = await require('../models/Product').find({ _id:{ $in:order.orderItems.map(item => item.productId) } }).select('_id name stock totalSales').lean();
    rows.push({ orderId:order.orderId,id:order._id,currency:order.currency,paymentMethod:order.paymentMethod,
      isPaid:order.isPaid,awaitingPayment:order.awaitingPayment,orderStatus:order.orderStatus,summary:order.orderSummary,
      rates:order.exchangeRateSnapshot?.rates,capturedAt:order.exchangeRateSnapshot?.capturedAt,
      items:order.orderItems.map(item => ({ productId:item.productId,seller:item.seller,quantity:item.quantity,lineSubtotal:item.lineSubtotal,
        sourceLineSubtotal:item.sourceLineSubtotal,sourceCurrency:item.sourceCurrency,selectedOptions:item.selectedOptions })),
      native,sellerFulfillment:order.sellerFulfillment,rounding:order.checkoutRoundingSnapshot,
      fee:order.onlineFeeSnapshot,products,cancellations,returns,returnDebits,returnCredits,returnPayments,
      payment:payment ? { status:payment.status,currency:payment.currency,amountMinor:payment.amountMinor,capturedMinor:payment.capturedMinor,
        refundedMinor:payment.refundedMinor,walletRefundMinor:payment.walletRefundMinor,riskPending:payment.riskPending,lastErrorCode:payment.lastErrorCode } : null,provider });
  }
  const sellerSummaries = [];
  const balanceFields = ['currency','onlineGrossEarnings','processingFeeAndTax','pendingOnlineNetBalance','returnWindowHeldAmount',
    'withdrawableBalance','totalWithdrawn','returnRefundDebits','codDeliveredRevenue','codPendingRevenue','paymentReversalDebits','paymentRiskHeldAmount'];
  const presentBalance = balance => Object.fromEntries(balanceFields.map(field => [field,balance[field]]));
  for (const seller of sellers) {
    const store = await require('../models/Store').findOne({ seller:seller._id }).select('storeName productCurrency').lean();
    const summary = await require('../services/sellerNativeAccountingService').buildNativeSellerPaymentSummary(seller._id,{ displayCurrency:store.productCurrency });
    sellerSummaries.push({ seller:id(seller),store:store.storeName,currency:store.productCurrency,revenue:presentBalance(summary.revenue),
      balances:summary.balances.filter(balance => balance.currency === store.productCurrency || balance.onlineGrossEarnings || balance.withdrawableBalance).map(presentBalance) });
  }
  const wallet = await require('../models/Wallet').findOne({ user:buyer._id }).select('balances status').lean();
  const evidenceRows = process.argv.includes('--brief') ? rows.map(row => ({
    id:row.id,orderId:row.orderId,currency:row.currency,paymentMethod:row.paymentMethod,isPaid:row.isPaid,status:row.orderStatus,total:row.summary.totalAmount,
    native:row.native.map(entry => ({ seller:entry.seller,currency:entry.currency,grossMinor:entry.totalMinor,buyerMinor:entry.buyerTotalMinor,adjustmentMinor:entry.adjustmentMinor })),
    feeMinor:row.fee?.feeMinor,collector:row.rounding?.collector,fulfillments:row.sellerFulfillment.map(entry => ({ seller:entry.seller,status:entry.status })),
    rates:row.rates,cancellations:row.cancellations,returns:row.returns,returnDebits:row.returnDebits,returnCredits:row.returnCredits,returnPayments:row.returnPayments,payment:row.payment,provider:row.provider,
  })) : rows;
  console.log(JSON.stringify({ settings,rows:evidenceRows,wallet,sellerSummaries },null,2));
}
main().catch(error => { console.error(JSON.stringify({ error:error.code || error.name || 'QA_AUDIT_FAILED' }));process.exitCode=1; })
  .finally(() => mongoose.disconnect());
