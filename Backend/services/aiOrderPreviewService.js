'use strict';

const crypto = require('crypto');
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const canonical = value => {
  if (value && typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function signature(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Order preview verification is temporarily unavailable. Please use secure checkout.');
  // Domain-separated from authentication tokens. This token only proves a
  // quoted checkout contract; it never authenticates a person or charges them.
  return crypto.createHmac('sha256', secret).update(`rozare-ai-order-preview-v1\0${payload}`).digest('base64url');
}
function createOrderPreview({ userId, requestKey, contract, now = Date.now() }) {
  const expiresAt = now + PREVIEW_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, user: String(userId), turn: digest(String(requestKey || '')), contract: digest(contract), exp: expiresAt })).toString('base64url');
  return { quoteToken: `aip1.${payload}.${signature(payload)}`, expiresAt: new Date(expiresAt).toISOString() };
}
function verifyOrderPreview({ quoteToken, userId, requestKey, contract, now = Date.now() }) {
  const fail = (code, error) => ({ success: false, code, error, needsOrderPreview: true, data: { nextTool: 'preview_order' } });
  if (typeof quoteToken !== 'string' || quoteToken.length > 1024) return fail('AI_ORDER_PREVIEW_REQUIRED', 'Please review the order total first, then confirm the order.');
  const match = /^aip1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(quoteToken);
  if (!match) return fail('AI_ORDER_PREVIEW_INVALID', 'That order preview could not be verified. Please request a fresh total.');
  let payload;
  try {
    const expected = Buffer.from(signature(match[1]));
    const received = Buffer.from(match[2]);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) throw new Error('Invalid preview');
    payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    return fail('AI_ORDER_PREVIEW_INVALID', 'That order preview could not be verified. Please request a fresh total.');
  }
  if (payload.v !== 1 || payload.user !== String(userId) || !Number.isSafeInteger(payload.exp) || payload.exp > now + PREVIEW_TTL_MS) return fail('AI_ORDER_PREVIEW_INVALID', 'That order preview could not be verified for your account.');
  if (payload.exp <= now) return fail('AI_ORDER_PREVIEW_EXPIRED', 'The order preview has expired. Please review a fresh total before confirming.');
  if (payload.turn === digest(String(requestKey || ''))) return fail('AI_ORDER_CONFIRMATION_REQUIRED', 'Show this order preview to the buyer and wait for their next message confirming it. No order has been placed.');
  if (contract && payload.contract !== digest(contract)) return fail('AI_ORDER_PREVIEW_CHANGED', 'The items, options, address, currency, or charges changed since your preview. Please review the updated total and confirm again. No order has been placed.');
  return { success: true };
}

module.exports = { createOrderPreview, verifyOrderPreview, PREVIEW_TTL_MS };
