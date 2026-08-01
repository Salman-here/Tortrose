/**
 * Centralized Stripe Configuration
 * Supports both test and live modes based on environment variables
 */

const requestedStripeMode = String(process.env.STRIPE_MODE || 'test').trim().toLowerCase();
const STRIPE_MODE = ['test', 'live'].includes(requestedStripeMode)
  ? requestedStripeMode
  : 'invalid';

const configuredSecretKey = STRIPE_MODE === 'live'
  ? process.env.STRIPE_LIVE_SECRET_KEY
  : STRIPE_MODE === 'test' ? process.env.STRIPE_TEST_SECRET_KEY : null;
const STRIPE_SECRET_KEY = configuredSecretKey?.startsWith(`sk_${STRIPE_MODE}_`)
  ? configuredSecretKey
  : null;

const configuredPublishableKey = STRIPE_MODE === 'live'
  ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY
  : STRIPE_MODE === 'test' ? process.env.STRIPE_TEST_PUBLISHABLE_KEY : null;
const STRIPE_PUBLISHABLE_KEY = configuredPublishableKey?.startsWith(`pk_${STRIPE_MODE}_`)
  ? configuredPublishableKey
  : null;

const configuredWebhookSecret = STRIPE_MODE === 'live'
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
  : STRIPE_MODE === 'test' ? process.env.STRIPE_TEST_WEBHOOK_SECRET : null;
const STRIPE_WEBHOOK_SECRET = configuredWebhookSecret?.startsWith('whsec_')
  ? configuredWebhookSecret
  : null;

const merchantCountry = String(process.env.STRIPE_MERCHANT_COUNTRY_CODE || '').trim().toUpperCase();
const STRIPE_MERCHANT_COUNTRY_CODE = /^[A-Z]{2}$/.test(merchantCountry)
  ? merchantCountry
  : null;
const STRIPE_MERCHANT_DISPLAY_NAME = String(
  process.env.STRIPE_MERCHANT_DISPLAY_NAME || 'Rozare'
).trim().slice(0, 120) || 'Rozare';

const stripe = STRIPE_SECRET_KEY
  ? require('stripe')(STRIPE_SECRET_KEY, { apiVersion: '2025-08-27.basil' })
  : null;

if (STRIPE_MODE === 'invalid') {
  console.error(`Invalid STRIPE_MODE "${requestedStripeMode}". Use "test" or "live".`);
} else if (stripe) {
  console.log(`✅ Stripe initialized in ${STRIPE_MODE.toUpperCase()} mode`);
} else {
  console.warn('⚠️  Stripe not configured - payment features disabled');
}

module.exports = {
  stripe,
  STRIPE_MODE,
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_MERCHANT_COUNTRY_CODE,
  STRIPE_MERCHANT_DISPLAY_NAME,
  isLiveMode: () => STRIPE_MODE === 'live',
  isTestMode: () => STRIPE_MODE === 'test',
};
