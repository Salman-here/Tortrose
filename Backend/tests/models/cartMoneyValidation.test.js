'use strict';

const mongoose = require('mongoose');
const Cart = require('../../models/Cart');

const cart = overrides => new Cart({
  user: new mongoose.Types.ObjectId(),
  cartItems: [{
    product: new mongoose.Types.ObjectId(),
    qty: 1,
  }],
  totalCartPrice: 10.01,
  totalCartCurrency: 'USD',
  ...overrides,
});

describe('cart persisted money and quantity integrity', () => {
  test('accepts canonical exact cart cache state', async () => {
    await expect(cart().validate()).resolves.toBeUndefined();
  });

  test.each([true, '10.01', '', Number.POSITIVE_INFINITY, -0.01, 0.001, 1.004, Number.MAX_SAFE_INTEGER])(
    'rejects corrupt cached cart total %p',
    async totalCartPrice => {
      await expect(cart({ totalCartPrice }).validate()).rejects.toThrow(/totalCartPrice|Cart total/);
    },
  );

  test.each([true, '1', '', 0, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects corrupt cart quantity %p before persistence',
    async qty => {
      const document = cart();
      document.cartItems[0].qty = qty;
      await expect(document.validate()).rejects.toThrow(/qty|quantity/);
    },
  );
});
