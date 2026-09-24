'use strict';

// Sandbox and production secrets are deliberately separate. No fallback to
// another environment or to Stripe is allowed for a Safepay payment attempt.
const SAFEPAY_HOSTS = Object.freeze({ sandbox: 'https://sandbox.api.getsafepay.com', production: 'https://api.getsafepay.com' });
const SAFEPAY_CHECKOUT_HOSTS = Object.freeze({ sandbox: 'https://sandbox.api.getsafepay.com', production: 'https://getsafepay.com' });
const error = (message, code = 'SAFEPAY_NOT_CONFIGURED') => Object.assign(new Error(message), { code, statusCode: 503 });

function readSafepayConfig(env = process.env, { requireWebhook = false } = {}) {
  const environment = env.SAFEPAY_ENV || 'sandbox';
  if (!Object.hasOwn(SAFEPAY_HOSTS, environment)) throw error('Safepay environment must be sandbox or production.', 'SAFEPAY_ENV_INVALID');
  const prefix = environment === 'sandbox' ? 'SAFEPAY_SANDBOX_' : 'SAFEPAY_PRODUCTION_';
  const publicKey = env[prefix + 'PUBLIC_KEY'];
  const secretKey = env[prefix + 'SECRET_KEY'];
  const webhookSecret = env[prefix + 'WEBHOOK_SECRET'];
  if (!/^sec_[a-z0-9-]+$/i.test(publicKey || '') || typeof secretKey !== 'string' || secretKey.length < 16 || /[\r\n]/.test(secretKey)) {
    throw error(`Safepay ${environment} server credentials are not configured.`);
  }
  // Safepay has conflicting published examples. The deployed verifier must
  // use the explicitly verified account protocol, not guess multiple schemes.
  const webhookScheme = env[prefix + 'WEBHOOK_SCHEME'] || '';
  if (requireWebhook && (typeof webhookSecret !== 'string' || webhookSecret.length < 16
    || !['sha512-data', 'sha512-raw', 'sha256-raw'].includes(webhookScheme))) {
    throw error('Safepay webhook verification must be configured before accepting events.', 'SAFEPAY_WEBHOOK_NOT_CONFIGURED');
  }
  return Object.freeze({ environment, publicKey, secretKey, webhookSecret, webhookScheme,
    apiHost: SAFEPAY_HOSTS[environment], checkoutHost: SAFEPAY_CHECKOUT_HOSTS[environment] });
}

module.exports = { readSafepayConfig, SAFEPAY_HOSTS, SAFEPAY_CHECKOUT_HOSTS };
