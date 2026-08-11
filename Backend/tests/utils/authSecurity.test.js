const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  AUTH_TOKEN_TTL,
  generateSixDigitOTP,
  signAuthToken,
} = require('../../utils/authSecurity');

describe('authentication security primitives', () => {
  test('generates a six-digit OTP with the cryptographic RNG', () => {
    const randomInt = jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(482731);

    expect(generateSixDigitOTP()).toBe('482731');
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000);

    randomInt.mockRestore();
  });

  test('issues sessions with the canonical seven-day expiry', () => {
    const token = signAuthToken({ id: 'user-123', role: 'user' }, 'test-session-secret');
    const decoded = jwt.verify(token, 'test-session-secret');

    expect(AUTH_TOKEN_TTL).toBe('7d');
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
  });

  test('fails closed when the signing secret is absent', () => {
    expect(() => signAuthToken({ id: 'user-123' }, '')).toThrow('JWT_SECRET is required');
  });
});
