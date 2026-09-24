'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { readSafepayConfig } = require('../config/safepay');
const fail = () => Object.assign(new Error('Invalid Safepay webhook.'), { code: 'SAFEPAY_WEBHOOK_INVALID', statusCode: 401 });

// Scheme is pinned after checking a genuine signed sandbox event. Different
// Safepay SDK generations sign different bytes; never auto-detect a weaker
// scheme. The event alone is not settlement proof: reconcile with the owned
// provider payment/subscription record before applying any financial change.
function verifySafepayWebhook(rawBody, signature, config = readSafepayConfig(process.env, { requireWebhook: true })) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 512 * 1024
    || typeof signature !== 'string' || !config.webhookSecret
    || !['sha512-data', 'sha512-raw', 'sha256-raw'].includes(config.webhookScheme)) throw fail();
  const algorithm = config.webhookScheme.startsWith('sha512') ? 'sha512' : 'sha256';
  const length = algorithm === 'sha512' ? 128 : 64;
  if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(signature)) throw fail();
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch (_) { throw fail(); }
  if (!event || typeof event !== 'object' || Array.isArray(event) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw fail();
  const payload = config.webhookScheme === 'sha512-data' ? Buffer.from(JSON.stringify(event.data)) : rawBody;
  const computed = crypto.createHmac(algorithm, config.webhookSecret).update(payload).digest();
  if (!crypto.timingSafeEqual(computed, Buffer.from(signature, 'hex'))) throw fail();
  if (event.merchant_api_key !== config.publicKey || typeof event.token !== 'string'
    || !/^evt_[a-zA-Z0-9-]{8,150}$/.test(event.token) || typeof event.type !== 'string'
    || !/^[a-z][a-z0-9_.]{2,100}$/.test(event.type) || event.version !== '2.0.0') throw fail();
  return { event, fingerprint: crypto.createHash('sha256').update(JSON.stringify({ type: event.type, data: event.data, merchant: event.merchant_api_key, version: event.version })).digest('hex') };
}
module.exports = { verifySafepayWebhook };
