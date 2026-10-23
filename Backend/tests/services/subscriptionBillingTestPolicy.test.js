'use strict';
const policy=require('../../services/subscriptionBillingTestPolicy');
const clocks=require('../../services/subscriptionBillingTestClockService');
const pricing=require('../../services/subscriptionPricingService');
const start=new Date('2026-10-23T10:00:00Z'),end=new Date('2026-10-23T12:00:00Z');
const raw=JSON.stringify({startsAt:start.toISOString(),expiresAt:end.toISOString()});
const old=process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
afterEach(()=>{jest.useRealTimers();if(old===undefined)delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;else process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW=old;});
const window=()=>policy.readWindow({SAFEPAY_SUBSCRIPTION_TEST_WINDOW:raw},start);
const subscription=(plan='starter',status='free_period')=>({billingProvider:'safepay',plan,status,metaAdsIncluded:false,cancelledAt:null,
 currentPeriodStart:start,currentPeriodEnd:new Date('2026-11-23T10:00:00Z'),freePeriodEndDate:new Date('2026-11-23T10:00:00Z'),
 safepayBilling:{autoRenew:true,contractId:'owned-contract',cardId:'owned-card',consentVersion:'rozare-safepay-recurring-v1',consentedAt:start,
 monthlyMinor:999,creditMinor:57,anchorAt:new Date('2026-11-23T10:00:00Z'),cycle:0,nextChargeAt:new Date('2026-11-23T10:00:00Z'),version:1}});

test('the QA window is explicit, globally scoped, bounded to two hours and off at the exact cutoff',()=>{
 expect(policy.readWindow({})).toBeNull();expect(window()).toMatchObject({amountMinor:100,renewalMinutes:20});
 expect(policy.readWindow({SAFEPAY_SUBSCRIPTION_TEST_WINDOW:raw},new Date(start-1))).toBeNull();
 expect(policy.readWindow({SAFEPAY_SUBSCRIPTION_TEST_WINDOW:raw},end)).toBeNull();
 for(const value of ['invalid','{}',JSON.stringify({startsAt:start,expiresAt:new Date(end.getTime()+1)})])expect(()=>policy.readWindow({SAFEPAY_SUBSCRIPTION_TEST_WINDOW:value},start)).toThrow();
});
test.each(['starter','elite'])('%s quotes exactly $1, even with founder pricing or Meta Ads, and preserves normal catalog definitions',plan=>{
 jest.useFakeTimers().setSystemTime(start);process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW=raw;
 for(const founder of [true,false])expect(pricing.buildPlanPricing(plan,plan==='elite',founder,{ignoreTest:false})).toMatchObject({unitAmount:100,metaAddOn:0});
 const catalog=pricing.getPricingCatalog();expect(catalog[plan]).toMatchObject({standardAmountCents:100,founderAmountCents:100,advertisedDiscountPercent:0});
 expect(catalog.metaAdsAddonCents).toBe(0);
 expect(catalog.normalPricing.starter.standardAmountCents).toBe(999);expect(catalog.normalPricing.elite.standardAmountCents).toBe(2165);
 expect(pricing.buildPlanPricing(plan,false,false,{ignoreTest:true}).unitAmount).toBe(plan==='starter'?999:2165);
 expect(pricing.buildPlanPricing(plan,false,false).unitAmount).toBe(plan==='starter'?999:2165);
 jest.setSystemTime(end);expect(pricing.getPricingCatalog().billingTest).toBeUndefined();
});
test.each([['starter',10],['elite',15]])('existing %s intro adoption starts %i minutes forward, never from an old registration', (plan,minutes)=>{
 const sub=subscription(plan);expect(clocks.adopt(sub,window(),start)).toBe(true);
 expect(sub.currentPeriodEnd.getTime()-start.getTime()).toBe(minutes*60000);expect(sub.safepayBilling.monthlyMinor).toBe(100);
 expect(sub.safepayBilling.testClock.original.billing.monthlyMinor).toBe(999);expect(clocks.adopt(sub,window(),start)).toBe(false);
 expect(sub.safepayBilling.creditMinor).toBe(57);
});
test('existing active plans first renew 20 minutes forward; ended, held and in-flight agreements are never revived',()=>{
 const sub=subscription('elite','active');expect(clocks.adopt(sub,window(),start)).toBe(true);expect(sub.currentPeriodEnd-start).toBe(20*60000);
 for(const change of [{status:'blocked'},{cancelledAt:start},{paymentRisk:{suspended:true}},{safepayBilling:{...subscription().safepayBilling,pendingOperation:'owned-operation'}},
  {safepayBilling:{...subscription().safepayBilling,autoRenew:false}},{billingProvider:'stripe'}])expect(clocks.adopt({...subscription(),...change},window(),start)).toBe(false);
});
test('cycles are 20 minutes apart, late cycles are not bunched, and malformed stamps fail closed',()=>{
 const stamp=window();expect(policy.period({anchorAt:start,cycle:1,now:new Date(start.getTime()+20*60000),stamp})).toMatchObject({due:true,missed:false});
 expect(policy.period({anchorAt:start,cycle:1,now:new Date(start.getTime()+40*60000),stamp})).toMatchObject({due:false,missed:true});
 for(const change of [{amountMinor:101},{renewalMinutes:1},{id:'invalid'},{currency:'PKR'}])expect(()=>policy.boundary(start,1,{...stamp,...change})).toThrow();
});
test('cutoff restores the exact older agreement, but never revives a cancellation or collects an overdue old period',()=>{
 const sub=subscription();clocks.adopt(sub,window(),start);delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
 expect(clocks.stop(sub,end)).toBe(true);expect(sub.safepayBilling.monthlyMinor).toBe(999);expect(sub.currentPeriodEnd.toISOString()).toBe('2026-11-23T10:00:00.000Z');
 expect(sub.safepayBilling.autoRenew).toBe(true);expect(clocks.stop(sub,end)).toBe(false);
 const cancelled=subscription();clocks.adopt(cancelled,window(),start);cancelled.cancelledAt=new Date(start.getTime()+60000);cancelled.safepayBilling.autoRenew=false;
 clocks.stop(cancelled,end);expect(cancelled.safepayBilling.autoRenew).toBe(false);expect(cancelled.cancelledAt.toISOString()).toBe('2026-10-23T10:01:00.000Z');
});
test('new test agreements pause at cutoff without a silent higher monthly charge; in-flight work is not re-authorized',()=>{
 const sub=subscription();sub.safepayBilling.testClock={...window(),origin:'enrollment'};
 clocks.stop(sub,end);expect(sub.safepayBilling.autoRenew).toBe(false);expect(sub.safepayBilling.nextChargeAt).toBeNull();
 const pending=subscription();clocks.adopt(pending,window(),start);pending.safepayBilling.pendingOperation='owned-operation';
 clocks.stop(pending,end);expect(pending.safepayBilling.testClock.restoreBlockedByInFlight).toBe(true);
 pending.safepayBilling.pendingOperation=null;clocks.stop(pending,end);expect(pending.safepayBilling.autoRenew).toBe(false);
});
