import { readFileSync } from 'fs';
import {
  calculateSellerStats,
  readNonNegativePresentationCount,
  readSellerProductRating,
  sellerOrdersSnapshotIsValid,
  sellerStoreInventorySnapshotIsValid,
} from '../../src/utils/sellerDashboardStats';

const product = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  name: 'Native-price product',
  category: 'Bags',
  stock: 5,
  rating: 4.5,
  isFeatured: false,
  ...overrides,
});

const order = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439012',
  currency: 'PKR',
  orderStatus: 'delivered',
  paymentMethod: 'cash_on_delivery',
  isPaid: false,
  orderItems: [{ quantity: 2, price: 100, lineSubtotal: 200 }],
  orderSummary: {
    subtotal: 200,
    shippingCost: 0,
    tax: 0,
    couponDiscount: 0,
    totalAmount: 200,
  },
  ...overrides,
});

describe('seller mobile presentation safety', () => {
  it('accepts exact stock, rating, order money, and counts', () => {
    expect(sellerStoreInventorySnapshotIsValid([product()])).toBe(true);
    expect(sellerOrdersSnapshotIsValid([order()])).toBe(true);
    expect(readSellerProductRating(product())).toBe(4.5);
    expect(readNonNegativePresentationCount(0)).toBe(0);
    expect(calculateSellerStats([product()], [order()])).toEqual(expect.objectContaining({
      totalProducts: 1,
      totalOrders: 1,
      deliveredOrders: 1,
      lowStock: 1,
    }));
  });

  it.each(['5', true, null, -1, 1.5, Infinity])(
    'rejects corrupt stock rather than deriving an inventory count: %p',
    (stock) => expect(sellerStoreInventorySnapshotIsValid([product({ stock })])).toBe(false),
  );

  it('rejects missing, conflicting, or out-of-range product ratings', () => {
    const missing = product();
    delete missing.rating;
    expect(sellerStoreInventorySnapshotIsValid([missing])).toBe(false);
    expect(readSellerProductRating(product({ rating: 4, averageRating: 3 }))).toBeNull();
    expect(readSellerProductRating(product({ rating: 5.1 }))).toBeNull();
  });

  it('rejects seller orders with corrupt money, currency, state, or quantity', () => {
    expect(sellerOrdersSnapshotIsValid([order({ currency: 'pkr' })])).toBe(false);
    expect(sellerOrdersSnapshotIsValid([order({ isPaid: 'false' })])).toBe(false);
    expect(sellerOrdersSnapshotIsValid([order({
      orderItems: [{ quantity: '2', price: 100, lineSubtotal: 200 }],
    })])).toBe(false);
    expect(sellerOrdersSnapshotIsValid([order({
      orderSummary: { ...order().orderSummary, totalAmount: 200.001 },
    })])).toBe(false);
    expect(sellerOrdersSnapshotIsValid([order(), order()])).toBe(false);
  });

  it('keeps verified empty arrays distinct from unavailable snapshots', () => {
    expect(calculateSellerStats([], [])).toEqual(expect.objectContaining({ totalOrders: 0 }));
    expect(calculateSellerStats(null, [])).toBeNull();
    expect(calculateSellerStats([], null)).toBeNull();
  });

  it('keeps coercive presentation fallbacks out of the hardened screens', () => {
    const wallet = readFileSync(require.resolve('../../src/screens/WalletScreen.js'), 'utf8');
    const detail = readFileSync(require.resolve('../../src/screens/OrderDetailScreen.js'), 'utf8');
    const overview = readFileSync(require.resolve('../../src/screens/shared/StoreOverviewScreen.js'), 'utf8');
    const dashboard = readFileSync(require.resolve('../../src/screens/seller/SellerDashboardScreen.js'), 'utf8');
    expect(wallet).not.toMatch(/displayedAmount\s*\|\|\s*0/);
    expect(wallet).not.toMatch(/balances\?\.\[code\]\s*\?\?\s*0/);
    expect(detail).not.toMatch(/Number\(item\.quantity\s*\|\|/);
    expect(overview).not.toMatch(/Number\(product\?\.(?:stock|rating)/);
    expect(overview).not.toMatch(/Number\(store\?\.trustCount/);
    expect(dashboard).not.toMatch(/Number\(notificationsResult/);
  });

  it('requests every seller revenue surface in the authoritative store currency', () => {
    const analytics = readFileSync(require.resolve('../../src/screens/seller/SellerAnalyticsScreen.js'), 'utf8');
    const overview = readFileSync(require.resolve('../../src/screens/shared/StoreOverviewScreen.js'), 'utf8');
    const dashboard = readFileSync(require.resolve('../../src/screens/seller/SellerDashboardScreen.js'), 'utf8');

    for (const source of [analytics, overview, dashboard]) {
      expect(source).toContain('API_ENDPOINTS.STORES.PRODUCT_CURRENCY');
      expect(source).toContain('inspectSellerProductCurrencyState');
      expect(source).toContain('activeCurrency');
      expect(source).not.toMatch(/const \{ currency, formatAmount \} = useCurrency\(\)/);
    }
  });

  it('refreshes seller dashboard totals after returning from the shared AI screen', () => {
    const dashboard = readFileSync(require.resolve('../../src/screens/seller/SellerDashboardScreen.js'), 'utf8');

    expect(dashboard).toContain("import { useFocusEffect } from '@react-navigation/native';");
    expect(dashboard).toContain('useFocusEffect(useCallback(() => {');
    expect(dashboard).toContain('dashboardRequestRef.current += 1;');
    expect(dashboard).toContain("navigation.navigate('AIChat', { role: 'seller' })");
    expect(dashboard).not.toContain('closeAssistantAndRefresh');
    expect(dashboard).toContain('const freshParams = { _mobileRefresh: refreshKey };');
    expect(dashboard).toContain('fetchCompleteSellerCatalog(api, { refreshKey })');
  });

  it('keeps seller-owned catalog prices in each product native currency', () => {
    const products = readFileSync(require.resolve('../../src/screens/shared/ProductManagementScreen.js'), 'utf8');

    expect(products).toContain("return formatAmount(amount, { targetCurrency: presentation.currency });");
    expect(products).toContain("if (isAdmin) return formatProductPrice(item, { field });");
    expect(products).toContain("formatManagedPrice(hasDiscount ? 'discountedPrice' : 'price')");
  });
});
