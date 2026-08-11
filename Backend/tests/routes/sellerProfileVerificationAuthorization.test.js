const {
  emailChangeInitiateLimiter,
  emailChangeVerifyLimiter,
} = require('../../middleware/sellerProfileVerificationLimiter');
const userRoutes = require('../../routes/userRoutes');

const middlewareFor = (path) => {
  const layer = userRoutes.stack.find((entry) => entry.route?.path === path);
  expect(layer).toBeTruthy();
  return layer.route.stack.map((entry) => entry.handle);
};

describe('seller profile verification rate limits', () => {
  test('limits email-change code issuance after authentication', () => {
    expect(middlewareFor('/seller/change-email/initiate')[1]).toBe(emailChangeInitiateLimiter);
  });

  test('limits email-change code attempts after authentication', () => {
    expect(middlewareFor('/seller/change-email/verify')[1]).toBe(emailChangeVerifyLimiter);
  });
});
