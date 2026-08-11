const fs = require('fs');
const path = require('path');

const read = relativeFile => fs.readFileSync(path.join(__dirname, '../..', relativeFile), 'utf8');

describe('mobile OTP timing contracts', () => {
  test.each([
    'src/screens/BecomeSellerScreen.js',
    'src/screens/UserWhatsAppSettingsScreen.js',
    'src/screens/seller/SellerProfileScreen.js',
    'src/screens/seller/SellerWhatsAppSettingsScreen.js',
  ])('%s keeps WhatsApp code expiry at 2 minutes and resend cooldown at 30 seconds', (relativeFile) => {
    const source = read(relativeFile);
    expect(source).toMatch(/expirySeconds:\s*120,\s*resendSeconds:\s*30/);
  });

  test.each([
    'src/screens/BecomeSellerScreen.js',
    'src/screens/auth/OTPVerificationScreen.js',
    'src/screens/auth/SellerSignUpScreen.js',
    'src/screens/seller/SellerProfileScreen.js',
  ])('%s keeps email code expiry at 10 minutes', (relativeFile) => {
    const source = read(relativeFile);
    expect(source).toMatch(/expirySeconds:\s*600/);
  });
});
