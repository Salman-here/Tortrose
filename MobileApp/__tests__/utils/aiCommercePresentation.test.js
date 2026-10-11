const { aiCommercePreviewPresentation, aiCommerceMessageText, aiSecureHandoffRoute } = require('../../src/utils/aiCommercePresentation');

test('native secure handoffs stay local and cannot skip required confirmation', () => {
  const route = '/seller-dashboard/order-management?tab=returns';
  const result = { success: true, requiresPayment: true, data: { route } };
  expect(aiSecureHandoffRoute(result)).toBe(route);
  for (const changes of [{ success: false }, { previewOnly: true }, { requiresConfirmation: true }, { requiresPayment: false }]) expect(aiSecureHandoffRoute({ ...result, ...changes })).toBeNull();
  for (const invalid of ['https://outside.example/checkout', '//outside.example/checkout', '/\\outside.example', 'javascript:alert(1)', '/checkout with spaces', null]) expect(aiSecureHandoffRoute({ ...result, data: { route: invalid } })).toBeNull();
});
test('native financial preview confirmation is explicit and does not expose the retained token', () => {
  const result = { success: true, previewOnly: true, requiresConfirmation: true, data: {
    quoteToken: 'aif1.' + 'a'.repeat(64), action: 'request_withdrawal', request: { amount: 2000, currency: 'PKR' },
    commercePreview: { action: 'request_withdrawal', title: 'Review withdrawal', notice: 'Bank destination masked; admin review, not paid.', expiresAt: new Date().toISOString() },
  } };
  const view = aiCommercePreviewPresentation(result);
  expect(view.controls[0].message).toContain('2000.00 PKR'); expect(JSON.stringify(view)).not.toContain('aif1.');
  result.message = 'Exact reviewed details.';
  expect(aiCommerceMessageText(result.message, [{ result }])).toBe('Please review the details below before confirming.');
  expect(aiCommerceMessageText('Additional requested information.', [{ result }])).toBe('Additional requested information.');
  result.requiresConfirmation = false; expect(aiCommercePreviewPresentation(result)).toBe(null);
});
