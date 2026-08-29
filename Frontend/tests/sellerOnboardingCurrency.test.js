import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const becomeSellerSource = readFileSync(
  new URL('../src/pages/BecomeSeller.jsx', import.meta.url),
  'utf8'
);
const routesSource = readFileSync(
  new URL('../src/routes/AppRoutes.jsx', import.meta.url),
  'utf8'
);

test('the routed web seller setup exposes every supported native listing currency', () => {
  assert.match(becomeSellerSource, /SELLER_PRODUCT_CURRENCY_CODES\s*=\s*\['USD', 'PKR', 'EUR', 'GBP'\]/);
  assert.match(becomeSellerSource, /name="productCurrency"/);
  assert.match(becomeSellerSource, /value=\{storeData\.productCurrency\}/);
  assert.match(becomeSellerSource, /Product Listing Currency/);
});

test('web seller activation sends the visible listing currency to the backend', () => {
  assert.match(becomeSellerSource, /productCurrency:\s*storeData\.productCurrency/);
  assert.match(becomeSellerSource, /useCurrency\(\)/);
});

test('existing buyers bind seller WhatsApp OTP send and verify to their authenticated account', () => {
  const authenticatedOtpCalls = becomeSellerSource.match(
    /api\/seller-whatsapp\/(?:send-otp|verify-otp)[\s\S]{0,260}Authorization:\s*`Bearer \$\{token\}`/g
  ) || [];
  assert.equal(authenticatedOtpCalls.length, 2);
});

test('the live seller-signup alias resolves to the hardened BecomeSeller flow', () => {
  assert.match(routesSource, /path='\/become-seller'\s+element=\{<BecomeSeller\s*\/>\}/);
  assert.match(routesSource, /path='\/seller-signup'\s+element=\{<Navigate to='\/become-seller' replace\s*\/>\}/);
});
