'use strict';
const UPDATE_SOUND = 'rozare_update_v1.wav';
const NEW_ORDER_SOUND = 'rozare_new_order_v1.wav';
const NEW_ORDERS = new Set(['new_order_received', 'paid_order_received', 'cod_order_received', 'no_charge_order_received', 'new_order']);
function notificationSound(payload, profileVersion = 0) {
  const legacy = { sound: payload.sound === null ? null : 'default', channelId: payload.channelId || 'general' };
  // Never address a channel that an older installation cannot have.
  if (profileVersion !== 1 || payload.sound === null) return legacy;
  const sellerOrder = payload.channelId === 'seller' && NEW_ORDERS.has(payload.data?.type);
  return { sound: sellerOrder ? NEW_ORDER_SOUND : UPDATE_SOUND,
    channelId: sellerOrder ? 'rozare-new-orders-v1' : payload.channelId === 'orders' ? 'rozare-order-updates-v1' : 'rozare-updates-v1' };
}
module.exports = { notificationSound, UPDATE_SOUND, NEW_ORDER_SOUND };
