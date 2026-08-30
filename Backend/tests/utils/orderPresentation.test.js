const {
  formatItemOptionsText,
  formatOrderItemUnitMoney,
  formatOrderMoney,
  formatPaidOrderNotificationTotal,
  orderItemLineText,
  paymentMethodLabel,
} = require('../../utils/orderPresentation');
const {
  buildOrderConfirmationMessage,
} = require('../../services/whatsapp/messageBuilder');
const {
  buyerOrderConfirmationRequestEmail,
  newOrderSellerEmail,
} = require('../../utils/emailTemplates');

const sampleOrder = {
  orderId: 'ORD-123',
  currency: 'PKR',
  paymentMethod: 'cash_on_delivery',
  shippingInfo: {
    fullName: 'Demo Buyer',
    email: 'buyer@example.com',
    phone: '+923001234567',
    address: 'Street 1',
    city: 'Lahore',
    state: 'Punjab',
    postalCode: '54000',
    country: 'Pakistan',
  },
  orderItems: [
    {
      name: 'Storage Cabinet',
      price: 4093.79,
      quantity: 1,
      selectedOptions: { Size: 'Large', Finish: 'Walnut' },
      selectedColor: 'Brown',
    },
  ],
  orderSummary: {
    subtotal: 4093.79,
    shippingCost: 250,
    tax: 0,
    couponDiscount: 0,
    totalAmount: 4343.79,
  },
};

describe('order presentation helpers', () => {
  test('formats selected options and legacy selected color together', () => {
    expect(formatItemOptionsText(sampleOrder.orderItems[0]))
      .toBe('Size: Large, Finish: Walnut, Color: Brown');
  });

  test('formats order amounts in the saved order currency', () => {
    expect(formatOrderMoney(4343.79, sampleOrder)).toBe('Rs4,343.79 PKR');
    expect(formatPaidOrderNotificationTotal(sampleOrder)).toBe('Rs4,343.79 PKR');
    expect(formatPaidOrderNotificationTotal({
      currency: 'USD',
      orderSummary: { totalAmount: 0 },
    })).toBe('$0.00');
  });

  test.each([
    ['blank paid total', { currency: 'USD', orderSummary: { totalAmount: '' } }],
    ['missing paid total', { currency: 'USD', orderSummary: {} }],
    ['blank paid currency', { currency: '', orderSummary: { totalAmount: 10 } }],
    ['missing paid currency', { orderSummary: { totalAmount: 10 } }],
    ['null paid currency', { currency: null, orderSummary: { totalAmount: 10 } }],
  ])('paid notification rejects %s instead of masking it with a fallback', (_label, order) => {
    expect(() => formatPaidOrderNotificationTotal(order)).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
  });

  test.each([
    ['unsupported currency', () => formatOrderMoney(10, { currency: 'CAD' })],
    ['blank stored currency', () => formatOrderMoney(10, { currency: '' })],
    ['non-finite amount', () => formatOrderMoney(Number.POSITIVE_INFINITY, sampleOrder)],
    ['blank amount', () => formatOrderMoney('', sampleOrder)],
    ['sub-cent amount', () => formatOrderMoney(0.001, sampleOrder)],
    ['unsupported seller currency', () => formatOrderItemUnitMoney({
      price: 10,
      sourcePrice: 10,
      sourceCurrency: 'CAD',
    }, 'USD')],
    ['blank seller currency', () => formatOrderItemUnitMoney({
      price: 10,
      sourcePrice: 10,
      sourceCurrency: '',
    }, 'USD')],
  ])('surfaces %s as stored presentation corruption', (_label, render) => {
    expect(render).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
  });

  test('shows the native seller unit price when a converted unit rounds to zero', () => {
    expect(formatOrderItemUnitMoney({
      price: 0,
      sourcePrice: 1,
      sourceCurrency: 'PKR',
      quantity: 1000,
      lineSubtotal: 3.51,
    }, 'USD')).toBe('Rs1.00 PKR seller price');
    expect(formatOrderItemUnitMoney({ price: 2.5 }, 'USD')).toBe('$2.50');
  });

  test('labels every supported checkout payment method accurately', () => {
    expect(paymentMethodLabel('cash_on_delivery')).toBe('Cash on Delivery');
    expect(paymentMethodLabel('stripe')).toBe('Card (Stripe)');
    expect(paymentMethodLabel('wallet')).toBe('Rozare Wallet');
  });

  test('WhatsApp buyer message includes variants and PKR total', () => {
    const text = buildOrderConfirmationMessage(sampleOrder);
    expect(text).toContain('Storage Cabinet (Size: Large, Finish: Walnut, Color: Brown) x1');
    expect(text).toContain('Rs4,343.79 PKR');
    expect(text).toContain('Typed replies are not accepted');
    expect(text).not.toContain('YES');
    expect(text).not.toContain('NO');
  });

  test.each([
    ['missing quantity', order => { delete order.orderItems[0].quantity; }],
    ['legacy qty alias', order => {
      delete order.orderItems[0].quantity;
      order.orderItems[0].qty = 1;
    }],
    ['boolean quantity', order => { order.orderItems[0].quantity = true; }],
    ['fractional quantity', order => { order.orderItems[0].quantity = 1.5; }],
    ['missing currency', order => { delete order.currency; }],
    ['line and subtotal mismatch', order => { order.orderItems[0].price = 4093.78; }],
    ['summary arithmetic mismatch', order => { order.orderSummary.totalAmount = 4343.78; }],
  ])('COD WhatsApp snapshot rejects %s instead of inventing financial data', (_label, mutate) => {
    const corrupt = structuredClone(sampleOrder);
    mutate(corrupt);
    expect(() => buildOrderConfirmationMessage(corrupt)).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
  });

  test.each([
    ['missing quantity', { price: 10 }],
    ['legacy qty alias', { price: 10, qty: 1 }],
  ])('seller order line rejects %s', (_label, item) => {
    expect(() => orderItemLineText(item, 'USD')).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
  });

  test('seller and buyer emails include variants and avoid hardcoded USD totals', () => {
    const buyerEmail = buyerOrderConfirmationRequestEmail(sampleOrder, 'https://example.com/confirm');
    const sellerEmail = newOrderSellerEmail(sampleOrder, 'Demo Seller');

    expect(buyerEmail.html).toContain('Size: Large, Finish: Walnut, Color: Brown');
    expect(buyerEmail.html).toContain('Rs4,343.79 PKR');
    expect(buyerEmail.html).toContain('>Confirm Order</a>');
    expect(buyerEmail.html).toContain('>Cancel Order</a>');
    expect(buyerEmail.html).toContain('https://example.com/confirm?intent=confirm');
    expect(buyerEmail.html).toContain('https://example.com/confirm?intent=cancel');
    expect(sellerEmail.html).toContain('Size: Large, Finish: Walnut, Color: Brown');
    expect(sellerEmail.html).toContain('Rs4,343.79 PKR');
    expect(orderItemLineText(sampleOrder.orderItems[0], sampleOrder.currency)).toContain('Rs4,093.79 PKR');
  });

  test.each([
    ['blank tax', order => { order.orderSummary.tax = ''; }],
    ['sub-cent discount', order => { order.orderSummary.couponDiscount = 0.001; }],
    ['invalid quantity', order => { order.orderItems[0].quantity = true; }],
  ])('emails reject %s instead of hiding corrupt financial data', (_label, mutate) => {
    const corrupt = structuredClone(sampleOrder);
    mutate(corrupt);
    expect(() => newOrderSellerEmail(corrupt, 'Demo Seller')).toThrow(expect.objectContaining({
      code: 'ORDER_PRESENTATION_DATA_INVALID',
      statusCode: 409,
    }));
  });
});
