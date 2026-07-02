jest.mock('axios', () => ({
  create: jest.fn(),
}));

jest.mock('../../models/WhatsAppJidMapping', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const axios = require('axios');
const createEvolutionClient = require('../../services/whatsapp/createEvolutionClient');

describe('Evolution client recipient routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVOLUTION_API_URL = 'http://evolution.test';
    process.env.EVOLUTION_API_KEY = 'test-key';
    delete process.env.EVOLUTION_SELLER_INSTANCE_NAME;
  });

  test('routes a phone JID to the recent LID chat before sending text', async () => {
    let sentPayload;
    axios.create.mockReturnValue({
      post: jest.fn(async (url, payload) => {
        if (url.includes('/chat/findMessages/')) {
          return {
            data: {
              messages: {
                records: [
                  {
                    key: {
                      fromMe: false,
                      remoteJid: '39767790104698@lid',
                      remoteJidAlt: '923499166402@s.whatsapp.net',
                    },
                    message: { conversation: 'Hi' },
                  },
                ],
              },
            },
          };
        }

        sentPayload = payload;
        return { data: { key: { id: 'test-message' } } };
      }),
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    await client.sendText('923499166402@s.whatsapp.net', 'hello');

    expect(sentPayload.number).toBe('39767790104698@lid');
    expect(sentPayload.delay).toBe(0);
  });

  test('registers webhook using Evolution v2.3 wrapped payload with inbound events', async () => {
    let webhookPayload;
    axios.create.mockReturnValue({
      post: jest.fn(async (url, payload) => {
        expect(url).toBe('/webhook/set/rozare-seller');
        webhookPayload = payload;
        return { data: { ok: true } };
      }),
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    await client.setWebhook('https://rozare.up.railway.app/api/whatsapp/webhook', 'test-secret');

    expect(webhookPayload).toHaveProperty('webhook');
    expect(webhookPayload.webhook.url).toBe('https://rozare.up.railway.app/api/whatsapp/webhook');
    expect(webhookPayload.webhook.headers).toEqual({ 'x-rozare-webhook-secret': 'test-secret' });
    expect(webhookPayload.webhook.events).toEqual(expect.arrayContaining([
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'QRCODE_UPDATED',
    ]));
    expect(webhookPayload.webhook.events).not.toContain('SEND_MESSAGE');
  });

  test('applies low-latency Evolution settings by default', async () => {
    let settingsPayload;
    axios.create.mockReturnValue({
      post: jest.fn(async (url, payload) => {
        expect(url).toBe('/settings/set/rozare-seller');
        settingsPayload = payload;
        return { data: { settings: payload } };
      }),
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    await client.setSettings();

    expect(settingsPayload).toEqual(expect.objectContaining({
      groupsIgnore: true,
      alwaysOnline: true,
      readMessages: true,
      readStatus: false,
      syncFullHistory: false,
    }));
  });
});
