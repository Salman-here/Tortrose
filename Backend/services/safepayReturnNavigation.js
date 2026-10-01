'use strict';

const PURPOSES = new Set(['order', 'wallet_top_up', 'subdomain', 'subscription', 'return_settlement', 'card_setup']);
const SURFACES = new Set(['web', 'mobile']);
const validAttempt = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

function buildReturnUrl({ backendOrigin, attempt, purpose, surface, outcome }) {
  if (!validAttempt(attempt) || !PURPOSES.has(purpose) || !SURFACES.has(surface) || !['return', 'cancel'].includes(outcome)) {
    throw Object.assign(new Error('Invalid payment return route.'), { code: 'SAFEPAY_RETURN_URL_INVALID', statusCode: 503 });
  }
  // Safepay appends ?order_id=... to the callback, even when it already has
  // a query string. Put web navigation context in the path, not that query.
  // Installed Android builds intercept the exact legacy callback pathname.
  // Keep that contract; the legacy parser safely handles Safepay's appended
  // query suffix. Website callbacks use the corruption-proof path contract.
  const url = new URL(surface === 'mobile' ? '/api/safepay/return'
    : `/api/safepay/return/${surface}/${purpose}/${attempt}/${outcome}`, backendOrigin);
  if (surface === 'mobile') url.search = new URLSearchParams({ attempt, purpose, surface, outcome }).toString();
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('The payment return service requires HTTPS.'), { code: 'SAFEPAY_RETURN_URL_INVALID', statusCode: 503 });
  }
  return url.toString();
}

function parseReturnNavigation(req) {
  if (req.params?.surface !== undefined) {
    const { surface, purpose, attempt, outcome } = req.params;
    return SURFACES.has(surface) && PURPOSES.has(purpose) && validAttempt(attempt) && ['return', 'cancel'].includes(outcome)
      ? { surface, purpose, attempt, outcome } : null;
  }
  // Keep existing unpaid checkout links usable. Only remove the observed
  // provider suffix; arbitrary query values and arrays still fail validation.
  const legacyValue = value => typeof value === 'string' ? value.split('?order_id=')[0] : value;
  const attempt = legacyValue(req.query?.attempt);
  const purpose = legacyValue(req.query?.purpose);
  const surface = legacyValue(req.query?.surface) ?? 'mobile';
  const outcome = legacyValue(req.query?.outcome) === 'cancel' ? 'cancel' : 'return';
  return validAttempt(attempt) && PURPOSES.has(purpose) && SURFACES.has(surface)
    ? { attempt, purpose, surface, outcome } : null;
}

module.exports = { buildReturnUrl, parseReturnNavigation };
