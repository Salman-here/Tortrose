const {
  formatItemOptionsText,
  formatOrderMoney,
  orderItemLineText,
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
  });

  test('WhatsApp buyer message includes variants and PKR total', () => {
    const text = buildOrderConfirmationMessage(sampleOrder);
    expect(text).toContain('Storage Cabinet (Size: Large, Finish: Walnut, Color: Brown) x1');
    expect(text).toContain('Rs4,343.79 PKR');
    expect(text).toContain('Typed replies are not accepted');
    expect(text).not.toContain('YES');
    expect(text).not.toContain('NO');
  });

  test('seller and buyer emails include variants and avoid hardcoded USD totals', () => {
    const buyerEmail = buyerOrderConfirmationRequestEmail(sampleOrder, 'https://example.com/confirm');
    const sellerEmail = newOrderSellerEmail(sampleOrder, 'Demo Seller');

    expect(buyerEmail.html).toContain('Size: Large, Finish: Walnut, Color: Brown');
    expect(buyerEmail.html).toContain('Rs4,343.79 PKR');
    expect(sellerEmail.html).toContain('Size: Large, Finish: Walnut, Color: Brown');
    expect(sellerEmail.html).toContain('Rs4,343.79 PKR');
    expect(orderItemLineText(sampleOrder.orderItems[0], sampleOrder.currency)).toContain('Rs4,093.79 PKR');
  });
});
