'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
require('dns').setServers(['1.1.1.1','8.8.8.8']);
const mongoose = require('../Backend/node_modules/mongoose');
require('../Backend/node_modules/dotenv').config({path:path.resolve(__dirname,'../Backend/.env'),quiet:true});
mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
(async()=>{
  await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000});
  const {buildAdminPaymentsOverviewData}=require('../Backend/controllers/PaymentController');
  const front=await import(pathToFileURL(path.resolve(__dirname,'../Frontend/src/utils/adminPaymentsSafety.js')));
  const native=await import(pathToFileURL(path.resolve(__dirname,'../Frontend/src/utils/nativeBalanceSafety.js')));
  const money=await import(pathToFileURL(path.resolve(__dirname,'../Frontend/src/utils/sellerMoneySafety.js')));
  const data=JSON.parse(JSON.stringify({success:true,...await buildAdminPaymentsOverviewData()}));
  const checkRevenue=r=>({missingMoney:front.REVENUE_MONEY_FIELDS.filter(f=>!money.isExactNonNegativeJsonMoney(r?.[f])),badCounts:front.REVENUE_COUNT_FIELDS.filter(f=>!Number.isSafeInteger(r?.[f])||r[f]<0)});
  const invalidRows=data.sellers.flatMap(row=>{
    const map=Object.fromEntries(row.balances.map(b=>[b.currency,b]));const current=map[row.seller.currency];
    const valid=native.nativeBalancesAreValid({accountingVersion:2,balances:row.balances,balanceByCurrency:map,displayCurrency:row.seller.currency,withdrawalLimits:{currency:row.seller.currency,minimumDisplayAmount:current?.minimumWithdrawal,availableDisplayAmount:current?.withdrawableBalance}});
    const revenue=checkRevenue(row.revenue);const buckets=row.balances.map(b=>({currency:b.currency,...checkRevenue(b)})).filter(b=>b.missingMoney.length||b.badCounts.length);
    return valid&&!revenue.missingMoney.length&&!revenue.badCounts.length&&!buckets.length?[]:[{sellerId:row.seller._id,currency:row.seller.currency,nativeValid:valid,revenue,buckets}];
  });
  console.log(JSON.stringify({valid:front.adminPaymentsOverviewIsValid(data),sellerCount:data.sellers.length,errors:data.errors,invalidRows,
    summaries:Object.entries(data.summaryByCurrency).map(([currency,r])=>({currency,...checkRevenue(r)})),
    withdrawals:data.withdrawals.filter(w=>!front.selectAdminWithdrawalPresentationMoney(w)).map(w=>({id:w._id,balanceVersion:w.balanceVersion,currency:w.currency,amount:w.amount,minimumAmount:w.minimumAmount,requestedAmount:w.requestedAmount,requestedCurrency:w.requestedCurrency,payoutAmount:w.payoutAmount,payoutCurrency:w.payoutCurrency,status:w.status,workflowVersion:w.payoutWorkflowVersion,workflow:w.payoutWorkflow,snapshotVersion:w.paymentAccountSnapshotVersion,snapshotStatus:w.paymentAccountSnapshot?.snapshotStatus,payoutBlocked:w.paymentAccountSnapshot?.payoutBlocked}))},null,2));
})().catch(e=>{console.error('Read-only admin diagnostic failed:',e.code||e.name);process.exitCode=1;}).finally(()=>mongoose.disconnect());
