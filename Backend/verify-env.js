#!/usr/bin/env node

/**
 * Environment Variables Verification Script
 * Run this to check if all required environment variables are set
 * Usage: node verify-env.js
 */

require('dotenv').config();
const {
  readPayoutEncryptionConfiguration,
} = require('./services/payoutEncryptionConfig');
const {
  resolveWhatsAppWebhookSecrets,
} = require('./services/whatsapp/webhookSecurity');

const requiredVars = [
  'NODE_ENV',
  'MONGO_URI',
  'JWT_SECRET',
  'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
  'FRONTEND_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'clientID',
  'clientSecret',
  'GOOGLE_CALLBACK_URL',
  'BREVO_API_KEY',
  'BREVO_SENDER_NAME',
  'BREVO_SENDER_EMAIL'
];

const conditionalVars = [
  {
    name: 'Stripe (Test Mode)',
    condition: () => !process.env.STRIPE_MODE || process.env.STRIPE_MODE === 'test',
    vars: ['STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_PUBLISHABLE_KEY', 'STRIPE_TEST_WEBHOOK_SECRET', 'STRIPE_MERCHANT_COUNTRY_CODE']
  },
  {
    name: 'Stripe (Live Mode)',
    condition: () => process.env.STRIPE_MODE === 'live',
    vars: ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_PUBLISHABLE_KEY', 'STRIPE_LIVE_WEBHOOK_SECRET', 'STRIPE_MERCHANT_COUNTRY_CODE']
  }
];

const optionalVars = [
  'HF_API_KEY',
  'OPENROUTER_API_KEY',
  'TRANSCRIPTION_PROVIDER',
  'OPENROUTER_TRANSCRIPTION_MODEL',
  'OPENROUTER_TRANSCRIPTION_LANGUAGE',
  'OPENAI_API_KEY',
  'OPENAI_TRANSCRIPTION_MODEL',
  'EVOLUTION_WEBHOOK_BASE64',
  'TRUST_PROXY_HOPS',
  'PORT',
  'STRIPE_MODE',
  'TIKTOK_PIXEL_ID',
  'TIKTOK_EVENTS_API_TOKEN',
  'TIKTOK_TEST_EVENT_CODE',
  'META_CAPI_DATASET_ID',
  'META_CAPI_ACCESS_TOKEN',
  'META_CAPI_API_VERSION',
  'META_CAPI_LEAD_EVENT_SOURCE',
  'META_CAPI_SELLER_LEAD_EVENT_NAME',
  'META_CAPI_STORE_VERIFICATION_EVENT_NAME',
  'META_CAPI_TEST_EVENT_CODE',
  'PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID',
  'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON'
];

console.log('🔍 Verifying Environment Variables...\n');

let missingRequired = [];
let missingOptional = [];
let foundRequired = [];
let foundOptional = [];
let missingConditional = [];
let foundConditional = [];
let invalidConfiguration = [];

// Check required variables
requiredVars.forEach(varName => {
  if (process.env[varName]) {
    foundRequired.push(varName);
    console.log(`✅ ${varName}: Set`);
  } else {
    missingRequired.push(varName);
    console.log(`❌ ${varName}: MISSING (Required)`);
  }
});

console.log('\n--- Conditional Variables (Stripe) ---\n');

// Check conditional variables
conditionalVars.forEach(group => {
  if (group.condition()) {
    console.log(`📦 ${group.name} - Active`);
    group.vars.forEach(varName => {
      if (process.env[varName]) {
        foundConditional.push(varName);
        console.log(`   ✅ ${varName}: Set`);
      } else {
        missingConditional.push(varName);
        console.log(`   ❌ ${varName}: MISSING (Required for this mode)`);
      }
    });
  } else {
    console.log(`⏭️  ${group.name} - Skipped (not active)`);
  }
});

const stripeMode = String(process.env.STRIPE_MODE || 'test').trim().toLowerCase();
if (!['test', 'live'].includes(stripeMode)) {
  invalidConfiguration.push('STRIPE_MODE must be test or live');
}
const activeSecretKey = stripeMode === 'live'
  ? process.env.STRIPE_LIVE_SECRET_KEY
  : process.env.STRIPE_TEST_SECRET_KEY;
const activePublishableKey = stripeMode === 'live'
  ? process.env.STRIPE_LIVE_PUBLISHABLE_KEY
  : process.env.STRIPE_TEST_PUBLISHABLE_KEY;
const activeWebhookSecret = stripeMode === 'live'
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
  : process.env.STRIPE_TEST_WEBHOOK_SECRET;
if (activeSecretKey && !activeSecretKey.startsWith(`sk_${stripeMode}_`)) {
  invalidConfiguration.push(`Active Stripe secret key does not match ${stripeMode} mode`);
}
if (activePublishableKey && !activePublishableKey.startsWith(`pk_${stripeMode}_`)) {
  invalidConfiguration.push(`Active Stripe publishable key does not match ${stripeMode} mode`);
}
if (activeWebhookSecret && !activeWebhookSecret.startsWith('whsec_')) {
  invalidConfiguration.push('Active Stripe webhook secret must start with whsec_');
}
if (
  process.env.STRIPE_MERCHANT_COUNTRY_CODE
  && !/^[A-Z]{2}$/.test(process.env.STRIPE_MERCHANT_COUNTRY_CODE.trim().toUpperCase())
) {
  invalidConfiguration.push('STRIPE_MERCHANT_COUNTRY_CODE must be a two-letter ISO country code');
}

invalidConfiguration.push(...readPayoutEncryptionConfiguration().errors);

const whatsappWebhookSecrets = resolveWhatsAppWebhookSecrets();
if (!whatsappWebhookSecrets.configured) {
  invalidConfiguration.push(
    'WHATSAPP_WEBHOOK_SECRET is required (EVOLUTION_WEBHOOK_SECRET is accepted only as a temporary migration fallback)'
  );
} else if (whatsappWebhookSecrets.usingLegacyFallback) {
  console.log('⚠️  WhatsApp webhook auth: legacy EVOLUTION_WEBHOOK_SECRET fallback is active; migrate to WHATSAPP_WEBHOOK_SECRET');
} else if (whatsappWebhookSecrets.rotatingFromLegacy) {
  console.log('⚠️  WhatsApp webhook auth: canonical and legacy secrets are both accepted during migration');
} else {
  console.log('✅ WhatsApp webhook auth: canonical secret configured');
}

console.log('\n--- Optional Variables ---\n');

// Check optional variables
optionalVars.forEach(varName => {
  if (process.env[varName]) {
    foundOptional.push(varName);
    console.log(`✅ ${varName}: Set`);
  } else {
    missingOptional.push(varName);
    console.log(`⚠️  ${varName}: Not set (Optional)`);
  }
});

// Summary
console.log('\n' + '='.repeat(50));
console.log('📊 SUMMARY');
console.log('='.repeat(50));
console.log(`✅ Required variables found: ${foundRequired.length}/${requiredVars.length}`);
console.log(`✅ Conditional variables found: ${foundConditional.length}/${foundConditional.length + missingConditional.length}`);
console.log(`⚠️  Optional variables found: ${foundOptional.length}/${optionalVars.length}`);

const allMissing = [...missingRequired, ...missingConditional];

if (allMissing.length > 0 || invalidConfiguration.length > 0) {
  console.log('\n❌ MISSING REQUIRED VARIABLES:');
  if (missingRequired.length > 0) {
    console.log('\n   Core Variables:');
    missingRequired.forEach(varName => {
      console.log(`   - ${varName}`);
    });
  }
  if (missingConditional.length > 0) {
    console.log('\n   Stripe Variables (for current mode):');
    missingConditional.forEach(varName => {
      console.log(`   - ${varName}`);
    });
  }
  if (invalidConfiguration.length > 0) {
    console.log('\n   Invalid configuration:');
    invalidConfiguration.forEach(message => console.log(`   - ${message}`));
  }
  console.log('\n⚠️  Your application may not work correctly!');
  console.log('📝 Please set these variables in your .env file or Heroku Config Vars.\n');
  process.exit(1);
} else {
  console.log('\n✅ All required environment variables are set!');
  console.log(`🔐 Stripe Mode: ${process.env.STRIPE_MODE || 'test'} (default)`);
  console.log('🚀 Your application should work correctly.\n');

  if (missingOptional.length > 0) {
    console.log('ℹ️  Optional variables not set:');
    missingOptional.forEach(varName => {
      console.log(`   - ${varName}`);
    });
    console.log('   (These are optional and won\'t affect core functionality)\n');
  }

  process.exit(0);
}
