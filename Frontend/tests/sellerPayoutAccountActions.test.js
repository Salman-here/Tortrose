import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/components/layout/SellerPayments.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const handleAccountChange =');
const end = source.indexOf('const requestWithdrawal =', start);
assert.ok(start >= 0 && end > start);
const handlers = source.slice(start, end) + '\n({ change: handleAccountChange, save: saveAccount });';

function fixture() {
  const calls = { bodies: [], errors: [], refreshed: 0 };
  const context = {
    accountForm: { accountHolderName: 'Seller Name', bankName: 'GB Bank', accountNumber: '', iban: '',
      clearAccountNumber: false, clearIban: false, country: 'United Kingdom', currency: 'GBP', swiftCode: 'WESTGB2L' },
    paymentAccount: { maskedAccountNumber: '**** 1234', maskedIban: '**** 5432' },
    API: '/api/payments', setSavingAccount() {}, setShowAccountForm() {}, getAuthToken: () => 'seller-token',
    setAccountForm: update => { context.accountForm = update(context.accountForm); },
    axios: { put: async (url, body, config) => {
      calls.bodies.push({ url, body: JSON.parse(JSON.stringify(body)), config });
      return { data: { msg: 'Saved' } };
    } },
    toast: { success() {}, error: message => calls.errors.push(message) },
    fetchSummary: async () => { calls.refreshed++; },
  };
  return { ...vm.runInNewContext(handlers, context), calls, context };
}

test('web sends explicit clear intent when changing from saved GB IBAN to a Pakistan account-only destination', async () => {
  const f = fixture();
  f.change('accountNumber', '000012345678'); f.change('country', 'Pakistan');
  f.change('currency', 'PKR'); f.change('swiftCode', ''); f.change('clearIban', true);
  await f.save({ preventDefault() {} });
  assert.equal(f.calls.bodies.length, 1);
  assert.deepEqual(f.calls.bodies[0].body, {
    accountHolderName: 'Seller Name', bankName: 'GB Bank', accountNumber: '000012345678', iban: '',
    clearAccountNumber: false, clearIban: true, country: 'Pakistan', currency: 'PKR', swiftCode: '',
  });
  assert.equal(f.calls.refreshed, 1);
  assert.equal(JSON.stringify(f.calls.bodies[0].body).includes('****'), false);
});

test('blank web fields preserve saved identifiers unless explicit removal is selected', async () => {
  const f = fixture();
  await f.save({ preventDefault() {} });
  assert.equal(f.calls.bodies[0].body.clearIban, false);
  assert.equal(f.calls.bodies[0].body.clearAccountNumber, false);
  f.change('iban', 'replacement'); f.change('clearIban', true);
  assert.equal(f.context.accountForm.iban, '');
  f.change('clearIban', false);
  assert.equal(f.context.accountForm.clearIban, false);
});

test('web blocks clearing both identifiers before sending an account update', async () => {
  const f = fixture();
  f.change('clearIban', true); f.change('clearAccountNumber', true);
  await f.save({ preventDefault() {} });
  assert.equal(f.calls.bodies.length, 0);
  assert.deepEqual(f.calls.errors, ['Keep or enter at least one bank account number or IBAN.']);
});
