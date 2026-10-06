'use strict';
// Read-only evidence for authorised disposable QA accounts. No data migration.
const dns = require('node:dns');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const id = value => String(value?._id || value || '');
async function main() {
  if (!process.env.MONGO_URI) throw new Error('QA_DATABASE_NOT_CONFIGURED');
  const reference = process.argv.slice(2).find(arg => arg !== '--summary');
  if (reference && !/^[a-f0-9]{24}$/i.test(reference)) throw new Error('QA_ORDER_REQUIRED');
  dns.setServers(['1.1.1.1','8.8.8.8']);
  await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:10000});
  const User = require('../models/User'), Order = require('../models/Order');
  const buyer = await User.findOne({email:'rozare-safepay-buyer-20260925@mailinator.com'}).select('_id email').lean();
  if (!buyer) throw new Error('QA_BUYER_REQUIRED');
  const sellers = await User.find({email:{$in:['rozare-safepay-seller-20260925@mailinator.com','rozare.seller.82904@mailinator.com']}}).select('_id email').lean();
  const orders = reference ? [await Order.findOne({_id:reference,user:buyer._id}).lean()]
    : await Order.find({user:buyer._id}).sort({createdAt:-1}).limit(6).lean();
  if (orders.some(order=>!order || order.orderItems.some(item=>!sellers.some(seller=>id(seller)===id(item.seller))))) throw new Error('QA_OWNERSHIP_REQUIRED');
  const rows=[];
  for(const order of orders){
    const payment = order.safepayPaymentId ? await require('../models/SafepayPayment').findById(order.safepayPaymentId)
      .select('_id tracker environment currency amountMinor capturedMinor refundedMinor walletRefundMinor status riskPending appliedAt lastErrorCode').lean() : null;
    const cancellations=await require('../models/OrderCancellation').find({order:order._id})
      .select('_id seller currency amountMinor refundAmountMinor deductionMinor policyVersion refundStatus refundDestination refundedAt lastErrorCode').lean();
    const credits=await require('../models/WalletTransaction').find({user:buyer._id,referenceType:'order_cancellation',referenceId:{$in:cancellations.map(id)}})
      .select('_id type status amount currency balanceAfter safepayPaymentId metadata').lean();
    const notifications=await require('../models/NotificationOutbox').find({aggregateId:{$in:cancellations.map(id)}})
      .select('eventType channel recipient.audienceRole status money deliveredAt lastErrorCode').lean();
    const products=await require('../models/Product').find({_id:{$in:order.orderItems.map(item=>item.productId)}}).select('_id name stock totalSales').lean();
    rows.push({order:{_id:order._id,orderId:order.orderId,currency:order.currency,paymentMethod:order.paymentMethod,isPaid:order.isPaid,
      orderStatus:order.orderStatus,orderSummary:order.orderSummary,onlineFeeSnapshot:order.onlineFeeSnapshot,sellerCurrencyMoney:order.sellerCurrencyMoney,
      sellerFulfillment:order.sellerFulfillment,createdAt:order.createdAt},payment,cancellations,credits,products,notifications});
  }
  const summaries=[];
  for(const seller of sellers){
    const store=await require('../models/Store').findOne({seller:seller._id}).select('storeName productCurrency').lean();
    const summary=await require('../services/sellerNativeAccountingService').buildNativeSellerPaymentSummary(seller._id,{displayCurrency:store.productCurrency});
    summaries.push({email:seller.email,store:store.storeName,currency:store.productCurrency,revenue:summary.revenue,balances:summary.balances});
  }
  const wallet=await require('../models/Wallet').findOne({user:buyer._id}).select('balances status').lean();
  const result = process.argv.includes('--summary') ? {
    rows:rows.map(row=>({...row,notifications:row.notifications.reduce((counts,event)=>{
      const key=event.channel+':'+event.status;counts[key]=(counts[key]||0)+1;return counts;},{}),
      credits:row.credits.map(tx=>({_id:tx._id,amount:tx.amount,currency:tx.currency,status:tx.status,balanceAfter:tx.balanceAfter,
        cardRefundFunding:tx.metadata?.cardRefundFunding,fundingRemainingMinor:tx.metadata?.fundingRemainingMinor}))})),
    wallet,sellerSummaries:summaries.map(row=>({...row,balances:undefined})),
  } : {rows,wallet,sellerSummaries:summaries};
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(JSON.stringify({error:error.code||error.message||'QA_AUDIT_FAILED'}));process.exitCode=1;}).finally(()=>mongoose.disconnect());
