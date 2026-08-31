const fs = require('fs');
const path = require('path');

const readSource = (relativeFile) => fs.readFileSync(
  path.join(__dirname, '../..', relativeFile),
  'utf8',
);

describe('mobile media upload timeout safety', () => {
  test('keeps the normal API timeout short and gives media uploads a full minute', () => {
    const apiSource = readSource('src/config/api.js');

    expect(apiSource).toContain('export const API_UPLOAD_TIMEOUT_MS = 60000;');
    expect(apiSource).toContain('timeout: 15000,');
  });

  test.each([
    'src/screens/shared/ProductFormScreen.js',
    'src/screens/EditProfileScreen.js',
    'src/screens/seller/SellerStoreSettingsScreen.js',
    'src/components/ChatBot.js',
  ])('%s uses the dedicated upload timeout', (relativeFile) => {
    const source = readSource(relativeFile);

    expect(source).toContain('API_UPLOAD_TIMEOUT_MS');
    expect(source).toContain('timeout: API_UPLOAD_TIMEOUT_MS');
  });
});
