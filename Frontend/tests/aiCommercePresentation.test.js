import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aiCommercePreviewPresentation as present, aiCommerceMessageText } from '../src/utils/aiCommercePresentation.js';
const fixture = () => ({ success: true, previewOnly: true, requiresConfirmation: true, data: {
  quoteToken: 'aif1.' + 'a'.repeat(64), action: 'request_withdrawal', request: { amount: 5, currency: 'USD' },
  commercePreview: { action: 'request_withdrawal', title: 'Review withdrawal', notice: '5 USD to the reviewed bank; not a transfer.', expiresAt: '2026-10-11T12:00:00.000Z' },
} });

test('review text removes only a duplicate disclosure while retaining other requested information', () => {
  const result = fixture(); result.message = result.data.commercePreview.notice + '\nReview and confirm next.';
  assert.equal(aiCommerceMessageText(result.message, [{ result }]), 'Please review the details below before confirming.');
  assert.equal(aiCommerceMessageText('Your balance is 100 USD. ' + result.message, [{ result }]), 'Your balance is 100 USD. ' + result.message);
  result.previewOnly = false;
  assert.equal(aiCommerceMessageText(result.message, [{ result }]), result.message);
});
test('web and mobile use exactly the same reviewed-action presentation contract', () => {
  assert.equal(fs.readFileSync(new URL('../src/utils/aiCommercePresentation.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../MobileApp/src/utils/aiCommercePresentation.js', import.meta.url), 'utf8'));
});
test('withdrawal confirmation says the exact amount and currency without a private token or bank number', () => {
  const view = present(fixture());
  assert.match(view.controls[0].message, /5.00 USD/); assert.doesNotMatch(JSON.stringify(view), /aif1|reviewed-bank-id|5678/);
  assert.match(view.reminder, /Nothing submitted/);
});
test('a real action result, failed result or counterfeit/malformed preview gets no confirmation controls', () => {
  for (const mutate of [r => { r.previewOnly = false; }, r => { r.success = false; }, r => { r.data.quoteToken = 'forged'; },
    r => { r.data.commercePreview.action = 'delete_user'; }, r => { r.data.request.amount = 5.001; }, r => { r.data.request.currency = 'CAD'; },
    r => { r.data.commercePreview.expiresAt = 'invalid'; }]) { const result = fixture(); mutate(result); assert.equal(present(result), null); }
});
test('card cancellation offers review choices, then confirms only the selected option and deduction', () => {
  const result = fixture(); result.data.action = 'cancel_order'; result.data.request = {};
  result.data.commercePreview.action = 'cancel_order'; result.data.commercePreview.options = [
    { destination: 'wallet', label: 'Rozare Wallet', amount: 100, deduction: 0, currency: 'PKR' },
    { destination: 'original_card', label: 'Original card', amount: 63.8, deduction: 36.2, currency: 'PKR' },
  ];
  assert.equal(present(result).controls.length, 2); assert.match(present(result).controls[0].label, /Review/);
  result.data.request.refundDestination = 'original_card';
  const controls = present(result).controls; assert.equal(controls.length, 1);
  assert.match(controls[0].label, /63.80 PKR/); assert.match(controls[0].message, /accept the displayed processing deduction/);
});
test('Raast and Wallet have just the selected full Wallet control; COD has no money refund control', () => {
  const result = fixture(); result.data.action = 'cancel_order'; result.data.commercePreview.action = 'cancel_order';
  result.data.request = { refundDestination: 'wallet' };
  result.data.commercePreview.options = [{ destination: 'wallet', label: 'Rozare Wallet', amount: 100, deduction: 0, currency: 'PKR' }];
  assert.equal(present(result).controls.length, 1); assert.match(present(result).controls[0].message, /full Wallet refund/);
  result.data.request.refundDestination = 'none'; result.data.cancellationQuote = { paymentMethod: 'cash_on_delivery' }; result.data.commercePreview.options = [{ destination: 'none', label: 'No refund required', amount: 0, deduction: 0, currency: 'PKR' }];
  assert.match(present(result).controls[0].message, /COD cancellation/);
});
