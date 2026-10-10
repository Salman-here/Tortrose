'use strict';
const crypto = require('node:crypto');
const { readSafepayConfig } = require('../config/safepay');
const { verifySafepayWebhook } = require('../services/safepayWebhookVerification');

function rejectionSignatureDiagnostics(raw, signature, incoming, config) {
  const matches = [];
  if (typeof config.webhookSecret === 'string' && config.webhookSecret.length >= 16
    && typeof signature === 'string' && /^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i.test(signature)) {
    const received = Buffer.from(signature, 'hex');
    for (const scheme of ['sha512-data', 'sha512-raw', 'sha256-raw']) {
      const bytes = scheme === 'sha512-data' ? Buffer.from(JSON.stringify(incoming?.data ?? null)) : raw;
      const computed = crypto.createHmac(scheme.startsWith('sha512') ? 'sha512' : 'sha256', config.webhookSecret).update(bytes).digest();
      if (computed.length === received.length && crypto.timingSafeEqual(computed, received)) matches.push(scheme);
    }
  }
  // Diagnostic metadata is deliberately booleans/names/length only. Never log
  // payload, signature, credentials, contacts, event token or tracker identity.
  return { matches, signatureLength: typeof signature === 'string' ? signature.length : 0,
    merchantMatches: incoming?.merchant_api_key === config.publicKey, versionMatches: incoming?.version === '2.0.0',
    typeFormat: typeof incoming?.type === 'string' && /^[a-z][a-z0-9_.]{2,100}$/.test(incoming.type),
    tokenFormat: typeof incoming?.token === 'string' && /^evt_[a-zA-Z0-9-]{8,150}$/.test(incoming.token) };
}

function createSafepayWebhookHandler({
  configFor = options => readSafepayConfig(process.env, options),
  probeId = () => process.env.SAFEPAY_SIGNATURE_PROBE_ID || '',
  connect = () => require('../config/db')(),
  model = () => require('../models/SafepayWebhookEvent'),
  log = message => console.info(message),
  diagnosticsEnabled = () => process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS === 'true',
} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let diagnosticContext;
    try {
      const config = configFor({ requireWebhook: false });
      const raw = req.body;
      const signature = req.headers['x-sfpy-signature'];
      if (!Buffer.isBuffer(raw) || raw.length > 512 * 1024) return res.sendStatus(400);
      let incoming;
      try { incoming = JSON.parse(raw.toString('utf8')); } catch (_) { return res.sendStatus(400); }
      const expectedProbe = probeId();
      if (config.environment === 'sandbox' && expectedProbe && incoming?.token === expectedProbe) {
        // Diagnostic-only event requested through Safepay's test API. It can
        // never enter the financial event queue or grant money/entitlements.
        const matches = [];
        if (typeof config.webhookSecret === 'string' && config.webhookSecret.length >= 16
          && typeof signature === 'string' && /^[a-f0-9]{64,128}$/i.test(signature)) {
          for (const scheme of ['sha512-data', 'sha512-raw', 'sha256-raw']) {
            const bytes = scheme === 'sha512-data' ? Buffer.from(JSON.stringify(incoming.data ?? null)) : raw;
            const computed = crypto.createHmac(scheme.startsWith('sha512') ? 'sha512' : 'sha256', config.webhookSecret).update(bytes).digest();
            const received = Buffer.from(signature, 'hex');
            if (computed.length === received.length && crypto.timingSafeEqual(computed, received)) matches.push(scheme);
          }
        }
        log('[safepay-signature-preflight] ' + JSON.stringify({ matches, signatureLength: typeof signature === 'string' ? signature.length : 0,
          version: String(incoming.version || '').slice(0, 20), merchantMatches: incoming.merchant_api_key === config.publicKey }));
        return matches.length ? res.status(200).json({ received: true, probe: true }) : res.sendStatus(401);
      }
      const verifiedConfig = configFor({ requireWebhook: true });
      diagnosticContext = { raw, signature, incoming, config: verifiedConfig };
      const { event, fingerprint } = verifySafepayWebhook(raw, signature, verifiedConfig);
      await connect();
      const Event = model();
      await Event.init();
      const identity = { environment: verifiedConfig.environment, eventId: event.token };
      const existing = await Event.findOne(identity).select('fingerprint').lean();
      if (existing) return existing.fingerprint === fingerprint ? res.status(200).json({ received: true, duplicate: true }) : res.sendStatus(409);
      try {
        await Event.create({ ...identity, type: event.type, fingerprint, payload: event });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const winner = await Event.findOne(identity).select('fingerprint').lean();
        if (winner?.fingerprint !== fingerprint) return res.sendStatus(409);
      }
      // Durable persistence precedes ACK. Business processing uses a separate
      // leased worker so crashes cannot lose an already acknowledged event.
      return res.status(200).json({ received: true });
    } catch (error) {
      if (error.code === 'SAFEPAY_WEBHOOK_INVALID') {
        // This never changes verification or ACK behavior. It is default-off
        // incident diagnostics for rejected events, NOT signature auto-detection.
        try {
          if (diagnosticsEnabled() === true && diagnosticContext) {
            const { raw, signature, incoming, config } = diagnosticContext;
            log('[safepay-webhook-rejection-diagnostics] ' + JSON.stringify(rejectionSignatureDiagnostics(raw, signature, incoming, config)));
          }
        } catch (_) { /* Logging must not turn an invalid event into an ACK/retry. */ }
        return res.sendStatus(401);
      }
      console.error('[safepay-webhook] receipt deferred:', error.code || 'WEBHOOK_RECEIPT_FAILED');
      return res.sendStatus(503);
    }
  };
}

module.exports = { createSafepayWebhookHandler, receiveSafepayWebhook: createSafepayWebhookHandler() };
