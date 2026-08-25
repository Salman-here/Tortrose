const express = require('express');
const request = require('supertest');
const {
  WHATSAPP_WEBHOOK_HEADER,
  createWhatsAppWebhookIngress,
  getOutboundWhatsAppWebhookSecret,
  resolveWhatsAppWebhookSecrets,
  verifyWhatsAppWebhookRequest,
} = require('../../services/whatsapp/webhookSecurity');
const {
  handleEvolutionWebhook,
} = require('../../services/whatsapp/webhookHandler');

const ENV_KEYS = [
  'WHATSAPP_WEBHOOK_SECRET',
  'EVOLUTION_WEBHOOK_SECRET',
  'EVOLUTION_API_KEY',
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  ENV_KEYS.forEach(key => delete process.env[key]);
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
});

describe('WhatsApp webhook secret resolution', () => {
  test('fails closed when neither the canonical nor migration secret exists', () => {
    const result = verifyWhatsAppWebhookRequest({ headers: {} }, {});

    expect(result).toMatchObject({
      ok: false,
      statusCode: 503,
      code: 'WHATSAPP_WEBHOOK_SECRET_NOT_CONFIGURED',
    });
  });

  test('prefers the canonical secret while accepting the old value during rotation', () => {
    const env = {
      WHATSAPP_WEBHOOK_SECRET: 'canonical-secret',
      EVOLUTION_WEBHOOK_SECRET: 'legacy-secret',
    };

    expect(resolveWhatsAppWebhookSecrets(env)).toMatchObject({
      configured: true,
      primarySecret: 'canonical-secret',
      rotatingFromLegacy: true,
    });
    expect(getOutboundWhatsAppWebhookSecret(env)).toBe('canonical-secret');
    expect(verifyWhatsAppWebhookRequest({
      headers: { [WHATSAPP_WEBHOOK_HEADER]: 'canonical-secret' },
    }, env).ok).toBe(true);
    expect(verifyWhatsAppWebhookRequest({
      headers: { [WHATSAPP_WEBHOOK_HEADER]: 'legacy-secret' },
    }, env).ok).toBe(true);
  });

  test('supports the deployed legacy variable without treating EVOLUTION_API_KEY as a webhook secret', () => {
    const env = {
      EVOLUTION_WEBHOOK_SECRET: 'deployed-legacy-secret',
      EVOLUTION_API_KEY: 'gateway-admin-api-key',
    };

    expect(getOutboundWhatsAppWebhookSecret(env)).toBe('deployed-legacy-secret');
    expect(verifyWhatsAppWebhookRequest({
      headers: { apikey: 'deployed-legacy-secret' },
    }, env).ok).toBe(true);
    expect(verifyWhatsAppWebhookRequest({
      headers: { apikey: 'gateway-admin-api-key' },
    }, env)).toMatchObject({
      ok: false,
      statusCode: 401,
    });
  });

  test('the handler itself retains fail-closed authentication when mounted directly', async () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);

    await handleEvolutionWebhook({ headers: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'WHATSAPP_WEBHOOK_SECRET_NOT_CONFIGURED',
    }));
  });
});

describe('WhatsApp webhook ingress ordering and limits', () => {
  test('rejects an unauthorized request before invoking the large JSON parser', async () => {
    let parserReached = false;
    const app = express();
    const parserProbe = (_req, _res, next) => {
      parserReached = true;
      next();
    };
    app.use('/webhook', ...createWhatsAppWebhookIngress({
      env: {
        WHATSAPP_WEBHOOK_RATE_LIMIT_MAX: '10',
        WHATSAPP_WEBHOOK_SECRET: 'expected-secret',
      },
      jsonParser: parserProbe,
    }));
    app.post('/webhook', (_req, res) => res.json({ ok: true }));

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send('{ deliberately malformed JSON');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('WHATSAPP_WEBHOOK_UNAUTHORIZED');
    expect(parserReached).toBe(false);
  });

  test('uses a dedicated configurable limiter before parsing authenticated traffic', async () => {
    let parsedRequests = 0;
    const app = express();
    const parserProbe = (_req, _res, next) => {
      parsedRequests += 1;
      next();
    };
    app.use('/webhook', ...createWhatsAppWebhookIngress({
      env: {
        WHATSAPP_WEBHOOK_RATE_LIMIT_MAX: '2',
        WHATSAPP_WEBHOOK_SECRET: 'expected-secret',
      },
      jsonParser: parserProbe,
    }));
    app.post('/webhook', (_req, res) => res.json({ ok: true }));

    const authenticatedRequest = () => request(app)
      .post('/webhook')
      .set(WHATSAPP_WEBHOOK_HEADER, 'expected-secret');
    expect((await authenticatedRequest()).status).toBe(200);
    expect((await authenticatedRequest()).status).toBe(200);
    const limited = await authenticatedRequest();

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('WHATSAPP_WEBHOOK_RATE_LIMITED');
    expect(parsedRequests).toBe(2);
  });
});
