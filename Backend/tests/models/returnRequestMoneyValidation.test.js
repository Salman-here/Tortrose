'use strict';

const mongoose = require('mongoose');
const ReturnRequest = require('../../models/ReturnRequest');

const makeReturn = () => new ReturnRequest({
  returnNumber: `RET-${new mongoose.Types.ObjectId()}`,
  order: new mongoose.Types.ObjectId(),
  orderId: 'ORDER-1',
  buyer: new mongoose.Types.ObjectId(),
  seller: new mongoose.Types.ObjectId(),
  currency: 'PKR',
  items: [{
    orderItemId: new mongoose.Types.ObjectId(),
    productId: new mongoose.Types.ObjectId(),
    name: 'Exact return item',
    quantity: 1,
    purchasedQuantity: 1,
    unitPrice: 10.005,
    lineSubtotal: 10,
  }],
  reasonCategory: 'defective',
  reasonDetails: 'The product is defective.',
  eligibilityDeadline: new Date(Date.now() + 86_400_000),
  policySnapshot: {
    returnsEnabled: true,
    returnDuration: 7,
    refundType: 'full_refund',
  },
  refund: {
    itemSubtotal: 10,
    taxAmount: 1,
    shippingAmount: 2,
    discountAmount: 3,
    totalAmount: 10,
  },
});

describe('ReturnRequest financial persistence boundary', () => {
  test('accepts a fractional informational unit price while freezing exact-cent totals', async () => {
    await expect(makeReturn().validate()).resolves.toBeUndefined();
  });

  test.each([
    ['boolean total', true],
    ['blank total', ''],
    ['non-finite total', Number.POSITIVE_INFINITY],
    ['sub-cent total', 10.001],
    ['unsafe total', Number.MAX_SAFE_INTEGER],
  ])('rejects %s', async (_label, value) => {
    const request = makeReturn();
    request.refund.totalAmount = value;
    await expect(request.validate()).rejects.toThrow();
  });

  test('rejects sub-cent return line totals', async () => {
    const request = makeReturn();
    request.items[0].lineSubtotal = 10.001;
    await expect(request.validate()).rejects.toThrow();
  });

  test('rejects boolean or oversized quantities', async () => {
    const booleanQuantity = makeReturn();
    booleanQuantity.items[0].quantity = true;
    await expect(booleanQuantity.validate()).rejects.toThrow();

    const oversized = makeReturn();
    oversized.items[0].quantity = 2;
    await expect(oversized.validate()).rejects.toThrow('cannot exceed purchased quantity');
  });

  test('rejects a component total or line subtotal that does not reconcile', async () => {
    const componentMismatch = makeReturn();
    componentMismatch.refund.taxAmount = 2;
    await expect(componentMismatch.validate()).rejects.toThrow('reconcile');

    const lineMismatch = makeReturn();
    lineMismatch.refund.itemSubtotal = 9;
    lineMismatch.refund.totalAmount = 9;
    await expect(lineMismatch.validate()).rejects.toThrow('line subtotals');
  });

  test.each([true, '', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe settlement attempt %p',
    async attempt => {
      const request = makeReturn();
      request.settlement.attempt = attempt;
      await expect(request.validate()).rejects.toThrow(/attempt/);
    },
  );

  test('requires a strict, complete settlement-time shipping allocation marker', async () => {
    const valid = makeReturn();
    valid.settlement.shippingAllocationVersion = 1;
    valid.settlement.shippingAllocatedAt = new Date();
    await expect(valid.validate()).resolves.toBeUndefined();

    const missingTime = makeReturn();
    missingTime.settlement.shippingAllocationVersion = 1;
    await expect(missingTime.validate()).rejects.toThrow(/allocation time/);

    const timeWithoutVersion = makeReturn();
    timeWithoutVersion.settlement.shippingAllocatedAt = new Date();
    await expect(timeWithoutVersion.validate()).rejects.toThrow(/version 1/);

    for (const version of [true, 2, 1.5]) {
      const invalidVersion = makeReturn();
      invalidVersion.settlement.shippingAllocationVersion = version;
      await expect(invalidVersion.validate()).rejects.toThrow(/allocation version|Cast to Number/);
    }
  });
});
