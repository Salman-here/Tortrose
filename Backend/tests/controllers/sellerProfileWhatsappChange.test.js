const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../../models/User');
const WhatsAppOTP = require('../../models/WhatsAppOTP');
const { verifyWhatsAppChange } = require('../../controllers/userController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

const createSeller = (suffix, sellerInfo = {}) => User.create({
  username: `seller-wa-${suffix}`,
  email: `seller-wa-${suffix}@example.com`,
  role: 'seller',
  isVerified: true,
  sellerInfo,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await User.init();
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), WhatsAppOTP.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('seller profile WhatsApp number replacement', () => {
  test('does not accept a code issued to another seller', async () => {
    const owner = await createSeller('owner');
    const attacker = await createSeller('attacker');
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '123456',
      sellerId: owner._id,
      verified: false,
    });
    const response = responseMock();

    await verifyWhatsAppChange({
      user: { id: attacker._id.toString(), role: 'seller' },
      body: { newWhatsappNumber: '+923009998888', otp: '123456' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    await expect(User.findById(attacker._id).then((user) => user.sellerInfo?.whatsappVerified)).resolves.not.toBe(true);
    await expect(WhatsAppOTP.findOne({ sellerId: owner._id })).resolves.toBeTruthy();
  });

  test('re-checks the 30-day cooldown before consuming an older code', async () => {
    const seller = await createSeller('cooldown', {
      whatsappNumber: '+923001112222',
      whatsappVerified: true,
      lastWhatsAppChange: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '123456',
      sellerId: seller._id,
      verified: false,
    });
    const response = responseMock();

    await verifyWhatsAppChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newWhatsappNumber: '+923009998888', otp: '123456' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(429);
    await expect(User.findById(seller._id).then((user) => user.sellerInfo.whatsappNumber)).resolves.toBe('+923001112222');
    await expect(WhatsAppOTP.findOne({ sellerId: seller._id })).resolves.toBeNull();
  });

  test('updates the number, starts the cooldown, and consumes the code', async () => {
    const seller = await createSeller('success', {
      whatsappNumber: '+923001112222',
      whatsappVerified: true,
      lastWhatsAppChange: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '123456',
      sellerId: seller._id,
      verified: false,
    });
    const response = responseMock();

    await verifyWhatsAppChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newWhatsappNumber: '+923009998888', otp: '123456' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const updated = await User.findById(seller._id);
    expect(updated.sellerInfo.whatsappNumber).toBe('+923009998888');
    expect(updated.sellerInfo.phoneNumber).toBe('+923009998888');
    expect(updated.sellerInfo.whatsappVerified).toBe(true);
    expect(updated.sellerInfo.lastWhatsAppChange).toBeTruthy();
    const withCanonicalIdentity = await User.findById(seller._id).select('+sellerInfo.whatsappDigits');
    expect(withCanonicalIdentity.sellerInfo.whatsappDigits).toBe('923009998888');
    await expect(WhatsAppOTP.findOne({ sellerId: seller._id })).resolves.toBeNull();
  });

  test('increments attempts atomically under parallel profile-change guesses', async () => {
    const seller = await createSeller('parallel-guesses', {
      whatsappNumber: '+923001112222',
      whatsappVerified: true,
      lastWhatsAppChange: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const otpRecord = await WhatsAppOTP.create({
      number: '923009998888',
      otp: '123456',
      sellerId: seller._id,
      attempts: 0,
      verified: false,
    });

    await Promise.all(Array.from({ length: 10 }, () => verifyWhatsAppChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newWhatsappNumber: '+923009998888', otp: '000000' },
    }, responseMock())));

    const updatedOtp = await WhatsAppOTP.findById(otpRecord._id);
    expect(updatedOtp.attempts).toBe(5);
    expect(updatedOtp.verified).toBe(false);
  });

  test('rejects a canonically equal number despite legacy punctuation', async () => {
    await createSeller('legacy-format-owner', {
      whatsappNumber: '+92 (300) 999-8888',
      whatsappVerified: true,
    });
    const seller = await createSeller('legacy-format-requester', {
      whatsappNumber: '+923001112222',
      whatsappVerified: true,
      lastWhatsAppChange: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    await WhatsAppOTP.create({
      number: '923009998888',
      otp: '123456',
      sellerId: seller._id,
      attempts: 0,
      verified: false,
    });
    const response = responseMock();

    await verifyWhatsAppChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newWhatsappNumber: '923009998888', otp: '123456' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    await expect(WhatsAppOTP.findOne({ sellerId: seller._id })).resolves.toBeNull();
  });
});
