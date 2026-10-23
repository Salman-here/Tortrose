import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {inspectBillingTest,billingTestAuthorization,billingTestNotice} from '../../MobileApp/src/utils/subscriptionBillingTest.js';
import {getSubscriptionPricing} from '../src/utils/subscriptionPricing.js';
const stamp={id:'a'.repeat(32),startsAt:'2026-10-23T10:00:00Z',expiresAt:'2026-10-23T12:00:00Z',amountMinor:100,currency:'USD',starterIntroMinutes:10,eliteIntroMinutes:15,renewalMinutes:20};
const plan=p=>({plan:p,planName:p,listAmountCents:100,standardAmountCents:100,founderAmountCents:100,advertisedDiscountPercent:0,freePeriodDays:p==='starter'?30:45});
test('the website keeps verified global test timing with exact pricing instead of relabelling minutes as months',()=>{
 const pricing={schemaVersion:1,currency:'USD',starter:plan('starter'),elite:plan('elite'),metaAdsAddonCents:0,billingTest:stamp};
 assert.deepEqual(getSubscriptionPricing({pricing}).billingTest,stamp);assert.equal(inspectBillingTest(stamp),stamp);
 assert.match(billingTestNotice(stamp),/real Safepay/);assert.deepEqual(billingTestAuthorization({billingTest:stamp}),{billingTestId:stamp.id});
 for(const patch of [{amountMinor:200},{renewalMinutes:10},{currency:'PKR'},{expiresAt:'invalid'}])assert.equal(getSubscriptionPricing({pricing:{...pricing,billingTest:{...stamp,...patch}}}),null);
});
test('web and native send the explicit test policy ID with both new agreements and card changes',()=>{
 for(const file of ['../src/components/subscription/SafepayBillingReview.jsx','../../MobileApp/src/screens/seller/SellerSubscriptionScreen.js']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');assert.match(source,/billingTestAuthorization\(/);assert.match(source,/billingTestId/);assert.match(source,/billingCardTestTerms/);
 }
});
