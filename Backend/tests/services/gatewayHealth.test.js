jest.mock('axios', () => ({
  create: jest.fn(),
}));

jest.mock('../../models/WhatsAppJidMapping', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const axios = require('axios');
const createEvolutionClient = require('../../services/whatsapp/createEvolutionClient');
const {
  isZombieGatewayError,
  isZombieGatewayBody,
} = require('../../services/whatsapp/gatewayHealth');

const boomConnectionClosed = {
  data: null,
  isBoom: true,
  isServer: false,
  output: {
    statusCode: 428,
    payload: {
      statusCode: 428,
      error: 'Precondition Required',
      message: 'Connection Closed',
    },
  },
};

describe('zombie gateway error classification', () => {
  test('recognizes Boom Connection Closed in an HTTP error response', () => {
    const err = { response: { status: 500, data: boomConnectionClosed }, message: 'Request failed with status code 500' };
    expect(isZombieGatewayError(err)).toBe(true);
  });

  test('recognizes Connection Closed body returned with HTTP 200', () => {
    expect(isZombieGatewayBody(boomConnectionClosed)).toBe(true);
  });

  test('does not flag ordinary errors', () => {
    expect(isZombieGatewayError({ response: { status: 400, data: { message: 'number not on whatsapp' } }, message: 'Request failed' })).toBe(false);
    expect(isZombieGatewayBody([{ exists: true }])).toBe(false);
    expect(isZombieGatewayBody({ instance: { state: 'open' } })).toBe(false);
  });
});

describe('probeSocketHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVOLUTION_API_URL = 'http://evolution.test';
    process.env.EVOLUTION_API_KEY = 'test-key';
  });

  const mockPost = (impl) => {
    axios.create.mockReturnValue({
      post: jest.fn(impl),
      interceptors: { response: { use: jest.fn() } },
    });
  };

  test('reports ok on a real onWhatsApp response', async () => {
    mockPost(async () => ({ data: [{ jid: '923028588506@s.whatsapp.net', exists: true }] }));
    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    await expect(client.probeSocketHealth('923028588506')).resolves.toEqual({ ok: true, zombie: false });
  });

  test('classifies Connection Closed error responses as zombie', async () => {
    mockPost(async () => {
      const err = new Error('Request failed with status code 500');
      err.response = { status: 500, data: boomConnectionClosed };
      throw err;
    });
    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    const probe = await client.probeSocketHealth('923028588506');
    expect(probe.ok).toBe(false);
    expect(probe.zombie).toBe(true);
  });

  test('classifies Connection Closed body with HTTP 200 as zombie', async () => {
    mockPost(async () => ({ data: boomConnectionClosed }));
    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    const probe = await client.probeSocketHealth('923028588506');
    expect(probe.ok).toBe(false);
    expect(probe.zombie).toBe(true);
  });

  test('treats timeouts as indeterminate, not zombie', async () => {
    mockPost(async () => {
      throw new Error('timeout of 25000ms exceeded');
    });
    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    const probe = await client.probeSocketHealth('923028588506');
    expect(probe.ok).toBe(false);
    expect(probe.zombie).toBe(false);
  });
});

describe('restartInstance verb fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EVOLUTION_API_URL = 'http://evolution.test';
    process.env.EVOLUTION_API_KEY = 'test-key';
  });

  test('falls back to POST when PUT /instance/restart returns 404', async () => {
    const put = jest.fn(async () => {
      const err = new Error('Request failed with status code 404');
      err.response = { status: 404, data: { status: 404, error: 'Not Found' } };
      throw err;
    });
    const post = jest.fn(async () => ({ data: { instance: { instanceName: 'rozare-seller', state: 'open' } } }));
    axios.create.mockReturnValue({
      put,
      post,
      interceptors: { response: { use: jest.fn() } },
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    const result = await client.restartInstance();

    expect(put).toHaveBeenCalledWith('/instance/restart/rozare-seller');
    expect(post).toHaveBeenCalledWith('/instance/restart/rozare-seller');
    expect(result).toEqual({ instance: { instanceName: 'rozare-seller', state: 'open' } });
  });

  test('uses PUT result when the build supports it', async () => {
    const put = jest.fn(async () => ({ data: { restarted: true } }));
    const post = jest.fn();
    axios.create.mockReturnValue({
      put,
      post,
      interceptors: { response: { use: jest.fn() } },
    });

    const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
    const result = await client.restartInstance();

    expect(result).toEqual({ restarted: true });
    expect(post).not.toHaveBeenCalled();
  });
});
