import { notificationSound, getNotificationSoundProfile } from '../../src/utils/notificationSound';
const backend = require('../../../Backend/utils/notificationSound');
const fs = require('fs'), path = require('path');
test.each(['new_order_received', 'paid_order_received', 'cod_order_received', 'no_charge_order_received'])('original new-order sound for %s matches server', type => {
  const payload = { channelId: 'seller', data: { type } };
  expect(notificationSound(payload, 1)).toEqual({ channelId: 'rozare-new-orders-v1', sound: 'rozare_new_order_v1.wav' });
  expect(notificationSound(payload, 1)).toEqual(backend.notificationSound(payload, 1));
});
test.each(['cod_order_cancelled', 'withdrawal_status_changed', 'subscription_cancelled', 'return_requested'])('not a celebratory order sound: %s', type => {
  const payload = { channelId: 'seller', data: { type } };
  expect(notificationSound(payload, 1).sound).toBe('rozare_update_v1.wav');
  expect(notificationSound(payload, 0)).toEqual({ channelId: 'seller', sound: 'default' });
  expect(notificationSound(payload, 1)).toEqual(backend.notificationSound(payload, 1));
});
test('old APKs and Expo Go never advertise missing sound resources', () => {
  expect(getNotificationSoundProfile('1.0.13')).toBe(0);
  expect(getNotificationSoundProfile(undefined)).toBe(0);
  expect(getNotificationSoundProfile('1.0.14', 'expo')).toBe(0);
  expect(getNotificationSoundProfile('1.0.14', 'standalone')).toBe(1);
});
test('order updates and silent payloads retain their delivery semantics', () => {
  expect(notificationSound({ channelId: 'orders' }, 1).channelId).toBe('rozare-order-updates-v1');
  expect(notificationSound({ channelId: 'seller', sound: null }, 1)).toEqual({ channelId: 'seller', sound: null });
});
test.each(['rozare_update_v1.wav', 'rozare_new_order_v1.wav'])('bundled %s is short, valid uncompressed PCM without clipping', name => {
  const bytes = fs.readFileSync(path.resolve(__dirname, '../../assets/sounds', name));
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt16LE(20)).toBe(1); expect(bytes.readUInt16LE(34)).toBe(16);
  expect((bytes.length - 44) / bytes.readUInt32LE(28)).toBeLessThan(2);
  let peak = 0; for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
  expect(peak).toBeGreaterThan(1000); expect(peak).toBeLessThan(25000);
});
