const { buildOrderStatusUpdateMessage } = require('../../services/whatsapp/messageBuilder');

const order = {
  _id: 'o1',
  orderId: 'ORD-1234567890',
  shippingInfo: { fullName: 'Ayesha Khan', phone: '+923001234567', city: 'Lahore' },
  orderItems: [
    { name: 'Blue Kurta', quantity: 1, price: 1500, storeName: 'Style Hub' },
  ],
  orderSummary: { totalAmount: 1500 },
  currency: 'PKR',
};

describe('buildOrderStatusUpdateMessage', () => {
  test.each([
    ['confirmed', 'confirmed'],
    ['processing', 'being prepared'],
    ['shipped', 'on the way'],
    ['delivered', 'delivered'],
    ['cancelled', 'cancelled'],
  ])('builds a %s message with buyer name and order id', (status, phrase) => {
    const msg = buildOrderStatusUpdateMessage(order, status);
    expect(msg).toContain('Ayesha');
    expect(msg).toContain('#ORD-1234567890');
    expect(msg.toLowerCase()).toContain(phrase);
  });

  test('delivered message mentions returns', () => {
    expect(buildOrderStatusUpdateMessage(order, 'delivered')).toMatch(/return/i);
  });

  test('returns empty string for statuses that should not notify', () => {
    expect(buildOrderStatusUpdateMessage(order, 'pending')).toBe('');
    expect(buildOrderStatusUpdateMessage(order, 'unknown')).toBe('');
    expect(buildOrderStatusUpdateMessage(order, '')).toBe('');
    expect(buildOrderStatusUpdateMessage(order, undefined)).toBe('');
  });

  test('is case-insensitive on status and safe without a name', () => {
    const anonymous = { ...order, shippingInfo: { phone: '+923001234567' } };
    const msg = buildOrderStatusUpdateMessage(anonymous, 'SHIPPED');
    expect(msg).toContain('there');
    expect(msg).toContain('on the way');
  });
});
