import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBalancesAreValid, WITHDRAWAL_MINIMUMS } from '../src/utils/nativeBalanceSafety.js';
import { readFileSync } from 'node:fs';

const response = () => {
  const balances = Object.keys(WITHDRAWAL_MINIMUMS).map(currency => ({ currency, withdrawableBalance: currency === 'PKR' ? 2800 : 0,
    onlineDeliveredRevenue: currency === 'PKR' ? 2800 : 0, onlinePendingRevenue: 0, pendingWithdrawalAmount: 0,
    approvedWithdrawalAmount: 0, processingWithdrawalAmount: 0, manualReviewWithdrawalAmount: 0,
    totalWithdrawn: 0, totalReservedOrWithdrawn: 0, balanceAdjustmentCredits: 0, returnRefundDebits: 0, paymentReversalDebits: 0, deficit: 0, paymentRiskHeldAmount: 0,
    minimumWithdrawal: WITHDRAWAL_MINIMUMS[currency] }));
  return { accountingVersion: 2, displayCurrency: 'USD', balances, balanceByCurrency: Object.fromEntries(balances.map(b => [b.currency, { ...b }])),
    withdrawalLimits: { currency: 'USD', availableDisplayAmount: 0, minimumDisplayAmount: 5 } };
};
test('accepts separate native balances without converting old PKR to current store USD', () => {
  const r=response(); assert.equal(nativeBalancesAreValid(r),true);
  assert.equal(r.balanceByCurrency.USD.withdrawableBalance,0);
  assert.equal(r.balanceByCurrency.PKR.withdrawableBalance,2800);
});
test('rejects relabelled, duplicated, incomplete, inexact and inconsistent balance authorities', () => {
  for(const mutate of [r=>r.accountingVersion=1,r=>r.balances.pop(),r=>r.balances[1].currency='USD',r=>r.balances[1].withdrawableBalance=1.001,
    r=>r.balances[1].minimumWithdrawal=1900,r=>r.balanceByCurrency.PKR.withdrawableBalance=3000,
    r=>{r.balances[1].withdrawableBalance=2801;r.balanceByCurrency.PKR.withdrawableBalance=2801},
    r=>r.withdrawalLimits.availableDisplayAmount=10,r=>r.withdrawalLimits.currency='PKR']) {
    const r=response();mutate(r);assert.equal(nativeBalancesAreValid(r),false);
  }
});
test('web and mobile share native balance validation and fixed minima', () => {
  assert.equal(readFileSync(new URL('../src/utils/nativeBalanceSafety.js',import.meta.url),'utf8'),readFileSync(new URL('../../MobileApp/src/utils/nativeBalanceSafety.js',import.meta.url),'utf8'));
  assert.deepEqual(WITHDRAWAL_MINIMUMS,{USD:5,PKR:2000,EUR:5,GBP:5});
});
test('withdrawal labels, limits, submitted currency and amount use the chosen native bucket', () => {
  const web=readFileSync(new URL('../src/components/layout/SellerPayments.jsx',import.meta.url),'utf8');
  const mobile=readFileSync(new URL('../../MobileApp/src/screens/seller/SellerPaymentsScreen.js',import.meta.url),'utf8');
  for(const source of [web,mobile]){
    assert.match(source,/currency: balanceCurrency/);assert.match(source,/Amount in \{balanceCurrency\}/);
    assert.match(source,/selectedBalance\?\.withdrawableBalance/);assert.match(source,/selectedBalance\?\.minimumWithdrawal/);
    assert.match(source,/paymentAccount\.currency !== balanceCurrency/);assert.match(source,/Withdrawal balance currency/);
  }
});
