jest.mock('../../models/User', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn() }));
jest.mock('../../services/tiktokEventsApi', () => ({ trackCompleteRegistration: jest.fn() }));
jest.mock('../../services/metaConversionsApi', () => ({ trackSellerLead: jest.fn() }));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({ notifySeller: jest.fn() }));

const bcrypt = require('bcrypt');
const User = require('../../models/User');
const { googleCallback, login } = require('../../controllers/authController');

const responseMock = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  return res;
};

const queryResult = value => ({
  select: jest.fn().mockResolvedValue(value),
});

describe('blocked account token issuance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'blocked-account-auth-secret';
    process.env.FRONTEND_URL = 'https://rozare.test';
  });

  test('password login never compares credentials or signs in a blocked account', async () => {
    const compareSpy = jest.spyOn(bcrypt, 'compare');
    User.findOne.mockReturnValue(queryResult({
      _id: 'blocked-password-user',
      email: 'blocked@example.test',
      password: 'hash',
      role: 'admin',
      status: 'blocked',
    }));
    const res = responseMock();

    await login({ body: { email: 'blocked@example.test', password: 'secret' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ACCOUNT_BLOCKED',
    }));
    expect(compareSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['', 'https://rozare.test/login?error=account_blocked'],
    ['seller', 'https://rozare.test/login?error=account_blocked'],
    ['mobile', 'rozare://auth/google/error?code=account_blocked'],
  ])('Google callback reloads live status and returns no token for state %p', async (state, expectedUrl) => {
    User.findById.mockReturnValue(queryResult({
      _id: 'blocked-google-user',
      email: 'blocked-google@example.test',
      role: 'admin',
      status: 'blocked',
    }));
    const res = responseMock();

    await googleCallback({
      user: { _id: 'blocked-google-user', status: 'active' },
      query: { state },
    }, res);

    expect(User.findById).toHaveBeenCalledWith('blocked-google-user');
    expect(res.redirect).toHaveBeenCalledWith(expectedUrl);
    expect(res.redirect.mock.calls[0][0]).not.toContain('token=');
  });
});
