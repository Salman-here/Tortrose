'use strict';
process.env.OPENROUTER_API_KEY = 'feature-coverage-test';
const { getSecureFlow, buyerFlows, sellerFlows } = require('../../services/aiSecureFlowService');
const { __private } = require('../../controllers/aiChatController');
const toolsFor = role => __private.getTools(role).map(tool => tool.function.name);

test.each(['user', 'seller'])('%s secure handoffs all resolve to real server-allowed routes without performing an action', role => {
  const features = role === 'seller' ? { ...buyerFlows, ...sellerFlows } : buyerFlows;
  for (const feature of Object.keys(features)) {
    const result = getSecureFlow(feature, { role });
    expect(result).toMatchObject({ success: true, requiresSecureAction: true, data: { feature, noActionPerformed: true } });
    expect(__private.normalizeAIClientRoute(result.data.route, role)).toBe(result.data.route);
    expect(result.message).toContain('not confirmation');
  }
});
test('buyer cannot access seller-only billing, ownership, bank or store features', () => {
  for (const feature of ['subscription', 'subdomain_purchase', 'payout_account', 'store_creation', 'notification_settings', 'product_files']) {
    expect(getSecureFlow(feature, { role: 'user' })).toMatchObject({ success: false, code: 'AI_SECURE_FLOW_UNAVAILABLE' });
  }
  expect(getSecureFlow('subscription', { role: 'guest' }).success).toBe(false);
  expect(getSecureFlow('https://evil.example', { role: 'seller' }).success).toBe(false);
  expect(getSecureFlow('toString', { role: 'seller' }).success).toBe(false);
});
test('updated feature families are present in the complete role tool surface', () => {
  expect(toolsFor('user')).toEqual(expect.arrayContaining(['get_saved_payment_methods', 'get_secure_flow', 'get_wallet_balance', 'get_purchase_orders', 'request_return', 'cancel_return']));
  expect(toolsFor('seller')).toEqual(expect.arrayContaining(['get_saved_payment_methods', 'get_secure_flow', 'get_my_withdrawals', 'get_subdomain_status', 'get_verification_status', 'get_seller_returns', 'accept_return', 'request_withdrawal']));
  for (const name of ['get_my_withdrawals', 'get_subdomain_status', 'get_verification_status']) expect(toolsFor('user')).not.toContain(name);
});
