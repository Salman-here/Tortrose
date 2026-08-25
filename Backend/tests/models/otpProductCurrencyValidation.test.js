'use strict';

const OTP = require('../../models/OTP');

const otpRecord = productCurrency => new OTP({
  email: 'seller@example.com',
  otp: '123456',
  userData: {
    username: 'Seller',
    email: 'seller@example.com',
    password: 'password123',
    role: 'seller',
    isVerified: true,
    ...(productCurrency === undefined ? {} : { productCurrency }),
  },
});

describe('OTP seller product currency schema', () => {
  test.each(['USD', 'PKR', 'EUR', 'GBP'])(
    'persists supported frozen currency %s', productCurrency => {
      const record = otpRecord(productCurrency);
      expect(record.validateSync()).toBeUndefined();
      expect(record.userData.productCurrency).toBe(productCurrency);
    }
  );

  test('keeps pre-deployment OTP records without a currency valid', () => {
    expect(otpRecord(undefined).validateSync()).toBeUndefined();
  });

  test('rejects an unsupported frozen currency at the persistence boundary', () => {
    const validationError = otpRecord('CAD').validateSync();
    expect(validationError?.errors?.['userData.productCurrency']).toBeTruthy();
  });
});
