const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({
  isConfigured: jest.fn(() => true),
  checkWhatsAppNumber: jest.fn(() => Promise.resolve(true)),
  sendText: jest.fn(() => Promise.resolve()),
}));

const User = require('../../models/User');
const WhatsAppOTP = require('../../models/WhatsAppOTP');
const WhatsAppOTPRateEvent = require('../../models/WhatsAppOTPRateEvent');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber');
const sellerEvolutionClient = require('../../services/whatsapp/sellerEvolutionClient');
const {
  sendWhatsAppOTP,
  verifyWhatsAppOTP,
  consumeVerifiedWhatsAppNumber,
  getWhatsAppPrefs,
  updateWhatsAppPrefs,
} = require('../../controllers/sellerWhatsappController');

let mongoServer;

const resMock = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeUser = (overrides = {}) =>
  User.create({
    username: overrides.username || `user-${Date.now()}-${Math.random()}`,
    email: overrides.email || `user-${Date.now()}-${Math.random()}@example.com`,
    role: overrides.role || 'user',
    isVerified: true,
    sellerInfo: overrides.sellerInfo || {},
  });

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    WhatsAppOTP.deleteMany({}),
    WhatsAppConfig.deleteMany({}),
    WhatsAppOTPRateEvent.deleteMany({}),
    AdminWhatsAppNumber.deleteMany({}),
  ]);
  jest.clearAllMocks();
  sellerEvolutionClient.isConfigured.mockReturnValue(true);
  sellerEvolutionClient.checkWhatsAppNumber.mockResolvedValue(true);
  sellerEvolutionClient.sendText.mockResolvedValue();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe('seller WhatsApp verification', () => {
  const connectGateway = () => WhatsAppConfig.create({ singletonKey: 'seller', status: 'connected' });

  test('allows an authenticated seller to verify their own current unverified number', async () => {
    await connectGateway();
    const seller = await makeUser({
      role: 'seller',
      sellerInfo: { whatsappNumber: '+923001112222', whatsappVerified: false },
    });
    const req = {
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923001112222' },
    };
    const res = resMock();

    await sendWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sellerEvolutionClient.sendText).toHaveBeenCalledWith('923001112222', expect.stringContaining('Rozare Verification'));
    await expect(WhatsAppOTP.findOne({ number: '923001112222', sellerId: seller._id })).resolves.toBeTruthy();
  });

  test('still rejects a seller trying to send an OTP to their already verified current number', async () => {
    await connectGateway();
    const seller = await makeUser({
      role: 'seller',
      sellerInfo: { whatsappNumber: '+923001112222', whatsappVerified: true },
    });
    const req = {
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923001112222' },
    };
    const res = resMock();

    await sendWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('still rejects a number belonging to another seller', async () => {
    await connectGateway();
    const owner = await makeUser({
      role: 'seller',
      sellerInfo: { whatsappNumber: '+923001112222', whatsappVerified: false },
    });
    const requester = await makeUser({ role: 'seller' });
    const req = {
      user: { id: requester._id, role: 'seller' },
      body: { whatsappNumber: owner.sellerInfo.whatsappNumber },
    };
    const res = resMock();

    await sendWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('normalizes legacy phone formatting when checking cross-account ownership', async () => {
    await connectGateway();
    await makeUser({
      role: 'seller',
      sellerInfo: { whatsappNumber: '+92 (300) 111-2222', whatsappVerified: false },
    });
    const requester = await makeUser({ role: 'seller' });
    const response = resMock();

    await sendWhatsAppOTP({
      user: { id: requester._id, role: 'seller' },
      body: { whatsappNumber: '923001112222' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('rejects numbers verified for a buyer role or reserved for an admin', async () => {
    await connectGateway();
    const requester = await makeUser({ role: 'seller' });
    await makeUser({
      role: 'user',
      whatsappInfo: undefined,
    }).then(user => User.updateOne(
      { _id: user._id },
      { $set: { whatsappInfo: { number: '+923001118888', verified: true } } }
    ));
    await AdminWhatsAppNumber.create({
      number: '923001117777',
      isActive: true,
      addedBy: new mongoose.Types.ObjectId(),
    });

    const buyerConflict = resMock();
    await sendWhatsAppOTP({
      user: { id: requester._id, role: 'seller' },
      body: { whatsappNumber: '+923001118888' },
    }, buyerConflict);
    const adminConflict = resMock();
    await sendWhatsAppOTP({
      user: { id: requester._id, role: 'seller' },
      body: { whatsappNumber: '+923001117777' },
    }, adminConflict);

    expect(buyerConflict.status).toHaveBeenCalledWith(409);
    expect(adminConflict.status).toHaveBeenCalledWith(409);
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('atomically caps parallel sends at three rolling one-hour slots', async () => {
    await connectGateway();
    const buyer = await makeUser({ role: 'user' });
    const requests = Array.from({ length: 6 }, () => {
      const response = resMock();
      return {
        response,
        promise: sendWhatsAppOTP({
          user: { id: buyer._id, role: 'user' },
          body: { whatsappNumber: '+923009991111' },
        }, response),
      };
    });

    await Promise.all(requests.map(entry => entry.promise));

    const statuses = requests.map(entry => entry.response.status.mock.calls.at(-1)?.[0]);
    expect(statuses.filter(status => status === 200)).toHaveLength(3);
    expect(statuses.filter(status => status === 429)).toHaveLength(3);
    expect(sellerEvolutionClient.sendText).toHaveBeenCalledTimes(3);
    await expect(WhatsAppOTPRateEvent.countDocuments({ scope: 'number:923009991111' })).resolves.toBe(3);

    // Deleting/consuming short-lived OTP proofs must not reset the send quota.
    await WhatsAppOTP.deleteMany({ number: '923009991111' });
    const blocked = resMock();
    await sendWhatsAppOTP({
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923009991111' },
    }, blocked);
    expect(blocked.status).toHaveBeenCalledWith(429);

    // Each slot becomes reclaimable after its own full one-hour window, even
    // if MongoDB's TTL monitor has not physically deleted the row yet.
    await WhatsAppOTPRateEvent.updateMany(
      { scope: 'number:923009991111' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const afterWindow = resMock();
    await sendWhatsAppOTP({
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923009991111' },
    }, afterWindow);
    expect(afterWindow.status).toHaveBeenCalledWith(200);
  });

  test('does not allow a legacy unverified self-match to hide another seller conflict', async () => {
    await connectGateway();
    const requester = await makeUser({
      role: 'seller',
      sellerInfo: { whatsappNumber: '+923001112222', whatsappVerified: false },
    });
    await makeUser({
      role: 'seller',
      sellerInfo: { phoneNumber: '923001112222', whatsappVerified: false },
    });
    const req = {
      user: { id: requester._id, role: 'seller' },
      body: { whatsappNumber: '+923001112222' },
    };
    const res = resMock();

    await sendWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('keeps verified OTP proof for an authenticated buyer becoming a seller', async () => {
    const buyer = await makeUser({ role: 'user' });
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: buyer._id,
      attempts: 0,
      verified: false,
    });

    const req = {
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923001112222', otp: '123456' },
    };
    const res = resMock();

    await verifyWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const otpRecord = await WhatsAppOTP.findOne({ number: '923001112222' });
    expect(otpRecord).toBeTruthy();
    expect(otpRecord.verified).toBe(true);
    expect(otpRecord.verifiedAt).toBeTruthy();

    const updatedBuyer = await User.findById(buyer._id);
    expect(updatedBuyer.sellerInfo?.whatsappVerified).not.toBe(true);
  });

  test('binds OTP verification to the account that requested the code', async () => {
    const owner = await makeUser({ role: 'seller' });
    const otherSeller = await makeUser({ role: 'seller' });
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: owner._id,
      attempts: 0,
      verified: false,
    });

    const req = {
      user: { id: otherSeller._id, role: 'seller' },
      body: { whatsappNumber: '+923001112222', otp: '123456' },
    };
    const res = resMock();

    await verifyWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    await expect(WhatsAppOTP.findOne({ sellerId: owner._id })).resolves.toBeTruthy();
    await expect(User.findById(otherSeller._id).then((user) => user.sellerInfo?.whatsappVerified)).resolves.not.toBe(true);
  });

  test('increments wrong attempts atomically under parallel guesses', async () => {
    const buyer = await makeUser({ role: 'user' });
    const otpRecord = await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: buyer._id,
      attempts: 0,
      verified: false,
    });

    await Promise.all(Array.from({ length: 10 }, () => verifyWhatsAppOTP({
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923001112222', otp: '000000' },
    }, resMock())));

    const updated = await WhatsAppOTP.findById(otpRecord._id);
    expect(updated.attempts).toBe(5);
    expect(updated.verified).toBe(false);
  });

  test('allows only one parallel correct verification and one proof consumption', async () => {
    const buyer = await makeUser({ role: 'user' });
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: buyer._id,
      attempts: 0,
      verified: false,
    });
    const responses = [resMock(), resMock()];

    await Promise.all(responses.map(response => verifyWhatsAppOTP({
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923001112222', otp: '123456' },
    }, response)));

    const statuses = responses.map(response => response.status.mock.calls.at(-1)?.[0]);
    expect(statuses.filter(status => status === 200)).toHaveLength(1);
    expect(statuses.filter(status => status === 400)).toHaveLength(1);

    const consumed = await Promise.all([
      consumeVerifiedWhatsAppNumber('+923001112222', buyer._id),
      consumeVerifiedWhatsAppNumber('+92 (300) 111-2222', buyer._id),
    ]);
    expect(consumed.sort()).toEqual([false, true]);
  });

  test('never verifies a retained OTP after its two-minute entry window', async () => {
    const buyer = await makeUser({ role: 'user' });
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: buyer._id,
      attempts: 0,
      verified: false,
      createdAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const response = resMock();

    await verifyWhatsAppOTP({
      user: { id: buyer._id, role: 'user' },
      body: { whatsappNumber: '+923001112222', otp: '123456' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    await expect(WhatsAppOTP.findOne({ sellerId: buyer._id }).then(record => record.verified)).resolves.toBe(false);
  });

  test('consumes verified OTP proof once during seller activation', async () => {
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      attempts: 0,
      verified: true,
      verifiedAt: new Date(),
    });

    await expect(consumeVerifiedWhatsAppNumber('+923001112222')).resolves.toBe(true);
    await expect(consumeVerifiedWhatsAppNumber('+923001112222')).resolves.toBe(false);
  });

  test('only consumes a buyer-bound verification for that buyer', async () => {
    const buyer = await makeUser({ role: 'user' });
    const otherBuyer = await makeUser({ role: 'user' });
    await WhatsAppOTP.create({
      number: '923001112222',
      otp: '123456',
      sellerId: buyer._id,
      attempts: 0,
      verified: true,
      verifiedAt: new Date(),
    });

    await expect(consumeVerifiedWhatsAppNumber('+923001112222', otherBuyer._id)).resolves.toBe(false);
    await expect(consumeVerifiedWhatsAppNumber('+923001112222')).resolves.toBe(false);
    await expect(consumeVerifiedWhatsAppNumber('+923001112222', buyer._id)).resolves.toBe(true);
  });

  test('enforces the 30-day cooldown when a verified seller changes numbers', async () => {
    await connectGateway();
    const lastWhatsAppChange = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const seller = await makeUser({
      role: 'seller',
      sellerInfo: {
        whatsappNumber: '+923001112222',
        whatsappVerified: true,
        lastWhatsAppChange,
      },
    });
    const req = {
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923009998888' },
    };
    const res = resMock();

    await sendWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      daysLeft: 28,
      nextWhatsAppChangeAt: expect.any(String),
    }));
    expect(sellerEvolutionClient.sendText).not.toHaveBeenCalled();
  });

  test('sets the cooldown only when an already-verified number is changed', async () => {
    const previousChange = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const seller = await makeUser({
      role: 'seller',
      sellerInfo: {
        whatsappNumber: '+923001112222',
        whatsappVerified: true,
        lastWhatsAppChange: previousChange,
      },
    });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '654321',
      sellerId: seller._id,
      attempts: 0,
      verified: false,
    });

    const req = {
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923009998888', otp: '654321' },
    };
    const res = resMock();

    await verifyWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const updatedSeller = await User.findById(seller._id);
    expect(updatedSeller.sellerInfo.whatsappNumber).toBe('+923009998888');
    expect(updatedSeller.sellerInfo.lastWhatsAppChange.getTime()).toBeGreaterThan(previousChange.getTime());
  });

  test('invalidates an older OTP when a cooldown starts before verification', async () => {
    const seller = await makeUser({
      role: 'seller',
      sellerInfo: {
        whatsappNumber: '+923001112222',
        whatsappVerified: true,
        lastWhatsAppChange: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '654321',
      sellerId: seller._id,
      attempts: 0,
      verified: false,
    });
    const res = resMock();

    await verifyWhatsAppOTP({
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923009998888', otp: '654321' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(429);
    await expect(WhatsAppOTP.findOne({ sellerId: seller._id })).resolves.toBeNull();
    await expect(User.findById(seller._id).then((user) => user.sellerInfo.whatsappNumber)).resolves.toBe('+923001112222');
  });

  test('updates and clears OTP immediately for an existing seller changing settings', async () => {
    const seller = await makeUser({ role: 'seller' });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '654321',
      sellerId: seller._id,
      attempts: 0,
      verified: false,
    });

    const req = {
      user: { id: seller._id, role: 'seller' },
      body: { whatsappNumber: '+923009998888', otp: '654321' },
    };
    const res = resMock();

    await verifyWhatsAppOTP(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    await expect(WhatsAppOTP.findOne({ number: '923009998888' })).resolves.toBeNull();

    const updatedSeller = await User.findById(seller._id);
    expect(updatedSeller.sellerInfo.whatsappNumber).toBe('+923009998888');
    expect(updatedSeller.sellerInfo.whatsappVerified).toBe(true);
    expect(updatedSeller.sellerInfo.lastWhatsAppChange).toBeUndefined();
  });

  test('keeps notification preferences seller-only and exposes cooldown metadata', async () => {
    const buyer = await makeUser({ role: 'user' });
    const deniedResponse = resMock();
    await getWhatsAppPrefs({ user: { id: buyer._id, role: 'user' } }, deniedResponse);
    expect(deniedResponse.status).toHaveBeenCalledWith(403);

    const updateDeniedResponse = resMock();
    await updateWhatsAppPrefs({
      user: { id: buyer._id, role: 'user' },
      body: { enabled: false },
    }, updateDeniedResponse);
    expect(updateDeniedResponse.status).toHaveBeenCalledWith(403);

    const seller = await makeUser({
      role: 'seller',
      sellerInfo: {
        whatsappNumber: '+923001112222',
        whatsappVerified: true,
        lastWhatsAppChange: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    });
    const response = resMock();
    await getWhatsAppPrefs({ user: { id: seller._id, role: 'seller' } }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      whatsappNumber: '+923001112222',
      lastWhatsAppChange: expect.any(Date),
      nextWhatsAppChangeAt: expect.any(String),
      whatsappChangeDaysLeft: 28,
    }));
  });
});
