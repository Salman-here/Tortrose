#!/usr/bin/env node

/**
 * Environment Variables Verification Script
 * Run this to check if all required environment variables are set
 * Usage: node verify-env.js
 */

require('dotenv').config();

const requiredVars = [
  'NODE_ENV',
  'MONGO_URI',
  'JWT_SECRET',
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
    vars: ['STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_WEBHOOK_SECRET']
  },
  {
    name: 'Stripe (Live Mode)',
    condition: () => process.env.STRIPE_MODE === 'live',
    vars: ['STRIPE_LIVE_SECRET_KEY', 'STRIPE_LIVE_WEBHOOK_SECRET']
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
  'META_CAPI_TEST_EVENT_CODE'
];

console.log('🔍 Verifying Environment Variables...\n');

let missingRequired = [];
let missingOptional = [];
let foundRequired = [];
let foundOptional = [];
let missingConditional = [];
let foundConditional = [];

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

if (allMissing.length > 0) {
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
