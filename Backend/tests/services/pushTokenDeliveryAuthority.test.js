const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../../models/User');
const ExpoPushTokenRegistration = require('../../models/ExpoPushTokenRegistration');
const {
  registerPushToken,
  revokePushToken,
} = require('../../services/pushTokenRevocationService');
const { hashPushToken, sendPushToUser } = require('../../utils/expoPush');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    json: jest.fn().mockResolvedValue({ data: [{ status: 'ok' }] }),
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    ExpoPushTokenRegistration.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('authoritative Expo installation ownership', () => {
  test('same-role accounts cannot authorize each other during raw-token ownership lag', async () => {
    const pushToken = 'ExpoPushToken[same-role-transfer-device]';
    const firstSeller = await User.create({
      username: 'first-same-role-seller',
      email: 'first-same-role-seller@test.com',
      password: 'password123',
      role: 'seller',
    });
    const secondSeller = await User.create({
      username: 'second-same-role-seller',
      email: 'second-same-role-seller@test.com',
      password: 'password123',
      role: 'seller',
    });

    await registerPushToken(secondSeller._id, pushToken);
    await User.updateOne(
      { _id: firstSeller._id },
      { $addToSet: { expoPushTokens: pushToken } }
    );

    await sendPushToUser(firstSeller._id, {
      title: 'Specific seller update',
      body: 'Must not reach the other same-role account.',
    });
    await sendPushToUser(secondSeller._id, {
      title: 'Specific seller update',
      body: 'This is the authoritative owner.',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const messages = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(pushToken);
    expect(messages[0].data).toEqual(expect.objectContaining({
      recipientUserId: String(secondSeller._id),
      targetRole: 'seller',
    }));
  });

  test('legacy raw tokens with no registry row are never delivered', async () => {
    const legacyToken = 'ExpoPushToken[legacy-user-array-only]';
    const account = await User.create({
      username: 'legacy-token-owner',
      email: 'legacy-token-owner@test.com',
      password: 'password123',
      role: 'user',
      expoPushTokens: [legacyToken],
    });

    await sendPushToUser(account._id, {
      title: 'Legacy token',
      body: 'Registry authority must reject this.',
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an interrupted account transfer cannot deliver through the old user token index', async () => {
    const pushToken = 'ExpoPushToken[interrupted-transfer-device]';
    const oldAccount = await User.create({
      username: 'old-push-owner',
      email: 'old-push-owner@test.com',
      password: 'password123',
      role: 'user',
      expoPushTokens: [pushToken],
    });
    const newAccount = await User.create({
      username: 'new-push-owner',
      email: 'new-push-owner@test.com',
      password: 'password123',
      role: 'seller',
    });

    const splitWriteFailure = jest.spyOn(User, 'updateMany')
      .mockRejectedValueOnce(new Error('synthetic crash after registry rotation'));
    await expect(registerPushToken(newAccount._id, pushToken))
      .rejects.toThrow('synthetic crash after registry rotation');
    splitWriteFailure.mockRestore();

    const registration = await ExpoPushTokenRegistration.findOne({
      tokenHash: hashPushToken(pushToken),
    }).lean();
    expect(String(registration.user)).toBe(String(newAccount._id));
    expect(registration.revokedAt).toBeNull();
    expect((await User.findById(oldAccount).lean()).expoPushTokens).toContain(pushToken);
    expect((await User.findById(newAccount).lean()).expoPushTokens).not.toContain(pushToken);

    await sendPushToUser(oldAccount._id, {
      title: 'Private buyer update',
      body: 'Must not reach the transferred installation.',
    });
    await sendPushToUser(newAccount._id, {
      title: 'Seller update',
      body: 'Unavailable until the raw token index is repaired.',
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an interrupted revoke cannot deliver through a token left on the user document', async () => {
    const pushToken = 'ExpoPushToken[interrupted-revoke-device]';
    const account = await User.create({
      username: 'revoked-push-owner',
      email: 'revoked-push-owner@test.com',
      password: 'password123',
      role: 'seller',
    });
    const { credential } = await registerPushToken(account._id, pushToken);

    const splitWriteFailure = jest.spyOn(User, 'updateMany')
      .mockRejectedValueOnce(new Error('synthetic crash after registry revoke'));
    await expect(revokePushToken(pushToken, credential))
      .rejects.toThrow('synthetic crash after registry revoke');
    splitWriteFailure.mockRestore();

    const registration = await ExpoPushTokenRegistration.findOne({
      tokenHash: hashPushToken(pushToken),
    }).lean();
    expect(registration.revokedAt).toBeInstanceOf(Date);
    expect((await User.findById(account).lean()).expoPushTokens).toContain(pushToken);

    await sendPushToUser(account._id, {
      title: 'Must stay revoked',
      body: 'The registry prevents delivery before raw-token cleanup retries.',
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
