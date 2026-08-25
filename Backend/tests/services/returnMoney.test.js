const { selectedReturnMoney } = require('../../services/returnService');

const item = (id, purchasedQuantity, unitPrice) => ({
  orderItemId: id,
  purchasedQuantity,
  unitPrice,
});

describe('selectedReturnMoney', () => {
  const order = {
    orderItems: [
      { _id: 'line-a', productId: 'product-a', price: 100, quantity: 1 },
      { _id: 'line-b', productId: 'product-b', price: 200, quantity: 1 },
    ],
    orderSummary: {
      subtotal: 300,
      tax: 30,
      couponDiscount: 15,
    },
    sellerShipping: [{ seller: 'seller-a', shippingMethod: { price: 20 } }],
  };

  test('allocates tax and discount proportionally and refunds seller shipping once all seller items are covered', () => {
    const sellerItems = [item('line-a', 1, 100)];
    expect(selectedReturnMoney({
      order,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      shippingAlreadyRefunded: false,
    })).toEqual({
      itemSubtotal: 100,
      taxAmount: 10,
      shippingAmount: 20,
      discountAmount: 5,
      totalAmount: 125,
    });
  });

  test('does not refund shipping for a partial quantity', () => {
    const sellerItems = [item('line-a', 2, 100)];
    const result = selectedReturnMoney({
      order: {
        ...order,
        orderItems: [{ _id: 'line-a', productId: 'product-a', price: 100, quantity: 2 }],
        orderSummary: { subtotal: 200, tax: 0, couponDiscount: 0 },
      },
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      shippingAlreadyRefunded: false,
    });
    expect(result.shippingAmount).toBe(0);
    expect(result.totalAmount).toBe(100);
  });

  test('never refunds seller shipping twice across split return requests', () => {
    const sellerItems = [item('line-a', 2, 100)];
    const result = selectedReturnMoney({
      order: {
        ...order,
        orderItems: [{ _id: 'line-a', productId: 'product-a', price: 100, quantity: 2 }],
        orderSummary: { subtotal: 200, tax: 0, couponDiscount: 0 },
      },
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 1]]),
      shippingAlreadyRefunded: true,
    });
    expect(result.shippingAmount).toBe(0);
    expect(result.totalAmount).toBe(100);
  });

  test('caps split requests at the exact seller allocation and conserves every cent', () => {
    const sellerItems = [item('line-a', 3, 1)];
    const tinyOrder = {
      ...order,
      orderItems: [{ _id: 'line-a', productId: 'product-a', price: 1, quantity: 3 }],
      orderSummary: { subtotal: 3, tax: 1, couponDiscount: 0 },
      sellerShipping: [],
    };

    const first = selectedReturnMoney({
      order: tinyOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: 0,
    });
    const second = selectedReturnMoney({
      order: tinyOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 1]]),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: first.totalAmount,
    });
    const last = selectedReturnMoney({
      order: tinyOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 2]]),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: first.totalAmount + second.totalAmount,
    });

    expect(first.totalAmount).toBe(1.34);
    expect(second.totalAmount).toBe(1.33);
    expect(last.totalAmount).toBe(1.33);
    expect(first.totalAmount + second.totalAmount + last.totalAmount).toBe(4);
    expect(last.itemSubtotal + last.taxAmount + last.shippingAmount - last.discountAmount).toBe(last.totalAmount);
  });

  test('uses the authoritative converted line subtotal and conserves its cents across quantities', () => {
    const sellerItems = [{
      ...item('line-a', 3, 0),
      lineSubtotal: 0.02,
    }];
    const fxOrder = {
      currency: 'USD',
      orderItems: [{
        _id: 'line-a',
        productId: 'product-a',
        seller: 'seller-a',
        price: 0,
        quantity: 3,
        lineSubtotal: 0.02,
      }],
      orderSummary: { subtotal: 0.02, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 0.02 },
      sellerShipping: [],
    };

    const first = selectedReturnMoney({
      order: fxOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      settledQuantities: new Map(),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: 0,
    });
    const second = selectedReturnMoney({
      order: fxOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 1]]),
      settledQuantities: new Map([['line-a', 1]]),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: first.totalAmount,
    });
    const final = selectedReturnMoney({
      order: fxOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 2]]),
      settledQuantities: new Map([['line-a', 2]]),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: first.totalAmount + second.totalAmount,
    });

    expect([first.itemSubtotal, second.itemSubtotal, final.itemSubtotal]).toEqual([0.01, 0.01, 0]);
    expect(first.totalAmount + second.totalAmount + final.totalAmount).toBe(0.02);
  });

  test('allocates seller-scoped coupons only to their applicable products', () => {
    const scopedOrder = {
      orderItems: [
        { _id: 'line-a', productId: 'product-a', price: 100, quantity: 1 },
        { _id: 'line-b', productId: 'product-b', price: 100, quantity: 1 },
      ],
      orderSummary: { subtotal: 200, tax: 0, couponDiscount: 50 },
      appliedCoupons: [{
        discountType: 'fixed',
        discountValue: 50,
        applicableProductIds: ['product-a'],
      }],
      sellerShipping: [],
    };
    const sellerAItems = [item('line-a', 1, 100)];
    const sellerBItems = [item('line-b', 1, 100)];

    const sellerARefund = selectedReturnMoney({
      order: scopedOrder,
      sellerId: 'seller-a',
      sellerItems: sellerAItems,
      selected: [{ ...sellerAItems[0], quantity: 1 }],
      consumed: new Map(),
      shippingAlreadyRefunded: false,
    });
    const sellerBRefund = selectedReturnMoney({
      order: scopedOrder,
      sellerId: 'seller-b',
      sellerItems: sellerBItems,
      selected: [{ ...sellerBItems[0], quantity: 1 }],
      consumed: new Map(),
      shippingAlreadyRefunded: false,
    });

    expect(sellerARefund.discountAmount).toBe(50);
    expect(sellerARefund.totalAmount).toBe(50);
    expect(sellerBRefund.discountAmount).toBe(0);
    expect(sellerBRefund.totalAmount).toBe(100);
  });

  test('does not use an unsettled partial request to unlock a shipping refund', () => {
    const sellerItems = [item('line-a', 2, 100)];
    const result = selectedReturnMoney({
      order: {
        ...order,
        orderItems: [{ _id: 'line-a', productId: 'product-a', price: 100, quantity: 2 }],
        orderSummary: { subtotal: 200, tax: 0, couponDiscount: 0 },
      },
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 1]]),
      settledQuantities: new Map(),
      shippingAlreadyRefunded: false,
    });

    expect(result.shippingAmount).toBe(0);
    expect(result.totalAmount).toBe(100);
  });

  test.each([
    ['positive', 110, 55],
    ['negative', 90, 45],
  ])('includes a %s stored-total adjustment in each sequential partial refund', (_label, totalAmount, expectedPart) => {
    const sellerItems = [item('line-a', 2, 50)];
    const adjustedOrder = {
      currency: 'USD',
      orderItems: [
        { _id: 'line-a', productId: 'product-a', seller: 'seller-a', price: 50, quantity: 2 },
      ],
      orderSummary: {
        subtotal: 100,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount,
      },
      sellerShipping: [],
    };
    const first = selectedReturnMoney({
      order: adjustedOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      settledQuantities: new Map(),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: 0,
    });
    const final = selectedReturnMoney({
      order: adjustedOrder,
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map([['line-a', 1]]),
      settledQuantities: new Map([['line-a', 1]]),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: first.totalAmount,
    });

    expect(first.totalAmount).toBe(expectedPart);
    expect(final.totalAmount).toBe(expectedPart);
    expect(first.totalAmount + final.totalAmount).toBe(totalAmount);
    expect(first.itemSubtotal + first.taxAmount + first.shippingAmount - first.discountAmount).toBe(first.totalAmount);
    expect(final.itemSubtotal + final.taxAmount + final.shippingAmount - final.discountAmount).toBe(final.totalAmount);
  });

  test('never refunds a missing seller shipping row to the wrong seller', () => {
    const multiSellerOrder = {
      currency: 'USD',
      orderItems: [
        { _id: 'line-a', productId: 'product-a', seller: 'seller-a', price: 10, quantity: 1 },
        { _id: 'line-b', productId: 'product-b', seller: 'seller-b', price: 10, quantity: 1 },
      ],
      sellerShipping: [{ seller: 'seller-a', shippingMethod: { price: 1 } }],
      shippingMethod: { seller: 'seller-a', price: 3 },
      orderSummary: { subtotal: 20, shippingCost: 3, tax: 0, couponDiscount: 0, totalAmount: 23 },
    };
    const sellerBItems = [item('line-b', 1, 10)];
    const result = selectedReturnMoney({
      order: multiSellerOrder,
      sellerId: 'seller-b',
      sellerItems: sellerBItems,
      selected: [{ ...sellerBItems[0], quantity: 1 }],
      consumed: new Map(),
      settledQuantities: new Map(),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: 0,
    });

    expect(result.shippingAmount).toBe(0);
    expect(result.totalAmount).toBe(10);
  });

  test.each([true, '', '2', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects corrupt purchased return quantity %p instead of defaulting it',
    purchasedQuantity => {
      const sellerItems = [item('line-a', purchasedQuantity, 100)];
      expect(() => selectedReturnMoney({
        order: {
          ...order,
          orderItems: [{ _id: 'line-a', productId: 'product-a', price: 100, quantity: 1 }],
          orderSummary: { subtotal: 100, tax: 0, couponDiscount: 0 },
          sellerShipping: [],
        },
        sellerId: 'seller-a',
        sellerItems,
        selected: [{ ...sellerItems[0], quantity: 1 }],
        consumed: new Map(),
        settledQuantities: new Map(),
        shippingAlreadyRefunded: false,
        sellerRefundedAmount: 0,
      })).toThrow('purchased return quantity is invalid');
    },
  );

  test('quarantines a seller return ledger that already exceeds the frozen entitlement', () => {
    const sellerItems = [item('line-a', 1, 100)];
    expect(() => selectedReturnMoney({
      order: {
        ...order,
        orderItems: [{ _id: 'line-a', productId: 'product-a', price: 100, quantity: 1 }],
        orderSummary: { subtotal: 100, tax: 0, couponDiscount: 0, totalAmount: 100 },
        sellerShipping: [],
      },
      sellerId: 'seller-a',
      sellerItems,
      selected: [{ ...sellerItems[0], quantity: 1 }],
      consumed: new Map(),
      settledQuantities: new Map(),
      shippingAlreadyRefunded: false,
      sellerRefundedAmount: 100.01,
    })).toThrow(expect.objectContaining({ code: 'RETURN_SELLER_SETTLEMENT_EXCEEDED' }));
  });
});
