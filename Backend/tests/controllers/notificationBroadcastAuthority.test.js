jest.mock('../../models/User', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/Notification', () => ({
  insertMany: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock('../../models/BroadcastJob', () => ({
  create: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../models/WhatsAppConfig', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../utils/expoPush', () => ({
  sendExpoPushStrict: jest.fn().mockImplementation(async tokens => ({
    invalidTokens: [],
    sentCount: tokens.length,
  })),
}));
jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'email-id' }),
}));
jest.mock('../../services/whatsapp/evolutionClient', () => ({
  sendText: jest.fn().mockResolvedValue({ messageId: 'buyer-wa-id' }),
}));
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({
  sendText: jest.fn().mockResolvedValue({ messageId: 'seller-wa-id' }),
}));
jest.mock('../../services/whatsapp/gatewayMode', () => ({
  configKeyFor: logicalType => (logicalType === 'seller' ? 'seller' : 'main'),
}));

const User = require('../../models/User');
const Notification = require('../../models/Notification');
const BroadcastJob = require('../../models/BroadcastJob');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const { sendExpoPushStrict } = require('../../utils/expoPush');
const { sendEmail } = require('../../controllers/mailController');
const buyerEvolution = require('../../services/whatsapp/evolutionClient');
const sellerEvolution = require('../../services/whatsapp/sellerEvolutionClient');
const {
  _dispatchBroadcast,
  _computeNextFutureRunAt,
  _computeNextRunAt,
  _reapExpiredBroadcastLeases,
  audiencePreview,
  cancelBroadcast,
  createBroadcast,
  processDueBroadcasts,
  searchUsers,
} = require('../../controllers/notificationController');

const mockUserFind = (recipients) => {
  const lean = jest.fn().mockResolvedValue(recipients);
  const select = jest.fn().mockReturnValue({ lean });
  User.find.mockReturnValue({ select });
  return { lean, select };
};

const responseDouble = () => ({
  json: jest.fn(),
  status: jest.fn().mockReturnThis(),
});

describe('admin broadcast delivery authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Notification.insertMany.mockResolvedValue([]);
    WhatsAppConfig.findOne.mockImplementation(async ({ singletonKey }) => ({
      singletonKey,
      status: 'connected',
    }));
    buyerEvolution.sendText.mockResolvedValue({ messageId: 'buyer-wa-id' });
    sellerEvolution.sendText.mockResolvedValue({ messageId: 'seller-wa-id' });
    sendEmail.mockResolvedValue({ success: true, messageId: 'email-id' });
    sendExpoPushStrict.mockImplementation(async tokens => ({
      invalidTokens: [],
      sentCount: tokens.length,
    }));
  });

  test('excludes blocked, non-active, and wrong-role rows even if a stale query returns them', async () => {
    mockUserFind([
      {
        _id: 'active-buyer',
        role: 'user',
        status: 'active',
        email: 'active@example.com',
        expoPushTokens: ['ExpoPushToken[active]'],
        whatsappInfo: { number: '+92 300 111 2222', verified: true },
      },
      {
        _id: 'blocked-buyer',
        role: 'user',
        status: 'blocked',
        email: 'blocked@example.com',
        expoPushTokens: ['ExpoPushToken[blocked]'],
        whatsappInfo: { number: '+92 300 111 3333', verified: true },
      },
      {
        _id: 'missing-status-buyer',
        role: 'user',
        email: 'legacy@example.com',
        expoPushTokens: ['ExpoPushToken[legacy]'],
        whatsappInfo: { number: '+92 300 111 4444', verified: true },
      },
      {
        _id: 'active-seller',
        role: 'seller',
        status: 'active',
        email: 'seller@example.com',
        expoPushTokens: ['ExpoPushToken[seller]'],
        sellerInfo: { whatsappNumber: '+92 300 111 5555', whatsappVerified: true },
      },
    ]);

    const stats = await _dispatchBroadcast({
      _id: 'buyer-broadcast',
      title: 'Buyer update',
      body: 'For active buyers only.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['inapp', 'push', 'email', 'whatsapp'],
      createdBy: 'admin-1',
    });

    expect(User.find).toHaveBeenCalledWith({ role: 'user', status: 'active' });
    expect(stats).toEqual({ recipients: 1, pushSent: 1, emailSent: 1, whatsappSent: 1 });
    expect(Notification.insertMany.mock.calls[0][0]).toEqual([
      expect.objectContaining({ user: 'active-buyer', targetRole: 'user', audience: 'all_users' }),
    ]);
    expect(sendExpoPushStrict).toHaveBeenCalledTimes(1);
    expect(sendExpoPushStrict.mock.calls[0][1].data.recipientUserId).toBe('active-buyer');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('active@example.com');
    expect(buyerEvolution.sendText).toHaveBeenCalledWith(
      '923001112222',
      expect.stringContaining('For active buyers only.')
    );
    expect(sellerEvolution.sendText).not.toHaveBeenCalled();
  });

  test('uses only each role verified destination and honors the seller master preference', async () => {
    mockUserFind([
      {
        _id: 'buyer-verified', role: 'user', status: 'active',
        whatsappInfo: { number: '+92 301 000 0001', verified: true },
        sellerInfo: { phoneNumber: '+92 399 999 9901' },
      },
      {
        _id: 'buyer-unverified', role: 'user', status: 'active',
        whatsappInfo: { number: '+92 301 000 0002', verified: false },
        sellerInfo: {
          phoneNumber: '+92 399 999 9902',
          whatsappNumber: '+92 399 999 9903',
          whatsappVerified: true,
        },
      },
      {
        _id: 'seller-verified', role: 'seller', status: 'active',
        whatsappInfo: { number: '+92 398 888 8801', verified: true },
        sellerInfo: {
          phoneNumber: '+92 398 888 8802',
          whatsappNumber: '+92 302 000 0001',
          whatsappVerified: true,
        },
      },
      {
        _id: 'seller-unverified', role: 'seller', status: 'active',
        whatsappInfo: { number: '+92 398 888 8803', verified: true },
        sellerInfo: {
          phoneNumber: '+92 398 888 8804',
          whatsappNumber: '+92 302 000 0002',
          whatsappVerified: false,
        },
      },
      {
        _id: 'seller-disabled', role: 'seller', status: 'active',
        sellerInfo: { whatsappNumber: '+92 302 000 0003', whatsappVerified: true },
        whatsappNotificationPrefs: { enabled: false },
      },
      {
        _id: 'admin-selected', role: 'admin', status: 'active',
        whatsappInfo: { number: '+92 398 888 8805', verified: true },
        sellerInfo: { whatsappNumber: '+92 398 888 8806', whatsappVerified: true },
      },
      {
        _id: 'not-selected', role: 'user', status: 'active',
        whatsappInfo: { number: '+92 398 888 8807', verified: true },
      },
    ]);

    const selectedIds = [
      'buyer-verified',
      'buyer-unverified',
      'seller-verified',
      'seller-unverified',
      'seller-disabled',
      'admin-selected',
    ];
    const stats = await _dispatchBroadcast({
      _id: 'specific-broadcast',
      title: 'Selected update',
      body: 'Verified destinations only.',
      category: 'announcement',
      audience: 'specific',
      userIds: selectedIds,
      channels: ['whatsapp'],
    });

    expect(User.find).toHaveBeenCalledWith({ _id: { $in: selectedIds }, status: 'active' });
    expect(WhatsAppConfig.findOne.mock.calls.map(([query]) => query.singletonKey).sort())
      .toEqual(['main', 'seller']);
    expect(stats).toEqual({ recipients: 6, pushSent: 0, emailSent: 0, whatsappSent: 2 });
    expect(buyerEvolution.sendText).toHaveBeenCalledTimes(1);
    expect(buyerEvolution.sendText).toHaveBeenCalledWith(
      '923010000001',
      expect.stringContaining('Verified destinations only.')
    );
    expect(sellerEvolution.sendText).toHaveBeenCalledTimes(1);
    expect(sellerEvolution.sendText).toHaveBeenCalledWith(
      '923020000001',
      expect.stringContaining('Verified destinations only.')
    );

    const allDestinations = [
      ...buyerEvolution.sendText.mock.calls,
      ...sellerEvolution.sendText.mock.calls,
    ].map(([destination]) => destination);
    expect(allDestinations).not.toEqual(expect.arrayContaining([
      '923999999901',
      '923999999902',
      '923999999903',
      '923988888801',
      '923988888802',
      '923988888803',
      '923988888804',
      '923020000003',
      '923988888805',
      '923988888806',
      '923988888807',
    ]));
  });

  test('counts only successful WhatsApp provider attempts and respects per-instance connection state', async () => {
    mockUserFind([
      {
        _id: 'buyer-1', role: 'user', status: 'active',
        whatsappInfo: { number: '+92 303 000 0001', verified: true },
      },
      {
        _id: 'seller-1', role: 'seller', status: 'active',
        sellerInfo: { whatsappNumber: '+92 303 000 0002', whatsappVerified: true },
      },
    ]);
    WhatsAppConfig.findOne.mockImplementation(async ({ singletonKey }) => ({
      singletonKey,
      status: singletonKey === 'main' ? 'connected' : 'disconnected',
    }));

    const stats = await _dispatchBroadcast({
      _id: 'connection-scoped-broadcast',
      title: 'Connection scoped',
      body: 'Only connected logical instances send.',
      category: 'announcement',
      audience: 'both',
      channels: ['whatsapp'],
    });

    expect(stats.whatsappSent).toBe(1);
    expect(buyerEvolution.sendText).toHaveBeenCalledTimes(1);
    expect(sellerEvolution.sendText).not.toHaveBeenCalled();
  });

  test('does not report a verified destination as sent when its provider call fails', async () => {
    mockUserFind([
      {
        _id: 'buyer-1', role: 'user', status: 'active',
        whatsappInfo: { number: '+92 304 000 0001', verified: true },
      },
      {
        _id: 'seller-1', role: 'seller', status: 'active',
        sellerInfo: { whatsappNumber: '+92 304 000 0002', whatsappVerified: true },
      },
    ]);
    sellerEvolution.sendText.mockRejectedValueOnce(new Error('provider rejected send'));
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const stats = await _dispatchBroadcast({
      _id: 'provider-result-broadcast',
      title: 'Actual delivery count',
      body: 'Only successful sends count.',
      category: 'announcement',
      audience: 'both',
      channels: ['whatsapp'],
    });

    expect(buyerEvolution.sendText).toHaveBeenCalledTimes(1);
    expect(sellerEvolution.sendText).toHaveBeenCalledTimes(1);
    expect(stats.whatsappSent).toBe(1);
    warning.mockRestore();
  });

  test('does not count ambiguous provider responses without acceptance identifiers', async () => {
    mockUserFind([{
      _id: 'buyer-ambiguous',
      role: 'user',
      status: 'active',
      email: 'ambiguous@example.com',
      whatsappInfo: { number: '+92 305 000 0001', verified: true },
    }]);
    sendEmail.mockResolvedValueOnce({ success: true, messageId: '' });
    buyerEvolution.sendText.mockResolvedValueOnce({ messageId: '', raw: {} });

    const stats = await _dispatchBroadcast({
      _id: 'ambiguous-provider-broadcast',
      title: 'Acceptance proof',
      body: 'Only provider-confirmed attempts count.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['email', 'whatsapp'],
    });

    expect(stats).toEqual({ recipients: 1, pushSent: 0, emailSent: 0, whatsappSent: 0 });
  });

  test('counts only push tickets the provider actually accepted', async () => {
    mockUserFind([
      { _id: 'buyer-1', role: 'user', status: 'active', expoPushTokens: ['ExpoPushToken[first]'] },
      { _id: 'buyer-2', role: 'user', status: 'active', expoPushTokens: ['ExpoPushToken[second]'] },
    ]);
    sendExpoPushStrict
      .mockRejectedValueOnce(new Error('Expo unavailable'))
      .mockResolvedValueOnce({ sentCount: 1, ticketIds: ['ticket-2'] });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const stats = await _dispatchBroadcast({
      _id: 'strict-push-broadcast',
      title: 'Ticket accounting',
      body: 'Only accepted tickets count.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['push'],
    });

    expect(stats).toEqual({ recipients: 2, pushSent: 1, emailSent: 0, whatsappSent: 0 });
    expect(sendExpoPushStrict).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  test('does not hide a real in-app persistence failure as a successful run', async () => {
    mockUserFind([{ _id: 'buyer-1', role: 'user', status: 'active' }]);
    const outage = Object.assign(new Error('database unavailable'), { code: 91 });
    Notification.insertMany.mockRejectedValueOnce(outage);

    await expect(_dispatchBroadcast({
      _id: 'inapp-persistence-failure',
      title: 'Must persist',
      body: 'A failed insert cannot be called delivered.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['inapp'],
      runCount: 0,
    })).rejects.toBe(outage);
  });

  test('audience preview and recipient search both require active accounts', async () => {
    User.countDocuments.mockResolvedValue(4);
    const previewRes = responseDouble();
    await audiencePreview(
      { user: { role: 'admin' }, query: { audience: 'both' } },
      previewRes
    );

    expect(User.countDocuments).toHaveBeenCalledWith({
      role: { $in: ['user', 'seller'] },
      status: 'active',
    });
    expect(previewRes.json).toHaveBeenCalledWith({ count: 4 });

    const lean = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ lean });
    const select = jest.fn().mockReturnValue({ limit });
    User.find.mockReturnValue({ select });
    const searchRes = responseDouble();
    await searchUsers(
      { user: { role: 'admin' }, query: { q: 'sam', role: 'seller' } },
      searchRes
    );

    const searchQuery = User.find.mock.calls[0][0];
    expect(searchQuery).toEqual(expect.objectContaining({ status: 'active', role: 'seller' }));
    expect(searchQuery.$or).toEqual(expect.any(Array));
  });

  test('assigns stable per-run, per-recipient in-app dedupe keys on replay', async () => {
    mockUserFind([
      { _id: 'buyer-1', role: 'user', status: 'active' },
      { _id: 'buyer-2', role: 'user', status: 'active' },
    ]);
    const replayedJob = {
      _id: 'broadcast-replay-1',
      title: 'Replay-safe update',
      body: 'The inbox copy must remain singular.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['inapp'],
      runCount: 4,
    };
    Notification.insertMany
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('duplicate dedupe keys'), { code: 11000 }));

    await _dispatchBroadcast(replayedJob);
    await _dispatchBroadcast(replayedJob);

    const firstKeys = Notification.insertMany.mock.calls[0][0].map(doc => doc.dedupeKey);
    const replayKeys = Notification.insertMany.mock.calls[1][0].map(doc => doc.dedupeKey);
    expect(firstKeys).toEqual([
      'admin-broadcast:broadcast-replay-1:run:4:user:buyer-1',
      'admin-broadcast:broadcast-replay-1:run:4:user:buyer-2',
    ]);
    expect(replayKeys).toEqual(firstKeys);
    expect(new Set(firstKeys)).toHaveProperty('size', 2);
  });
});

describe('admin broadcast scheduler claim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Notification.insertMany.mockResolvedValue([]);
    BroadcastJob.updateMany.mockResolvedValue({ modifiedCount: 0 });
    BroadcastJob.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  test('two overlapping workers can claim and dispatch a due job only once', async () => {
    mockUserFind([{ _id: 'buyer-1', role: 'user', status: 'active' }]);
    const dueAt = new Date('2026-08-24T00:00:00.000Z');
    const job = {
      _id: 'due-job-1',
      title: 'One delivery',
      body: 'This must not be duplicated.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['inapp'],
      scheduleType: 'one_time',
      recurrence: 'none',
      nextRunAt: dueAt,
      stats: { recipients: 0, pushSent: 0, emailSent: 0, whatsappSent: 0 },
      runCount: 0,
    };
    let claimed = false;
    BroadcastJob.findOneAndUpdate.mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      job.status = 'sending';
      return job;
    });

    await Promise.all([processDueBroadcasts(), processDueBroadcasts()]);

    expect(Notification.insertMany).toHaveBeenCalledTimes(1);
    expect(job.status).toBe('sent');
    expect(job.nextRunAt).toBeNull();
    expect(job.runCount).toBe(1);
    expect(job.stats.recipients).toBe(1);
    expect(BroadcastJob.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'scheduled',
        nextRunAt: { $lte: expect.any(Date) },
      }),
      {
        $set: expect.objectContaining({
          status: 'sending',
          leaseToken: expect.any(String),
          leaseAcquiredAt: expect.any(Date),
          leaseExpiresAt: expect.any(Date),
        }),
      },
      { new: true, sort: { nextRunAt: 1, _id: 1 } }
    );
  });

  test('an immediate request owns its job before cron can see it as scheduled', async () => {
    mockUserFind([{ _id: 'buyer-1', role: 'user', status: 'active' }]);
    BroadcastJob.create.mockImplementation(async data => ({
      ...data,
      _id: 'immediate-job-1',
      stats: { recipients: 0, pushSent: 0, emailSent: 0, whatsappSent: 0 },
    }));
    const req = {
      user: { id: 'admin-1', role: 'admin' },
      body: {
        title: 'Immediate update',
        body: 'Owned by the request.',
        audience: 'all_users',
        channels: ['inapp'],
        scheduleType: 'immediate',
      },
    };
    const res = responseDouble();

    await createBroadcast(req, res);

    expect(BroadcastJob.create).toHaveBeenCalledWith(expect.objectContaining({
      scheduleType: 'immediate',
      status: 'sending',
      leaseToken: expect.any(String),
      leaseAcquiredAt: expect.any(Date),
      leaseExpiresAt: expect.any(Date),
    }));
    expect(Notification.insertMany).toHaveBeenCalledTimes(1);
    expect(BroadcastJob.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'immediate-job-1',
        status: 'sending',
        leaseToken: expect.any(String),
      }),
      expect.any(Object)
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].job.leaseToken).toBeUndefined();
  });

  test('cancellation cannot overwrite a job after a scheduler worker claimed it', async () => {
    const jobId = '64f000000000000000000001';
    BroadcastJob.findOneAndUpdate.mockResolvedValue(null);
    BroadcastJob.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: jobId, status: 'sending' }),
    });
    const res = responseDouble();

    await cancelBroadcast(
      { user: { role: 'admin' }, params: { id: jobId } },
      res
    );

    expect(BroadcastJob.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: jobId, status: 'scheduled' },
      expect.any(Object),
      { new: true }
    );
    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('requeues expired and legacy abandoned sending leases for an atomic reclaim', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z');

    await _reapExpiredBroadcastLeases(now);

    expect(BroadcastJob.updateMany).toHaveBeenCalledWith(
      {
        status: 'sending',
        $or: [
          { leaseExpiresAt: { $lte: now } },
          { leaseExpiresAt: null, updatedAt: { $lte: expect.any(Date) } },
        ],
      },
      {
        $set: expect.objectContaining({
          status: 'scheduled',
          leaseToken: '',
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
        }),
        $inc: { leaseRecoveryCount: 1 },
      }
    );
    const legacyCutoff = BroadcastJob.updateMany.mock.calls[0][0].$or[1].updatedAt.$lte;
    expect(now.getTime() - legacyCutoff.getTime()).toBe(15 * 60 * 1000);
  });

  test('a worker whose lease expired cannot continue into recipient delivery', async () => {
    mockUserFind([{ _id: 'buyer-1', role: 'user', status: 'active' }]);
    BroadcastJob.updateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    await expect(_dispatchBroadcast({
      _id: 'lost-lease-job',
      title: 'Do not send',
      body: 'A replacement worker owns this run.',
      category: 'announcement',
      audience: 'all_users',
      channels: ['inapp'],
      runCount: 0,
    }, { leaseToken: 'stale-token' })).rejects.toMatchObject({
      code: 'BROADCAST_LEASE_LOST',
    });

    expect(User.find).not.toHaveBeenCalled();
    expect(Notification.insertMany).not.toHaveBeenCalled();
  });

  test('monthly recurrence clamps February but retains the original UTC day anchor', () => {
    const commonYearJanuary = new Date('2023-01-31T18:45:30.000Z');
    const commonFebruary = _computeNextRunAt(commonYearJanuary, 'monthly', 31);
    const commonMarch = _computeNextRunAt(commonFebruary, 'monthly', 31);
    expect(commonFebruary.toISOString()).toBe('2023-02-28T18:45:30.000Z');
    expect(commonMarch.toISOString()).toBe('2023-03-31T18:45:30.000Z');

    const leapYearJanuary = new Date('2024-01-31T18:45:30.000Z');
    const leapFebruary = _computeNextRunAt(leapYearJanuary, 'monthly', 31);
    const leapMarch = _computeNextRunAt(leapFebruary, 'monthly', 31);
    expect(leapFebruary.toISOString()).toBe('2024-02-29T18:45:30.000Z');
    expect(leapMarch.toISOString()).toBe('2024-03-31T18:45:30.000Z');
  });

  test('an overdue recurring broadcast advances once to the first future UTC occurrence', () => {
    expect(_computeNextFutureRunAt(
      new Date('2023-01-31T18:45:30.000Z'),
      'monthly',
      31,
      new Date('2023-03-01T00:00:00.000Z')
    ).toISOString()).toBe('2023-03-31T18:45:30.000Z');

    expect(_computeNextFutureRunAt(
      new Date('2026-08-01T10:00:00.000Z'),
      'daily',
      null,
      new Date('2026-08-24T10:00:00.000Z')
    ).toISOString()).toBe('2026-08-25T10:00:00.000Z');
  });
});
