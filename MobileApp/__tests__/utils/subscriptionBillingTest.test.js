import {inspectBillingTest,validBillingTest,billingTestAuthorization,billingTestNotice,billingCardTestTerms} from '../../src/utils/subscriptionBillingTest';
const stamp={id:'a'.repeat(32),startsAt:'2026-10-23T10:00:00Z',expiresAt:'2026-10-23T12:00:00Z',amountMinor:100,currency:'USD',starterIntroMinutes:10,eliteIntroMinutes:15,renewalMinutes:20};
test('old normal billing responses remain valid and add no test authority',()=>{
 expect(inspectBillingTest(undefined)).toBeNull();expect(billingTestAuthorization({})).toEqual({});expect(validBillingTest(null)).toBe(true);
});
test('test billing is explicit about real $1 charges, minutes, the cutoff, and zero-charge card changes',()=>{
 expect(inspectBillingTest(stamp)).toBe(stamp);expect(billingTestAuthorization({billingTest:stamp})).toEqual({billingTestId:stamp.id});
 expect(billingTestNotice(stamp)).toMatch(/\$1 per 20-minute/);expect(billingTestNotice(stamp)).toMatch(/real Safepay/);
 expect(billingCardTestTerms(stamp)).toMatch(/does not collect a payment/);
});
test.each([{amountMinor:101},{currency:'PKR'},{renewalMinutes:1},{starterIntroMinutes:30},{eliteIntroMinutes:45},{expiresAt:'2026-10-23T12:00:01Z'},{id:'invalid'}])('corrupt test schedule fails closed: %j',patch=>{
 expect(validBillingTest({...stamp,...patch})).toBe(false);expect(()=>billingTestAuthorization({billingTest:{...stamp,...patch}})).toThrow();
});
