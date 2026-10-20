import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { getBuyerDeliveryHeading, getBuyerShippingPresentation, getShipmentItemLabel } from '../../src/utils/buyerShipmentPresentation';

test('single/multi-store copy keeps variant quantities without internal terminology', () => {
  expect(getBuyerDeliveryHeading(1).title).toBe('Delivery details');
  expect(getBuyerDeliveryHeading(3).subtitle).toBe('Your order includes 3 stores. Track each delivery below.');
  expect(getShipmentItemLabel(1, 1)).toBe('1 item');
  expect(getShipmentItemLabel(2, 5)).toBe('2 items · 5 units');
});

test('shipping wording is consistent and cannot silently relabel a paid method as free', () => {
  expect(getBuyerShippingPresentation({ name: 'free', price: 0, estimatedDays: 5 })).toEqual({ name: 'Free shipping', estimate: 'Estimated delivery: 5 days' });
  expect(getBuyerShippingPresentation({ name: 'free', price: 5, estimatedDays: 1 })).toEqual({ name: 'Delivery', estimate: 'Estimated delivery: 1 day' });
  expect(getBuyerShippingPresentation({ name: 'fast', price: 50, estimatedDays: 2 }).name).toBe('Express delivery');
  expect(getBuyerShippingPresentation({ name: '__proto__', price: 0 }).name).toBe('__proto__');
  expect(getBuyerShippingPresentation(null)).toEqual({ name: 'Delivery details unavailable', estimate: null });
  expect(getBuyerShippingPresentation({ name: 'DHL Courier', price: 5 }).name).toBe('DHL Courier');
});

test('the requested exclusion preserves the existing native progress markup and styles exactly', () => {
  const source = readFileSync(require.resolve('../../src/screens/OrderDetailScreen'), 'utf8').replace(/\r\n/g, '\n');
  const hash = (start, end) => createHash('sha256').update(source.slice(source.indexOf(start), source.indexOf(end))).digest('hex');
  expect(hash("      {group.status === 'cancelled' ? (", '      {refund && <GlassPanel')).toBe('4e1b0fda2ccbf59f7c10a966c7a9301cf9647a646985123c85572ce52b756913');
  expect(hash('  sellerProgress: {', '  cancelledShipment: {')).toBe('d92d48f840f76b2645caa5401fdafb0c613c40df594905b797728a0242a145e5');
  expect(source.indexOf('style={styles.sellerCancelFooter}')).toBeGreaterThan(source.indexOf('<View style={styles.sellerAllocation}>'));
});
