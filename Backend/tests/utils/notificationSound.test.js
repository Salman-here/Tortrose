const { notificationSound } = require('../../utils/notificationSound');
test.each(['new_order_received', 'paid_order_received', 'cod_order_received', 'no_charge_order_received'])('premium order sound only for new seller orders: %s', type => {
  expect(notificationSound({ channelId: 'seller', data: { type } }, 1)).toEqual({ sound: 'rozare_new_order_v1.wav', channelId: 'rozare-new-orders-v1' });
});
test.each([undefined, 0, 2, '1'])('older or unknown installation capability %s keeps legacy channels', version => {
  expect(notificationSound({ channelId: 'seller', data: { type: 'paid_order_received' } }, version)).toEqual({ sound: 'default', channelId: 'seller' });
});
test('refunds, cancellations, and buyer payments never use the new-order celebration', () => {
  for (const payload of [{ channelId: 'seller', data: { type: 'cod_order_cancelled' } }, { channelId: 'orders', data: { type: 'order_paid' } }]) {
    expect(notificationSound(payload, 1).sound).toBe('rozare_update_v1.wav');
  }
});
