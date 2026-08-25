jest.mock('../../models/BroadcastJob', () => ({
  create: jest.fn(),
  find: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const BroadcastJob = require('../../models/BroadcastJob');
const { executeToolCall } = require('../../services/aiActionExecutor');

const ADMIN_ID = '64f000000000000000000011';
const JOB_ID = '64f000000000000000000012';
const admin = { _id: ADMIN_ID, role: 'admin', currency: 'USD' };

describe('AI broadcast action uses the authoritative job contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    BroadcastJob.create.mockImplementation(async data => ({ ...data, _id: JOB_ID }));
  });

  test('rejects an incomplete recurring schedule before persistence', async () => {
    const result = await executeToolCall('send_broadcast', {
      title: 'Incomplete recurrence',
      message: 'This must fail closed.',
      scheduleType: 'recurring',
      scheduledAt: '2026-08-25T10:00:00.000Z',
    }, admin);

    expect(result).toEqual(expect.objectContaining({
      success: false,
      code: 'BROADCAST_INPUT_INVALID',
      error: expect.stringContaining('require recurrence'),
    }));
    expect(BroadcastJob.create).not.toHaveBeenCalled();
  });

  test('persists an AI monthly broadcast with the same UTC calendar anchor', async () => {
    const result = await executeToolCall('send_broadcast', {
      title: 'Month end',
      message: 'Run at month end.',
      scheduleType: 'recurring',
      scheduledAt: '2027-01-31T09:30:00.000Z',
      recurrence: 'monthly',
      channels: ['inapp', 'email'],
      audience: 'all_users',
    }, admin);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      data: { broadcastId: JOB_ID },
    }));
    expect(BroadcastJob.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Month end',
      body: 'Run at month end.',
      status: 'scheduled',
      scheduleType: 'recurring',
      recurrence: 'monthly',
      recurrenceAnchorDay: 31,
      leaseToken: '',
    }));
  });

  test('AI cancellation cannot overwrite a job whose delivery already started', async () => {
    BroadcastJob.findOneAndUpdate.mockResolvedValue(null);
    BroadcastJob.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: JOB_ID, status: 'sending' }),
    });

    const result = await executeToolCall('cancel_broadcast', { broadcastId: JOB_ID }, admin);

    expect(result).toEqual({
      success: false,
      error: 'Broadcast delivery has already started and can no longer be cancelled.',
    });
    expect(BroadcastJob.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: JOB_ID, status: 'scheduled' },
      expect.any(Object),
      { new: true }
    );
  });
});
