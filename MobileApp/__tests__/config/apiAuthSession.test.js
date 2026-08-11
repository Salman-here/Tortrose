const mockRequestUse = jest.fn();
const mockResponseUse = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  interceptors: {
    request: { use: mockRequestUse },
    response: { use: mockResponseUse },
  },
}));
const mockGetItemAsync = jest.fn();
const mockNotifyUnauthorizedSession = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: mockAxiosCreate },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: mockGetItemAsync,
}));

jest.mock('../../src/utils/buyerLocation', () => ({
  getBuyerLocationParams: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/services/authSessionEvents', () => ({
  notifyUnauthorizedSession: mockNotifyUnauthorizedSession,
}));

describe('authenticated API session policy', () => {
  let requestInterceptor;
  let responseErrorInterceptor;

  beforeAll(() => {
    require('../../src/config/api');
    requestInterceptor = mockRequestUse.mock.calls[0][0];
    responseErrorInterceptor = mockResponseUse.mock.calls[0][1];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItemAsync.mockResolvedValue('new-account-token');
    mockNotifyUnauthorizedSession.mockResolvedValue(true);
  });

  it('preserves an explicit old-session token on detached logout cleanup', async () => {
    const config = {
      headers: { Authorization: 'Bearer old-account-token' },
      params: {},
    };

    const result = await requestInterceptor(config);

    expect(result.headers.Authorization).toBe('Bearer old-account-token');
  });

  it('adds the current stored token when the request has no explicit authorization', async () => {
    const config = { headers: {}, params: {} };

    const result = await requestInterceptor(config);

    expect(result.headers.Authorization).toBe('Bearer new-account-token');
  });

  it('runs durable logout only for a protected invalid-session response', async () => {
    mockGetItemAsync.mockResolvedValue('expired-token');
    const error = {
      config: { headers: { Authorization: 'Bearer expired-token' } },
      response: { status: 401, data: { code: 'AUTH_SESSION_INVALID' } },
    };

    await expect(responseErrorInterceptor(error)).rejects.toBe(error);

    expect(mockNotifyUnauthorizedSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a delayed response from the previous account', 'old-account-token', 'new-account-token'],
    ['a response from a token replaced inside the same account', 'pre-rotation-token', 'rotated-token'],
  ])('keeps the current session for %s', async (_label, failedToken, currentToken) => {
    mockGetItemAsync.mockResolvedValue(currentToken);
    const error = {
      config: { headers: { Authorization: `Bearer ${failedToken}` } },
      response: { status: 401, data: { code: 'AUTH_SESSION_INVALID' } },
    };

    await expect(responseErrorInterceptor(error)).rejects.toBe(error);

    expect(mockNotifyUnauthorizedSession).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary business 401', { status: 401, data: { msg: 'Username is required' } }, {}],
    ['missing-auth response', { status: 401, data: { code: 'AUTH_REQUIRED' } }, {}],
    ['anonymous invalid-session response', { status: 401, data: { code: 'AUTH_SESSION_INVALID' } }, { headers: {} }],
    ['detached cleanup response', { status: 401, data: { code: 'AUTH_SESSION_INVALID' } }, { skipAuthSessionCleanup: true }],
    ['server outage', { status: 500, data: { code: 'AUTH_SESSION_INVALID' } }, {}],
  ])('does not clear auth for %s', async (_label, response, configOverrides) => {
    const error = {
      config: {
        headers: { Authorization: 'Bearer valid-token' },
        ...configOverrides,
      },
      response,
    };

    await expect(responseErrorInterceptor(error)).rejects.toBe(error);

    expect(mockNotifyUnauthorizedSession).not.toHaveBeenCalled();
  });
});
