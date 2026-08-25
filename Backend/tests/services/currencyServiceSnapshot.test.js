'use strict';

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');

const loadCurrencyService = () => {
  let service;
  jest.isolateModules(() => {
    service = require('../../services/currencyService');
  });
  return service;
};

const LIVE_RATES = { PKR: 280, EUR: 0.9, GBP: 0.8 };
const liveResponse = () => ({
  data: { rates: LIVE_RATES },
});

describe('currencyService shared snapshot cache contract', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
    axios.get.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('marks hard-coded fallback untrusted, then retries it after one minute and promotes a live table', async () => {
    const service = loadCurrencyService();
    axios.get.mockRejectedValue(new Error('providers unavailable'));

    const fallback = await service.getExchangeRateSnapshot();
    expect(fallback).toMatchObject({ source: 'fallback', fallback: true });
    expect(fallback.rates).toEqual(service.FALLBACK_RATES);
    expect(axios.get).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30_000);
    await service.getExchangeRateSnapshot();
    expect(axios.get).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(31_000);
    axios.get.mockReset().mockResolvedValue(liveResponse());
    const live = await service.getExchangeRateSnapshot();

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(live).toMatchObject({
      source: 'exchangerate-api.com',
      fallback: false,
      rates: { USD: 1, ...LIVE_RATES },
    });
    expect(new Date(live.capturedAt).getTime()).toBe(Date.now());
  });

  test('keeps the last table for display but marks it untrusted as soon as a live refresh fails', async () => {
    const service = loadCurrencyService();
    axios.get.mockResolvedValueOnce(liveResponse());
    const initial = await service.getExchangeRateSnapshot();
    expect(initial.fallback).toBe(false);
    const capturedAt = initial.capturedAt;

    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    axios.get.mockReset().mockRejectedValue(new Error('temporary outage'));
    const recentOutage = await service.getExchangeRateSnapshot();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(recentOutage).toMatchObject({
      source: 'stale',
      fallback: true,
      rates: { USD: 1, ...LIVE_RATES },
      capturedAt,
    });

    jest.advanceTimersByTime(30_000);
    axios.get.mockClear();
    const cachedStale = await service.getExchangeRateSnapshot();
    expect(axios.get).not.toHaveBeenCalled();
    expect(cachedStale).toMatchObject({ source: 'stale', fallback: true });

    jest.setSystemTime(new Date('2026-08-14T00:01:02.000Z'));
    axios.get.mockClear();
    const stale = await service.getExchangeRateSnapshot();
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(stale).toMatchObject({
      source: 'stale',
      fallback: true,
      rates: { USD: 1, ...LIVE_RATES },
      capturedAt,
    });
  });

  test('deduplicates concurrent provider refreshes into one shared snapshot', async () => {
    const service = loadCurrencyService();
    axios.get.mockResolvedValue(liveResponse());

    const snapshots = await Promise.all(Array.from(
      { length: 20 },
      () => service.getExchangeRateSnapshot(),
    ));

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(new Set(snapshots.map(snapshot => JSON.stringify(snapshot))).size).toBe(1);
  });

  test('converts every supported currency pair from one exact rate table', () => {
    const service = loadCurrencyService();
    const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
    const cases = [
      ['USD', 'PKR', 1, 280], ['PKR', 'USD', 280, 1],
      ['USD', 'EUR', 10, 9], ['EUR', 'USD', 9, 10],
      ['USD', 'GBP', 10, 8], ['GBP', 'USD', 8, 10],
      ['PKR', 'EUR', 280, 0.9], ['EUR', 'PKR', 0.9, 280],
      ['PKR', 'GBP', 280, 0.8], ['GBP', 'PKR', 0.8, 280],
      ['EUR', 'GBP', 9, 8], ['GBP', 'EUR', 8, 9],
    ];

    for (const [from, to, amount, expected] of cases) {
      expect(service.convertAmountWithRates(amount, from, to, rates)).toBe(expected);
    }
    for (const currency of Object.keys(rates)) {
      expect(service.convertAmountWithRates(123.45, currency, currency, rates)).toBe(123.45);
    }
  });

  test('rejects coercible or non-USD-base rate tables before any money write can trust them', () => {
    const service = loadCurrencyService();
    expect(service.normalizeRates({ USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 })).toEqual({
      USD: 1,
      PKR: 280,
      EUR: 0.9,
      GBP: 0.8,
    });
    expect(service.normalizeRates({ USD: 1, PKR: true, EUR: 0.9, GBP: 0.8 })).toBeNull();
    expect(service.normalizeRates({ USD: 2, PKR: 280, EUR: 0.9, GBP: 0.8 })).toBeNull();
    expect(service.normalizeRates({ PKR: 280, EUR: 0.9, GBP: 0.8 })).toBeNull();
  });

  test.each([true, false, '', '   ', null, undefined, {}, [], 'NaN', Infinity])(
    'trusted money conversion rejects invalid input %p instead of coercing it',
    async value => {
      const service = loadCurrencyService();
      await expect(service.convertAmountUsingTrustedRates(
        value,
        'USD',
        'USD',
        { fallback: false, rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 } },
      )).rejects.toMatchObject({ code: 'MONEY_AMOUNT_INVALID', statusCode: 400 });
    },
  );

  test.each([
    ['JPY', 'USD'],
    ['USD', 'CAD'],
    ['', 'USD'],
  ])('trusted conversion rejects unsupported %s -> %s instead of coercing it to USD', async (from, to) => {
    const service = loadCurrencyService();
    await expect(service.convertAmountUsingTrustedRates(
      10,
      from,
      to,
      { fallback: false, rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 } },
      )).rejects.toMatchObject({ code: 'UNSUPPORTED_CURRENCY', statusCode: 400 });
  });

  test.each([true, false, '', '   ', null, undefined, {}, [], 'NaN', Infinity])(
    'generic conversion rejects invalid input %p instead of displaying or calculating zero',
    value => {
      const service = loadCurrencyService();
      expect(() => service.convertAmountWithRates(
        value,
        'USD',
        'USD',
        { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      )).toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
      expect(() => service.convertAmountSync(value, 'USD', 'USD'))
        .toThrow(expect.objectContaining({ code: 'MONEY_AMOUNT_INVALID' }));
    },
  );

  test.each([
    ['CAD', 'USD'],
    ['USD', 'JPY'],
    ['', 'USD'],
  ])('generic conversion rejects unsupported %s -> %s instead of relabelling it USD', (from, to) => {
    const service = loadCurrencyService();
    expect(() => service.convertAmountWithRates(
      10,
      from,
      to,
      { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CURRENCY' }));
  });
});
