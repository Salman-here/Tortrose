const {
  trustedRequestIp,
  authenticatedAccountOrIpKey,
} = require('../../services/requestIdentityService');

describe('trusted request identity', () => {
  test('ignores caller-controlled forwarding headers and uses Express req.ip', () => {
    const request = {
      ip: '203.0.113.10',
      socket: { remoteAddress: '10.0.0.5' },
      headers: {
        'cf-connecting-ip': '198.51.100.99',
        'x-forwarded-for': '198.51.100.98',
        'x-real-ip': '198.51.100.97',
      },
    };
    expect(trustedRequestIp(request)).toBe('203.0.113.10');
  });

  test('authenticated payment limits use the stable account before IP', () => {
    expect(authenticatedAccountOrIpKey({
      user: { id: 'account-123' },
      ip: '203.0.113.10',
      headers: { 'cf-connecting-ip': '198.51.100.99' },
    })).toBe('account-123');
  });

  test('falls back only to the socket when Express has no computed IP', () => {
    expect(trustedRequestIp({
      headers: { 'cf-connecting-ip': '198.51.100.99' },
      socket: { remoteAddress: '10.0.0.5' },
    })).toBe('10.0.0.5');
  });
});
