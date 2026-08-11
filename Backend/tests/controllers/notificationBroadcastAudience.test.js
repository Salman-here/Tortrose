jest.mock('../../models/User', () => ({
  find: jest.fn(),
}));
jest.mock('../../models/Notification', () => ({
  insertMany: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../../models/BroadcastJob', () => ({
  updateOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../utils/expoPush', () => ({
  sendExpoPush: jest.fn().mockImplementation(async tokens => ({
    invalidTokens: [],
    sentCount: tokens.length,
  })),
}));
jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn(),
}));
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({
  sendText: jest.fn(),
}));

const User = require('../../models/User');
const Notification = require('../../models/Notification');
const BroadcastJob = require('../../models/BroadcastJob');
const { sendExpoPush } = require('../../utils/expoPush');
const {
  _dispatchBroadcast,
  createBroadcast,
  listMine,
  markAllRead,
} = require('../../controllers/notificationController');

describe('notification broadcast audience metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('scopes every push to one canonical database user and role', async () => {
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'buyer-1', role: 'user', expoPushTokens: ['ExpoPushToken[buyer]'] },
          { _id: 'seller-1', role: 'seller', expoPushTokens: ['ExpoPushToken[seller]'] },
        ]),
      }),
    });

    const stats = await _dispatchBroadcast({
      _id: 'broadcast-1',
      title: 'Platform update',
      body: 'A new release is available.',
      category: 'announcement',
      audience: 'both',
      channels: ['push'],
      userIds: [],
    });

    expect(stats).toMatchObject({ recipients: 2, pushSent: 2 });
    expect(sendExpoPush).toHaveBeenCalledTimes(2);
    const callsByUser = new Map(sendExpoPush.mock.calls.map(([, payload, scope]) => [
      payload.data.recipientUserId,
      { payload, scope },
    ]));
    expect(callsByUser.get('buyer-1').payload.data).toEqual(expect.objectContaining({
      audience: 'both',
      recipientUserId: 'buyer-1',
      targetRole: 'user',
    }));
    expect(callsByUser.get('buyer-1').scope).toEqual({ recipientUserId: 'buyer-1' });
    expect(callsByUser.get('seller-1').payload.data).toEqual(expect.objectContaining({
      audience: 'both',
      recipientUserId: 'seller-1',
      targetRole: 'seller',
    }));
    expect(callsByUser.get('seller-1').scope).toEqual({ recipientUserId: 'seller-1' });
  });

  test('persists the exact recipient role and originating audience for every in-app delivery', async () => {
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'buyer-1', role: 'user' },
          { _id: 'seller-1', role: 'seller' },
        ]),
      }),
    });
    Notification.insertMany.mockResolvedValue([]);

    await _dispatchBroadcast({
      _id: 'broadcast-inapp',
      title: 'Role-safe update',
      body: 'Only the intended role may keep this notification.',
      category: 'announcement',
      audience: 'both',
      channels: ['inapp'],
      createdBy: 'admin-1',
    });

    expect(Notification.insertMany).toHaveBeenCalledTimes(1);
    const [docs] = Notification.insertMany.mock.calls[0];
    expect(docs).toEqual([
      expect.objectContaining({ user: 'buyer-1', targetRole: 'user', audience: 'both' }),
      expect.objectContaining({ user: 'seller-1', targetRole: 'seller', audience: 'both' }),
    ]);
  });

  test('does not share one authorization scope between same-role specific recipients', async () => {
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'seller-a', role: 'seller', expoPushTokens: ['ExpoPushToken[stale-index]'] },
          { _id: 'seller-b', role: 'seller', expoPushTokens: ['ExpoPushToken[current-owner]'] },
        ]),
      }),
    });

    await _dispatchBroadcast({
      _id: 'broadcast-specific',
      title: 'Account update',
      body: 'Only the intended account may accept this push.',
      category: 'announcement',
      audience: 'specific',
      channels: ['push'],
      userIds: ['seller-a', 'seller-b'],
    });

    expect(sendExpoPush).toHaveBeenCalledTimes(2);
    for (const [, payload, scope] of sendExpoPush.mock.calls) {
      expect(scope).toEqual({ recipientUserId: payload.data.recipientUserId });
      expect(payload.data.targetRole).toBe('seller');
      expect(payload.data.audience).toBe('specific');
    }
    expect(sendExpoPush.mock.calls.map(([, payload]) => payload.data.recipientUserId).sort())
      .toEqual(['seller-a', 'seller-b']);
  });

  test('rejects an unknown audience before creating or dispatching a broadcast', async () => {
    const req = {
      user: { id: 'admin-1', role: 'admin' },
      body: {
        title: 'Unsafe target',
        body: 'This must not fan out.',
        audience: 'everyone',
        channels: ['inapp'],
      },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await createBroadcast(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('Invalid audience') }));
    expect(BroadcastJob.create).not.toHaveBeenCalled();
    expect(User.find).not.toHaveBeenCalled();
  });

  test('applies the current database role boundary to list and mark-all queries', async () => {
    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ limit });
    Notification.find.mockReturnValue({ sort });
    Notification.countDocuments.mockResolvedValue(0);
    Notification.updateMany.mockResolvedValue({ modifiedCount: 0 });
    const req = { user: { id: 'account-1', role: 'user' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    await listMine(req, res);
    await markAllRead(req, res);

    const listQuery = Notification.find.mock.calls[0][0];
    const unreadQuery = Notification.countDocuments.mock.calls[0][0];
    const markQuery = Notification.updateMany.mock.calls[0][0];
    for (const query of [listQuery, unreadQuery, markQuery]) {
      expect(query).toEqual(expect.objectContaining({
        user: 'account-1',
        $or: expect.any(Array),
      }));
      expect(JSON.stringify(query)).toContain('targetRole');
      expect(JSON.stringify(query)).toContain('seller');
    }
    expect(unreadQuery.read).toBe(false);
    expect(markQuery.read).toBe(false);
  });
});
