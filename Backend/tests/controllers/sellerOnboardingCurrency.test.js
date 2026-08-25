'use strict';

const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
const mockUserUpdateOne = jest.fn();
const mockUserSave = jest.fn();
const mockConstructedUsers = [];

jest.mock('../../models/User', () => class MockUser {
  constructor(data = {}) {
    Object.assign(this, data);
    this._id = data._id || 'user-1';
    this.avatar = data.avatar || 'avatar.png';
    this.currency = data.currency || 'USD';
    this.save = mockUserSave;
    mockConstructedUsers.push(this);
  }

  static findOne(...args) { return mockUserFindOne(...args); }
  static findById(...args) { return mockUserFindById(...args); }
  static updateOne(...args) { return mockUserUpdateOne(...args); }
});

const mockOtpDeleteMany = jest.fn();
const mockOtpDeleteOne = jest.fn();
const mockOtpFindOne = jest.fn();
const mockOtpSave = jest.fn();
const mockConstructedOtps = [];

jest.mock('../../models/OTP', () => class MockOTP {
  constructor(data = {}) {
    Object.assign(this, data);
    this._id = data._id || 'otp-1';
    this.save = mockOtpSave;
    mockConstructedOtps.push(this);
  }

  static deleteMany(...args) { return mockOtpDeleteMany(...args); }
  static deleteOne(...args) { return mockOtpDeleteOne(...args); }
  static findOne(...args) { return mockOtpFindOne(...args); }
});

const mockStoreFindOne = jest.fn();
const mockStoreCreate = jest.fn();
jest.mock('../../models/Store', () => ({
  findOne: (...args) => mockStoreFindOne(...args),
  create: (...args) => mockStoreCreate(...args),
}));

const mockSendEmail = jest.fn();
jest.mock('../../controllers/mailController', () => ({ sendEmail: (...args) => mockSendEmail(...args) }));
jest.mock('../../utils/emailTemplates', () => ({ welcomeEmail: jest.fn(() => ({ subject: 'Welcome', html: '' })) }));

const mockTrackRegistration = jest.fn();
const mockTrackSellerLead = jest.fn();
jest.mock('../../services/tiktokEventsApi', () => ({
  trackCompleteRegistration: (...args) => mockTrackRegistration(...args),
}));
jest.mock('../../services/metaConversionsApi', () => ({
  trackSellerLead: (...args) => mockTrackSellerLead(...args),
}));
jest.mock('../../services/socialLinksService', () => ({ normalizeSocialLinks: value => value || {} }));

const mockEnqueueStoreCreated = jest.fn();
const mockEnsureSellerWelcome = jest.fn();
jest.mock('../../services/sellerOperationalNotificationService', () => ({
  enqueueStoreCreatedNotification: (...args) => mockEnqueueStoreCreated(...args),
  ensureSellerWelcomeNotification: (...args) => mockEnsureSellerWelcome(...args),
}));

const mockRunInTransaction = jest.fn(async work => work({ id: 'session-1' }));
jest.mock('../../services/walletService', () => ({
  runInTransaction: (...args) => mockRunInTransaction(...args),
}));

const mockInitializeSubscription = jest.fn();
jest.mock('../../controllers/subscriptionController', () => ({
  initializeSubscription: (...args) => mockInitializeSubscription(...args),
}));

const mockConsumeWhatsApp = jest.fn();
jest.mock('../../controllers/sellerWhatsappController', () => ({
  consumeVerifiedWhatsAppNumber: (...args) => mockConsumeWhatsApp(...args),
}));

jest.mock('../../utils/authSecurity', () => ({
  generateSixDigitOTP: jest.fn(() => '123456'),
  signAuthToken: jest.fn(() => 'signed-token'),
}));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'signed-token') }));

const {
  sendSellerOTP,
  verifyOTPAndRegister,
  verifySellerOTPAndRegister,
} = require('../../controllers/authController');
const { becomeSeller } = require('../../controllers/userController');

const responseRecorder = () => {
  const response = { statusCode: 200, body: null };
  response.res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  return response;
};

const validSellerRequest = overrides => ({
  username: 'Seller',
  email: 'seller@example.com',
  password: 'password123',
  phoneNumber: '+923001234567',
  whatsappNumber: '+923001234567',
  address: '12 Market Road',
  city: 'Lahore',
  state: 'Punjab',
  stateCode: 'PB',
  country: 'Pakistan',
  countryCode: 'PK',
  businessName: 'Seller Business',
  storeName: 'Seller Store',
  storeDescription: 'A complete seller store description.',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConstructedUsers.length = 0;
  mockConstructedOtps.length = 0;
  mockUserFindOne.mockResolvedValue(null);
  mockUserUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockUserSave.mockResolvedValue(undefined);
  mockOtpDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockOtpDeleteOne.mockResolvedValue({ deletedCount: 1 });
  mockOtpSave.mockResolvedValue(undefined);
  mockStoreFindOne.mockResolvedValue(null);
  mockStoreCreate.mockImplementation(async ([store]) => [{ ...store, _id: 'store-1' }]);
  mockSendEmail.mockResolvedValue(undefined);
  mockConsumeWhatsApp.mockResolvedValue(true);
  mockEnqueueStoreCreated.mockResolvedValue(undefined);
  mockEnsureSellerWelcome.mockResolvedValue(undefined);
  mockInitializeSubscription.mockResolvedValue(undefined);
  mockTrackRegistration.mockResolvedValue(undefined);
  mockTrackSellerLead.mockResolvedValue(undefined);
});

describe('seller onboarding currency controllers', () => {
  test('sendSellerOTP validates and freezes the canonical product currency before sending', async () => {
    const response = responseRecorder();
    await sendSellerOTP({ body: validSellerRequest({ productCurrency: 'pkr' }) }, response.res);

    expect(response.statusCode).toBe(200);
    expect(mockConstructedOtps).toHaveLength(1);
    expect(mockConstructedOtps[0].userData).toMatchObject({
      email: 'seller@example.com',
      role: 'seller',
      productCurrency: 'PKR',
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  test('sendSellerOTP rejects invalid currency without deleting an existing valid OTP', async () => {
    const response = responseRecorder();
    await sendSellerOTP({ body: validSellerRequest({ productCurrency: 'CAD' }) }, response.res);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SELLER_PRODUCT_CURRENCY_INVALID' });
    expect(mockOtpDeleteMany).not.toHaveBeenCalled();
    expect(mockConstructedOtps).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('seller email OTP escapes the request username in HTML', async () => {
    const response = responseRecorder();
    await sendSellerOTP({
      body: validSellerRequest({ username: '<img src=x onerror=alert(1)>' }),
    }, response.res);

    expect(response.statusCode).toBe(200);
    const email = mockSendEmail.mock.calls[0][0];
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).not.toContain('<img src=x onerror=alert(1)>');
  });

  test('seller verification ignores a swapped verify-body currency and stores the OTP-frozen value', async () => {
    mockOtpFindOne.mockResolvedValue({
      _id: 'otp-1',
      userData: {
        username: 'Seller',
        email: 'seller@example.com',
        password: 'password123',
        role: 'seller',
        isVerified: true,
        productCurrency: 'PKR',
      },
    });
    const response = responseRecorder();

    await verifySellerOTPAndRegister({
      body: validSellerRequest({ otp: '123456', productCurrency: 'USD' }),
      get: () => '',
    }, response.res);

    expect(response.statusCode).toBe(200);
    expect(mockConstructedUsers[0]).not.toHaveProperty('productCurrency');
    expect(mockConstructedUsers[0].currency).toBe('PKR');
    expect(mockStoreCreate).toHaveBeenCalledWith([
      expect.objectContaining({ productCurrency: 'PKR' }),
    ], { session: { id: 'session-1' } });
    expect(mockOtpDeleteOne).toHaveBeenCalledWith({ _id: 'otp-1' });
  });

  test('buyer and seller email OTPs cannot be exchanged across verification endpoints', async () => {
    mockOtpFindOne.mockResolvedValueOnce({
      _id: 'buyer-otp',
      userData: {
        username: 'Buyer',
        email: 'buyer@example.com',
        password: 'password123',
        role: 'user',
        isVerified: true,
      },
    });
    const sellerResponse = responseRecorder();
    await verifySellerOTPAndRegister({
      body: validSellerRequest({ email: 'buyer@example.com', otp: '123456' }),
      get: () => '',
    }, sellerResponse.res);
    expect(sellerResponse.statusCode).toBe(400);
    expect(mockConstructedUsers).toHaveLength(0);
    expect(mockConsumeWhatsApp).not.toHaveBeenCalled();

    mockOtpFindOne.mockResolvedValueOnce({
      _id: 'seller-otp',
      userData: {
        username: 'Seller',
        email: 'seller@example.com',
        password: 'password123',
        role: 'seller',
        isVerified: true,
        productCurrency: 'PKR',
      },
    });
    const buyerResponse = responseRecorder();
    await verifyOTPAndRegister({
      body: { email: 'seller@example.com', otp: '123456' },
    }, buyerResponse.res);
    expect(buyerResponse.statusCode).toBe(400);
    expect(mockConstructedUsers).toHaveLength(0);
    expect(mockOtpDeleteOne).not.toHaveBeenCalled();
  });

  test('direct seller registration creates a fresh User document for every transaction callback retry', async () => {
    mockOtpFindOne.mockResolvedValue({
      _id: 'otp-retry',
      userData: {
        username: 'Retry Seller',
        email: 'retry@example.com',
        password: 'password123',
        role: 'seller',
        isVerified: true,
        productCurrency: 'PKR',
      },
    });
    mockRunInTransaction.mockImplementationOnce(async work => {
      await work({ id: 'attempt-1' });
      return work({ id: 'attempt-2' });
    });
    const response = responseRecorder();

    await verifySellerOTPAndRegister({
      body: validSellerRequest({ email: 'retry@example.com', otp: '123456' }),
      get: () => '',
    }, response.res);

    expect(response.statusCode).toBe(200);
    expect(mockConstructedUsers).toHaveLength(2);
    expect(mockConstructedUsers[0]).not.toBe(mockConstructedUsers[1]);
    expect(String(mockConstructedUsers[0]._id)).toBe(String(mockConstructedUsers[1]._id));
    expect(mockUserSave).toHaveBeenCalledTimes(2);
    expect(mockStoreCreate).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ productCurrency: 'PKR' }),
    ], { session: { id: 'attempt-1' } });
    expect(mockStoreCreate).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ productCurrency: 'PKR' }),
    ], { session: { id: 'attempt-2' } });
  });

  test.each([
    [{ productCurrency: 'GBP' }, 'GBP'],
    [{}, 'PKR'],
  ])('becomeSeller uses explicit selection or authoritative User.currency: %j', async (currencyBody, expected) => {
    const user = {
      _id: 'existing-user-1',
      username: 'Existing User',
      email: 'existing@example.com',
      role: 'user',
      currency: 'PKR',
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockUserFindById.mockResolvedValue(user);
    const response = responseRecorder();

    await becomeSeller({
      user: { id: user._id, role: 'user' },
      body: validSellerRequest(currencyBody),
      get: () => '',
    }, response.res);

    expect(response.statusCode).toBe(200);
    expect(mockStoreCreate).toHaveBeenCalledWith([
      expect.objectContaining({ seller: user._id, productCurrency: expected }),
    ], { session: { id: 'session-1' } });
  });
});
