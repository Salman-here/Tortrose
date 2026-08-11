import {
  buildOrderFilterParams,
  validateOrderDateRange,
} from '../../src/utils/sellerOrderExport';

jest.mock('expo-file-system', () => ({ File: jest.fn(), Paths: { cache: 'cache://' } }));
jest.mock('expo-sharing', () => ({}));
jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
  API_ENDPOINTS: { ORDERS: { EXPORT: '/api/order/export' } },
}));

describe('seller order export helpers', () => {
  it('serializes only active server filters', () => {
    expect(buildOrderFilterParams({
      search: ' ORD-42 ',
      status: 'shipped',
      paymentStatus: 'paid',
      startDate: '2026-08-01',
      endDate: '2026-08-08',
    })).toEqual({
      search: 'ORD-42',
      status: 'shipped',
      paymentStatus: 'paid',
      startDate: '2026-08-01',
      endDate: '2026-08-08',
    });
  });

  it('omits all filters and blank values', () => {
    expect(buildOrderFilterParams({ status: 'all', paymentStatus: 'all', search: ' ' })).toEqual({});
  });

  it('rejects malformed and reversed ranges', () => {
    expect(validateOrderDateRange('08/01/2026', '')).toMatch(/YYYY-MM-DD/);
    expect(validateOrderDateRange('2026-08-09', '2026-08-08')).toMatch(/after end date/);
    expect(validateOrderDateRange('2026-08-01', '2026-08-08')).toBe('');
  });
});
