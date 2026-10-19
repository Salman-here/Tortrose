import { readFileSync } from 'fs';
import { getSafepayCheckoutNameError, getSafepayBillingFieldErrors, SAFEPAY_BILLING_NAME_MESSAGE } from '../../src/utils/safepayBillingValidation';

const firstCheckout = { paymentMethod: 'card', billingProfileReady: false, selectedCardId: '' };

test.each(['', ' ', 'Salman', '  Salman  ', null, undefined])('requires first and last billing names only for a new Safepay profile: %s', name => {
  expect(getSafepayCheckoutNameError(name, firstCheckout)).toBe(SAFEPAY_BILLING_NAME_MESSAGE);
});

test.each(['Salman Iqbal', '  Élodie   van der Meer  ', 'محمد علی', "Anne-Marie O'Neill", '李 小龍', 'A\nB'])('accepts real Unicode and multipart names without inventing a surname: %s', name => {
  expect(getSafepayCheckoutNameError(name, firstCheckout)).toBeNull();
});

test('matches the backend normalized 160 character limit', () => {
  expect(getSafepayCheckoutNameError('A ' + 'b'.repeat(158), firstCheckout)).toBeNull();
  expect(getSafepayCheckoutNameError('A ' + 'b'.repeat(159), firstCheckout)).toContain('160');
});

test.each([
  { paymentMethod: 'cash_on_delivery' }, { paymentMethod: 'wallet' },
  { billingProfileReady: true }, { billingProfileReady: null },
  { billingProfileReady: undefined }, { selectedCardId: 'pm_owned-fixture' },
  { paymentRequired: false },
])('does not change delivery-recipient rules for unaffected flows: %j', overrides => {
  expect(getSafepayCheckoutNameError('Salman', { ...firstCheckout, ...overrides })).toBeNull();
});

test('late server billing validation maps only safe correction fields', () => {
  expect(getSafepayBillingFieldErrors({ response: { data: { code: 'SAFEPAY_BILLING_PROFILE_REQUIRED',
    fields: ['fullName', '__proto__', 'card_number'], msg: 'A provider message' } } }))
    .toEqual({ fullName: SAFEPAY_BILLING_NAME_MESSAGE });
  expect(getSafepayBillingFieldErrors({ response: { data: { code: 'SAFEPAY_BILLING_PROFILE_REQUIRED',
    fields: ['phone', 'country'], msg: 'Check your phone and country.' } } }))
    .toEqual({ phone: 'Check your phone and country.', country: 'Check your phone and country.' });
  for (const error of [null, {}, { response: { data: { code: 'OTHER', fields: ['fullName'] } } },
    { response: { data: { code: 'SAFEPAY_BILLING_PROFILE_REQUIRED' } } }]) {
    expect(getSafepayBillingFieldErrors(error)).toEqual({});
  }
});

test('actual mobile form validation focuses the name before an order can be submitted; corrected details pass', () => {
  const source = readFileSync(require.resolve('../../src/screens/CheckoutScreen.js'), 'utf8');
  const body = source.split('const validateForm = () => {')[1].split('\n  const autoFillShipping')[0].replace(/};\s*$/, '');
  const run = new Function('formData', 'paymentMethod', 'savedCards', 'getSafepayCheckoutNameError',
    'isValidPhoneNumber', 'setErrors', 'Feedback', 'fullNameInputRef', 'totalAmount', body);
  const focus = jest.fn(), setErrors = jest.fn(), show = jest.fn();
  const form = { fullName: 'Salman', email: 'buyer@example.com', phone: '+923001234567', address: '1 Test Street',
    country: 'Pakistan', countryCode: 'PK', state: 'Punjab', city: 'Lahore', postalCode: '54000' };
  const validate = (details, method = 'card', ready = false) => run(details, method,
    { billingProfileReady: ready, selectedCardId: '' }, getSafepayCheckoutNameError,
    () => true, setErrors, { show }, { current: { focus } }, 1);
  expect(validate(form)).toBe(false);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(setErrors).toHaveBeenLastCalledWith({ fullName: SAFEPAY_BILLING_NAME_MESSAGE });
  expect(validate({ ...form, fullName: 'Salman Iqbal' })).toBe(true);
  expect(validate(form, 'wallet')).toBe(true);
  expect(validate(form, 'cash_on_delivery')).toBe(true);
  expect(validate(form, 'card', true)).toBe(true);
  const submit = source.split('const handlePlaceOrder = async')[1];
  expect(submit.indexOf('if (!validateForm()) {')).toBeGreaterThan(0);
  expect(submit.indexOf('if (!validateForm()) {')).toBeLessThan(submit.indexOf("api.post('/api/order/place'"));
  expect(source).toContain('inputRef: fullNameInputRef');
  expect(source).toContain('const billingErrors = getSafepayBillingFieldErrors(error);');
  expect(source).toMatch(/!savedCards.selectedCardId && !errors.fullName &&/);
});
