jest.mock('../../models/BroadcastJob', () => ({
  create: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const BroadcastJob = require('../../models/BroadcastJob');
const {
  BROADCAST_DELIVERY_LEASE_MS,
  cancelScheduledBroadcast,
  createBroadcastJob,
  normalizeBroadcastCreateInput,
} = require('../../services/broadcastJobService');

const ADMIN_ID = '64f000000000000000000001';
const BUYER_ID = '64f000000000000000000002';
const JOB_ID = '64f000000000000000000003';

describe('broadcast job creation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    BroadcastJob.create.mockImplementation(async data => ({ ...data, _id: JOB_ID }));
  });

  test('normalizes one canonical monthly schedule for every caller', async () => {
    const firstRun = new Date('2024-01-31T18:45:30.000Z');
    const end = new Date('2024-05-31T18:45:30.000Z');
    const { job, leaseToken } = await createBroadcastJob({
      input: {
        title: '  Monthly update  ',
        body: '  One authoritative schedule.  ',
        audience: 'specific',
        userIds: [BUYER_ID, BUYER_ID],
        channels: ['inapp', 'push', 'push'],
        scheduleType: 'recurring',
        scheduledAt: firstRun,
        recurrence: 'monthly',
        endsAt: end,
      },
      createdBy: ADMIN_ID,
      claimImmediate: false,
      now: new Date('2024-01-01T00:00:00.000Z'),
    });

    expect(leaseToken).toBe('');
    expect(job).toEqual(expect.objectContaining({
      title: 'Monthly update',
      body: 'One authoritative schedule.',
      audience: 'specific',
      userIds: [BUYER_ID],
      channels: ['inapp', 'push'],
      scheduleType: 'recurring',
      recurrence: 'monthly',
      recurrenceAnchorDay: 31,
      nextRunAt: firstRun,
      endsAt: end,
      status: 'scheduled',
      createdBy: ADMIN_ID,
    }));
  });

  test('claims an immediate web request before it becomes scheduler-visible', async () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    const { job, leaseToken } = await createBroadcastJob({
      input: { title: 'Now', body: 'Owned immediately.' },
      createdBy: ADMIN_ID,
      claimImmediate: true,
      now,
    });

    expect(leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(job.status).toBe('sending');
    expect(job.leaseToken).toBe(leaseToken);
    expect(job.leaseAcquiredAt).toEqual(now);
    expect(job.leaseExpiresAt.getTime() - now.getTime()).toBe(BROADCAST_DELIVERY_LEASE_MS);
  });

  test.each([
    [
      'missing recurrence',
      {
        title: 'Recurring', body: 'Missing cadence.', scheduleType: 'recurring',
        scheduledAt: '2026-08-25T00:00:00.000Z',
      },
      'require recurrence',
    ],
    [
      'end before first run',
      {
        title: 'Recurring', body: 'Invalid window.', scheduleType: 'recurring',
        scheduledAt: '2026-08-25T00:00:00.000Z', recurrence: 'daily',
        endsAt: '2026-08-24T00:00:00.000Z',
      },
      'cannot be before',
    ],
    [
      'invalid specific recipient',
      {
        title: 'Specific', body: 'Invalid recipient.', audience: 'specific',
        userIds: ['not-an-object-id'],
      },
      'valid user identifier',
    ],
  ])('rejects %s before a job can be persisted', async (_label, input, message) => {
    await expect(createBroadcastJob({ input, createdBy: ADMIN_ID })).rejects.toMatchObject({
      code: 'BROADCAST_INPUT_INVALID',
      message: expect.stringContaining(message),
    });
    expect(BroadcastJob.create).not.toHaveBeenCalled();
  });

  test('the pure normalization contract rejects unsupported channels', () => {
    expect(() => normalizeBroadcastCreateInput({
      title: 'Bad channel',
      body: 'Do not persist.',
      channels: ['sms'],
    })).toThrow(expect.objectContaining({ code: 'BROADCAST_INPUT_INVALID' }));
  });
});

describe('broadcast cancellation authority', () => {
  beforeEach(() => jest.clearAllMocks());

  test('atomically cancels only a still-scheduled job', async () => {
    BroadcastJob.findOneAndUpdate.mockResolvedValue({
      _id: JOB_ID,
      title: 'Scheduled job',
      status: 'cancelled',
    });

    const result = await cancelScheduledBroadcast(JOB_ID);

    expect(result.outcome).toBe('cancelled');
    expect(BroadcastJob.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: JOB_ID, status: 'scheduled' },
      {
        $set: expect.objectContaining({
          status: 'cancelled',
          nextRunAt: null,
          leaseToken: '',
        }),
      },
      { new: true }
    );
    expect(BroadcastJob.findById).not.toHaveBeenCalled();
  });

  test('cannot overwrite a sending job after the scheduler wins the claim race', async () => {
    BroadcastJob.findOneAndUpdate.mockResolvedValue(null);
    BroadcastJob.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: JOB_ID, status: 'sending' }),
    });

    const result = await cancelScheduledBroadcast(JOB_ID);

    expect(result).toEqual({ outcome: 'sending', job: null, status: 'sending' });
    expect(BroadcastJob.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
