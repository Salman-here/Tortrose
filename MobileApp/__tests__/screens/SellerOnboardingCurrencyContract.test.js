'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../src/screens/BecomeSellerScreen.js'),
  'utf8'
);
const navigatorSource = fs.readFileSync(
  path.join(__dirname, '../../src/navigation/AppNavigator.js'),
  'utf8'
);

describe('seller onboarding product-currency contract', () => {
  test('the active mobile setup exposes all supported native listing currencies', () => {
    expect(source).toMatch(/SELLER_PRODUCT_CURRENCY_CODES\s*=\s*\['USD', 'PKR', 'EUR', 'GBP'\]/);
    for (const code of ['USD', 'PKR', 'EUR', 'GBP']) {
      expect(source).toContain('testID={`become-seller-product-currency-${code}`}');
    }
    expect(source).toContain('PRODUCT LISTING CURRENCY *');
  });

  test('seller activation sends exactly the selected listing currency', () => {
    expect(source).toMatch(/productCurrency:\s*storeData\.productCurrency/);
    expect(source).toContain("import { useCurrency } from '../contexts/CurrencyContext';");
  });

  test('both public mobile route names use the same hardened screen', () => {
    expect(navigatorSource).toContain('name="BecomeSeller" component={BecomeSellerScreen}');
    expect(navigatorSource).toContain('name="SellerSignUp" component={BecomeSellerScreen}');
    expect(navigatorSource).not.toMatch(/import\s+SellerSignUpScreen\s+from/);
  });
});
