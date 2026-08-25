jest.mock('../../models/WhatsAppConfig', () => ({}));
jest.mock('../../models/WhatsAppPendingMessage', () => ({}));

const mockMainEvolution = {
  isConfigured: jest.fn(() => true),
  setSettings: jest.fn(async () => ({})),
  setWebhook: jest.fn(async () => ({})),
};
const mockSellerEvolution = {
  isConfigured: jest.fn(() => true),
  setSettings: jest.fn(async () => ({})),
  setWebhook: jest.fn(async () => ({})),
};

jest.mock('../../services/whatsapp/evolutionClient', () => mockMainEvolution);
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => mockSellerEvolution);
jest.mock('../../services/whatsapp/gatewayMode', () => ({
  configKeyFor: jest.fn(scope => scope),
  useUnifiedWhatsAppInstance: jest.fn(() => true),
}));

const { registerConfiguredWebhooks } = require('../../controllers/whatsappController');

const ENV_KEYS = [
  'BACKEND_PUBLIC_URL',
  'WHATSAPP_WEBHOOK_SECRET',
  'EVOLUTION_WEBHOOK_SECRET',
];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  ENV_KEYS.forEach(key => delete process.env[key]);
  process.env.BACKEND_PUBLIC_URL = 'https://backend.rozare.test/';
  jest.clearAllMocks();
  mockMainEvolution.isConfigured.mockReturnValue(true);
  mockSellerEvolution.isConfigured.mockReturnValue(true);
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
  jest.restoreAllMocks();
});

describe('automatic Evolution webhook registration', () => {
  test('registers the canonical secret in the same header contract used by ingress', async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = 'canonical-registration-secret';
    process.env.EVOLUTION_WEBHOOK_SECRET = 'legacy-registration-secret';

    await registerConfiguredWebhooks();

    expect(mockSellerEvolution.setWebhook).toHaveBeenCalledWith(
      'https://backend.rozare.test/api/whatsapp/webhook',
      'canonical-registration-secret'
    );
  });

  test('keeps the deployed legacy secret working until canonical migration', async () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = 'legacy-registration-secret';

    await registerConfiguredWebhooks();

    expect(mockSellerEvolution.setWebhook).toHaveBeenCalledWith(
      'https://backend.rozare.test/api/whatsapp/webhook',
      'legacy-registration-secret'
    );
  });

  test('never registers an unsigned webhook when no shared secret is configured', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await registerConfiguredWebhooks();

    expect(mockSellerEvolution.setWebhook).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '[whatsapp:seller] setWebhook failed (non-fatal):',
      expect.stringContaining('WHATSAPP_WEBHOOK_SECRET')
    );
  });
});
