import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminPaymentsOverviewIsValid, selectAdminWithdrawalPresentationMoney, REVENUE_MONEY_FIELDS, REVENUE_COUNT_FIELDS } from '../src/utils/adminPaymentsSafety.js';

const codes=['USD','PKR','EUR','GBP'];
const empty=currency=>({...Object.fromEntries([...REVENUE_MONEY_FIELDS,...REVENUE_COUNT_FIELDS].map(key=>[key,0])),currency,balanceAdjustmentCredits:0,deficit:0,minimumWithdrawal:currency==='PKR'?2000:5});
const legacy=()=>({_id:'legacy-request',currency:'USD',amount:200,requestedAmount:55636,requestedCurrency:'PKR',status:'pending',payoutWorkflowVersion:0,payoutWorkflow:{version:0,attemptCount:0},payoutAttempts:[],paymentAccountSnapshotVersion:0,paymentAccountSnapshot:{snapshotStatus:'missing',payoutBlocked:true}});

test('legacy requests keep their original units and missing payout terms remain unavailable',()=>{
  const value=selectAdminWithdrawalPresentationMoney(legacy());
  assert.deepEqual(value.ledger,{amount:200,currency:'USD'});
  assert.deepEqual(value.requested,{amount:55636,currency:'PKR'});
  assert.equal(value.payout,null); assert.equal(value.payoutBlocked,true);
});

test('native admin data accepts historical USD reporting beside an original PKR hold',()=>{
  const balances=codes.map(empty);
  Object.assign(balances[1],{stripeDeliveredRevenue:28000,onlineDeliveredRevenue:28000,totalDeliveredRevenue:28000,estimatedRevenue:28000,paymentRiskHeldAmount:28000,deliveredStripeOrders:1,totalRelevantOrders:1});
  const revenue={...empty('USD'),stripeDeliveredRevenue:100,onlineDeliveredRevenue:100,totalDeliveredRevenue:100,estimatedRevenue:100,deliveredStripeOrders:1,totalRelevantOrders:1};
  const overview={success:true,accountingVersion:2,summaryByCurrency:Object.fromEntries(balances.map(balance=>[balance.currency,{...balance}])),sellers:[{seller:{_id:'seller-native',currency:'USD'},revenue,balances,paymentRiskPending:true,paymentRiskHoldCount:1}],withdrawals:[legacy()],errors:[{sellerId:'unverifiable',message:'Missing historical rates'}]};
  assert.equal(adminPaymentsOverviewIsValid(overview),true);
  assert.equal(overview.summaryByCurrency.PKR.paymentRiskHeldAmount,28000);
  assert.equal(overview.summaryByCurrency.USD.paymentRiskHeldAmount,0);
});

test('admin screen selects native totals and labels each hold/deficit in its actual currency',()=>{
  const source=readFileSync(new URL('../src/components/layout/AdminPayments.jsx',import.meta.url),'utf8');
  assert.match(source,/res\.data\?\.accountingVersion !== 2/);
  assert.match(source,/aria-label="Admin summary currency"/);
  assert.match(source,/data\.summaryByCurrency\[summaryCurrency\]/);
  assert.match(source,/amountCurrency = summaryCurrency/);
  assert.match(source,/formatLedgerAmount\(balance\.paymentRiskHeldAmount, balance\.currency\)/);
  assert.match(source,/formatLedgerAmount\(balance\.deficit, balance\.currency\)/);
  assert.doesNotMatch(source,/Canonical ledger totals remain shown in USD/);
});
