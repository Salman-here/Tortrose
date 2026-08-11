const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../../models/User');
const OTP = require('../../models/OTP');
const { verifyEmailChange } = require('../../controllers/userController');

let mongoServer;
const previousJwtSecret = process.env.JWT_SECRET;

const resMock = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createSeller = (suffix) => User.create({
  username: `seller-${suffix}`,
  email: `seller-${suffix}@example.com`,
  role: 'seller',
  isVerified: true,
  sellerInfo: { businessName: `Seller ${suffix}` },
});

beforeAll(async () => {
  process.env.JWT_SECRET = 'seller-profile-email-change-test-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), OTP.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

describe('seller profile email replacement session', () => {
  test('binds the OTP to its seller and returns a seven-day replacement token', async () => {
    const seller = await createSeller('one');
    const newEmail = 'seller-one-new@example.com';
    await OTP.create({
      email: newEmail,
      otp: '123456',
      userData: { sellerId: seller._id, type: 'email-change' },
    });
    const req = {
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newEmail, otp: '123456' },
    };
    const res = resMock();

    await verifyEmailChange(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.email).toBe(newEmail);
    const decoded = jwt.verify(payload.token, process.env.JWT_SECRET);
    expect(decoded.id.toString()).toBe(seller._id.toString());
    expect(decoded.email).toBe(newEmail);
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
    await expect(User.findById(seller._id).then((user) => user.email)).resolves.toBe(newEmail);
    await expect(OTP.findOne({ email: newEmail })).resolves.toBeNull();
  });

  test('does not accept another seller\'s email-change OTP', async () => {
    const owner = await createSeller('owner');
    const attacker = await createSeller('attacker');
    const newEmail = 'protected-new@example.com';
    await OTP.create({
      email: newEmail,
      otp: '654321',
      userData: { sellerId: owner._id, type: 'email-change' },
    });
    const req = {
      user: { id: attacker._id.toString(), role: 'seller' },
      body: { newEmail, otp: '654321' },
    };
    const res = resMock();

    await verifyEmailChange(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    await expect(User.findById(attacker._id).then((user) => user.email)).resolves.toBe('seller-attacker@example.com');
    await expect(OTP.findOne({ email: newEmail })).resolves.toBeTruthy();
  });

  test('re-checks the cooldown and invalidates a code issued before another change', async () => {
    const seller = await createSeller('cooldown');
    seller.sellerInfo.lastEmailChange = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await seller.save();
    const newEmail = 'seller-cooldown-new@example.com';
    await OTP.create({
      email: newEmail,
      otp: '123456',
      userData: { sellerId: seller._id, type: 'email-change' },
    });
    const res = resMock();

    await verifyEmailChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newEmail, otp: '123456' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(429);
    await expect(User.findById(seller._id).then((user) => user.email)).resolves.toBe('seller-cooldown@example.com');
    await expect(OTP.findOne({ 'userData.sellerId': seller._id })).resolves.toBeNull();
  });

  test('consumes every outstanding email-change code after one succeeds', async () => {
    const seller = await createSeller('multi-code');
    await OTP.create([
      {
        email: 'seller-first@example.com',
        otp: '111111',
        userData: { sellerId: seller._id, type: 'email-change' },
      },
      {
        email: 'seller-second@example.com',
        otp: '222222',
        userData: { sellerId: seller._id, type: 'email-change' },
      },
    ]);
    const firstResponse = resMock();

    await verifyEmailChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newEmail: 'seller-first@example.com', otp: '111111' },
    }, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(200);
    await expect(OTP.countDocuments({ 'userData.sellerId': seller._id })).resolves.toBe(0);

    const secondResponse = resMock();
    await verifyEmailChange({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { newEmail: 'seller-second@example.com', otp: '222222' },
    }, secondResponse);
    expect(secondResponse.status).toHaveBeenCalledWith(429);
    await expect(User.findById(seller._id).then((user) => user.email)).resolves.toBe('seller-first@example.com');
  });
});
