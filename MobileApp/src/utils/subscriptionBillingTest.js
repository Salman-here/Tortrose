// Shared public presentation/consent validation for web and native clients.
export function inspectBillingTest(value) {
  if (value === null || value === undefined) return null;
  const start=Date.parse(value.startsAt),end=Date.parse(value.expiresAt);
  if (!/^[a-f\d]{32}$/.test(value.id||'') || !Number.isFinite(start) || !Number.isFinite(end)
    || end<=start || end-start>7200000 || value.amountMinor!==100 || value.currency!=='USD'
    || value.starterIntroMinutes!==10 || value.eliteIntroMinutes!==15 || value.renewalMinutes!==20) {
    throw Error('The temporary billing schedule could not be verified. Refresh before subscribing.');
  }
  return value;
}
export const validBillingTest=value=>{try{inspectBillingTest(value);return true;}catch{return false;}};
export const validBillingTestQuote=quote=>validBillingTest(quote?.billingTest) && (!quote?.billingTest
  || quote.monthlyAmountMinor===100 && Number.isSafeInteger(quote.dueNowMinor) && quote.dueNowMinor>=0 && quote.dueNowMinor<=100);
export const billingTestAuthorization=quote=>{const test=inspectBillingTest(quote?.billingTest);return test?{billingTestId:test.id}:{};};
export const formatBillingTime=value=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
export const billingTestNotice=test=>{inspectBillingTest(test);return `Temporary LIVE billing test: Starter and Elite cost $1 per 20-minute cycle, including any selected Meta Ads add-on. The first charge follows 10 free minutes on Starter or 15 on Elite when eligible. Test charges stop at ${formatBillingTime(test.expiresAt)}. Founder coupons are not used during this test. This is real Safepay billing.`;};
export const billingCardTestTerms=test=>{inspectBillingTest(test);return `Authorize this card for the existing $1 USD-per-20-minute test agreement until ${formatBillingTime(test.expiresAt)}. Changing the card does not collect a payment or change the renewal date.`;};
