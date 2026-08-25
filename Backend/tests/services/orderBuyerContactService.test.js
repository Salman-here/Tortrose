'use strict';

const {
  canonicalizeShippingPhone,
  normalizeExplicitE164,
  orderBuyerPhoneDigits,
  orderBuyerPhoneE164,
  tryOrderBuyerPhoneE164,
} = require('../../services/orderBuyerContactService');
const { normalizePhone: normalizeQueuePhone } = require('../../services/whatsapp/messageBuilder');

describe('order buyer international phone snapshots', () => {
  test.each([
    [
      'Pakistani domestic number',
      { phone: '0300 1234567', country: 'Pakistan', countryCode: 'PK' },
      '+923001234567',
      'PK',
    ],
    [
      'UK domestic number',
      { phone: '020 7946 0018', country: 'United Kingdom', countryCode: 'GB' },
      '+442079460018',
      'GB',
    ],
    [
      'US domestic number',
      { phone: '(415) 555-2671', country: 'United States', countryCode: 'US' },
      '+14155552671',
      'US',
    ],
    [
      'country name without an ISO field',
      { phone: '020 7946 0018', country: 'United Kingdom' },
      '+442079460018',
      'GB',
    ],
    [
      'explicit number independent of shipping country',
      { phone: '+1 415 555 2671', country: 'Pakistan', countryCode: 'PK' },
      '+14155552671',
      'PK',
    ],
    [
      '00 international prefix',
      { phone: '0044 20 7946 0018', country: 'Pakistan', countryCode: 'PK' },
      '+442079460018',
      'PK',
    ],
  ])('canonicalizes a %s without changing its destination', (_label, shipping, e164, countryCode) => {
    expect(canonicalizeShippingPhone(shipping)).toEqual({
      e164,
      digits: e164.slice(1),
      countryCode,
    });
  });

  test.each([
    [{ phone: '3001234567' }, /valid shipping country/i],
    [{ phone: '03001234567', country: 'Not A Country' }, /valid shipping country/i],
    [{ phone: '03001234567', country: 'United States', countryCode: 'US' }, /valid international phone/i],
    [{ phone: '+92 300 1234567 ext 2', countryCode: 'PK' }, /valid international phone/i],
    [{ phone: '+00012345678', countryCode: 'PK' }, /valid international phone/i],
  ])('fails closed instead of guessing a destination for %j', (shipping, message) => {
    expect(() => canonicalizeShippingPhone(shipping)).toThrow(message);
    try {
      canonicalizeShippingPhone(shipping);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, code: 'SHIPPING_PHONE_INVALID' });
    }
  });

  test('legacy orders derive from their frozen country while new snapshots remain authoritative', () => {
    const legacy = {
      shippingInfo: {
        phone: '020 7946 0018',
        country: 'United Kingdom',
        countryCode: 'GB',
      },
    };
    expect(orderBuyerPhoneE164(legacy)).toBe('+442079460018');
    expect(orderBuyerPhoneDigits(legacy)).toBe('442079460018');

    const snapshotted = {
      shippingInfo: {
        phone: '0300 1234567',
        country: 'Pakistan',
        countryCode: 'PK',
        phoneE164: '+14155552671',
      },
    };
    expect(orderBuyerPhoneE164(snapshotted)).toBe('+14155552671');
  });

  test('a malformed stored snapshot never falls back to a different raw number', () => {
    const corrupt = {
      shippingInfo: {
        phone: '+923001234567',
        country: 'Pakistan',
        countryCode: 'PK',
        phoneE164: '442079460018',
      },
    };
    expect(() => orderBuyerPhoneE164(corrupt)).toThrow(/stored international phone/i);
    expect(tryOrderBuyerPhoneE164(corrupt)).toBe('');
  });

  test('explicit E.164 validation accepts supported formatting but rejects bare digits', () => {
    expect(normalizeExplicitE164('+44 (20) 7946-0018')).toBe('+442079460018');
    expect(normalizeExplicitE164('00442079460018')).toBe('+442079460018');
    expect(() => normalizeExplicitE164('442079460018')).toThrow(/stored international phone/i);
  });

  test('the internal WhatsApp queue never prepends Pakistan to a local number', () => {
    expect(normalizeQueuePhone('0300 1234567')).toBe('');
    expect(normalizeQueuePhone('+92 300 1234567')).toBe('923001234567');
    expect(normalizeQueuePhone('442079460018')).toBe('442079460018');
    expect(normalizeQueuePhone('0014155552671')).toBe('14155552671');
  });
});
