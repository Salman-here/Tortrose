jest.mock('../../models/User', () => ({
  findById: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../models/ExpoPushTokenRegistration', () => ({
  find: jest.fn(),
}));

const User = require('../../models/User');
const ExpoPushTokenRegistration = require('../../models/ExpoPushTokenRegistration');
const {
  hashPushToken,
  isValidExpoToken,
  sendExpoPush,
  sendPushToUser,
} = require('../../utils/expoPush');

describe('Expo push audience ownership', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ data: [{ status: 'ok' }] }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('direct sends inject the database user and role, overriding caller hints', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: 'seller-user-1',
        role: 'seller',
        expoPushTokens: ['ExpoPushToken[seller-device]'],
      }),
    });
    ExpoPushTokenRegistration.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          tokenHash: hashPushToken('ExpoPushToken[seller-device]'),
          user: 'seller-user-1',
        }]),
      }),
    });

    await sendPushToUser('seller-user-1', {
      title: 'New order',
      body: 'A buyer placed an order.',
      data: {
        type: 'new_order',
        recipientUserId: 'spoofed-user',
        targetRole: 'user',
      },
    });

    const messages = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toEqual(expect.objectContaining({
      type: 'new_order',
      recipientUserId: 'seller-user-1',
      targetRole: 'seller',
    }));
  });

  test('fails closed when a raw token remains on the wrong account', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: 'old-buyer',
        role: 'user',
        expoPushTokens: ['ExpoPushToken[transferred-device]'],
      }),
    });
    ExpoPushTokenRegistration.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    await sendPushToUser('old-buyer', {
      title: 'Should not leak',
      body: 'This installation now belongs to another account.',
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(ExpoPushTokenRegistration.find).toHaveBeenCalledWith(expect.objectContaining({
      revokedAt: null,
      user: 'old-buyer',
    }));
  });

  test('rejects unscoped sends before consulting or calling Expo', async () => {
    const result = await sendExpoPush(
      ['ExpoPushToken[legacy-unscoped-device]'],
      { title: 'Unsafe', body: 'Must not send.', data: { targetRole: 'user' } }
    );

    expect(result).toEqual({ invalidTokens: [], sentCount: 0 });
    expect(ExpoPushTokenRegistration.find).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects legacy raw tokens without authoritative registration metadata', async () => {
    ExpoPushTokenRegistration.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    const result = await sendExpoPush(
      ['ExpoPushToken[legacy-owned-only-in-user-document]'],
      { title: 'Legacy', body: 'Must not send.', data: { targetRole: 'seller' } },
      { recipientUserId: 'seller-with-legacy-token' }
    );

    expect(result).toEqual({ invalidTokens: [], sentCount: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('validates complete Expo token syntax', () => {
    expect(isValidExpoToken('ExpoPushToken[device-123]')).toBe(true);
    expect(isValidExpoToken('ExponentPushToken[device_123]')).toBe(true);
    expect(isValidExpoToken('ExpoPushToken[')).toBe(false);
    expect(isValidExpoToken('ExpoPushToken[device] trailing')).toBe(false);
  });
});
