export const UPDATE_SOUND = 'rozare_update_v1.wav';
export const NEW_ORDER_SOUND = 'rozare_new_order_v1.wav';
const NEW_ORDERS = new Set(['new_order_received', 'paid_order_received', 'cod_order_received', 'no_charge_order_received', 'new_order']);
export function getNotificationSoundProfile(nativeVersion, appOwnership) {
  if (appOwnership === 'expo') return 0;
  const match = /^1\.0\.(\d+)$/.exec(String(nativeVersion || ''));
  return match && Number(match[1]) >= 14 ? 1 : 0;
}
export function notificationSound({ data = {}, channelId = 'general', sound } = {}, version = 0) {
  if (version !== 1 || sound === null) return { sound: sound === null ? null : 'default', channelId };
  const order = channelId === 'seller' && NEW_ORDERS.has(data.type);
  return { sound: order ? NEW_ORDER_SOUND : UPDATE_SOUND,
    channelId: order ? 'rozare-new-orders-v1' : channelId === 'orders' ? 'rozare-order-updates-v1' : 'rozare-updates-v1' };
}
