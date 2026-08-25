import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECKOUT_ATTEMPT_MAX_AGE_MS,
  createCheckoutFingerprint,
  isFreshCheckoutAttempt,
} from '../src/utils/checkoutIdempotency.js';
import {
  addCurrencyAmounts,
  allocateConvertedCurrencyAmounts,
  convertCurrencyAmount,
  convertCurrencyLineAmounts,
  normalizeCompleteExchangeRates,
  shouldRefreshExchangeRates,
  shouldRetainIdempotencyKey,
} from '../src/utils/currencySafety.js';
import {
  calculateCheckoutCouponPricing,
  createCheckoutMoneyCartSignature,
  isCheckoutRepriceRequired,
  isPositiveSourceAmountRoundedToZero,
  parseCheckoutCouponAvailabilityResponse,
  parseCheckoutShippingMethodsResponse,
  parseCheckoutTaxConfigResponse,
  parseValidatedCheckoutCouponResponse,
  reconcileAppliedCheckoutCoupons,
  selectCheckoutShippingMethods,
} from '../src/utils/checkoutPricing.js';
import {
  MUTATION_ATTEMPT_MAX_AGE_MS,
  clearPersistedMutationAttemptForFingerprint,
  createChatMutationFingerprint,
  createMutationAttemptRecordStorageKey,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttempt,
  getOrCreatePersistedMutationAttemptForFingerprint,
} from '../src/utils/persistedMutationAttempt.js';
import { shouldRetainWalletTopUpAttempt } from '../src/utils/walletPaymentRisk.js';

const checkoutIntent = () => ({
  orderItems: [
    { id: 'product-b', quantity: 2, price: 0.02, selectedOptions: { size: 'L', finish: 'matte' } },
    { id: 'product-a', quantity: 1, price: 5 },
  ],
  shippingInfo: { fullName: 'Buyer', address: '1 Test Road', city: 'Lahore' },
  buyerLocation: { country: 'Pakistan', city: 'Lahore' },
  shippingMethod: { seller: 'seller-a', name: 'standard', price: 4.1, estimatedDays: 4 },
  sellerShipping: [
    { seller: 'seller-b', shippingMethod: { name: 'fast', price: 9.5, estimatedDays: 2 } },
    { seller: 'seller-a', shippingMethod: { name: 'standard', price: 4.1, estimatedDays: 4 } },
  ],
  orderSummary: { subtotal: 5.04, shippingCost: 13.6, totalAmount: 18.64 },
  currency: 'PKR',
  appliedCoupons: [{ couponId: 'coupon-a', code: 'save10', applicableProductIds: ['product-b', 'product-a'], discountValue: 2 }],
  paymentMethod: 'wallet',
  instructions: 'Leave at reception',
});

test('web retries keep the fingerprint when only live prices or delivery estimates change', () => {
  const original = checkoutIntent();
  const refreshed = checkoutIntent();
  refreshed.orderItems[0].price = 0.03;
  refreshed.shippingMethod.price = 4.25;
  refreshed.shippingMethod.estimatedDays = 6;
  refreshed.sellerShipping[0].shippingMethod.price = 10.25;
  refreshed.sellerShipping[0].shippingMethod.estimatedDays = 3;
  refreshed.orderSummary = { subtotal: 5.06, shippingCost: 14.5, totalAmount: 19.56 };

  assert.equal(
    createCheckoutFingerprint(original, 'checkout_session', 'web'),
    createCheckoutFingerprint(refreshed, 'checkout_session', 'web'),
  );
});

test('web fingerprint canonicalizes item, coupon scope, seller, and object-key order', () => {
  const original = checkoutIntent();
  const reordered = checkoutIntent();
  original.shippingInfo.email = ' Buyer@Example.COM ';
  reordered.shippingInfo.email = 'buyer@example.com';
  reordered.orderItems.reverse();
  reordered.sellerShipping.reverse();
  reordered.appliedCoupons[0].applicableProductIds.reverse();
  reordered.shippingInfo = { city: 'Lahore', address: '1 Test Road', fullName: 'Buyer', email: 'buyer@example.com' };

  assert.equal(
    createCheckoutFingerprint(original, 'checkout_session', 'web'),
    createCheckoutFingerprint(reordered, 'checkout_session', 'web'),
  );
});

test('web fingerprint rotates for delivery method, payment method, or currency changes', () => {
  const original = checkoutIntent();
  const fingerprint = createCheckoutFingerprint(original, 'checkout_session', 'web');
  const changedMethod = checkoutIntent();
  changedMethod.sellerShipping[0].shippingMethod.name = 'standard';

  assert.notEqual(createCheckoutFingerprint(changedMethod, 'checkout_session', 'web'), fingerprint);
  assert.notEqual(createCheckoutFingerprint({ ...checkoutIntent(), paymentMethod: 'cash_on_delivery' }, 'checkout_session', 'web'), fingerprint);
  assert.notEqual(createCheckoutFingerprint({ ...checkoutIntent(), currency: 'USD' }, 'checkout_session', 'web'), fingerprint);
});

test('web checkout attempts remain eligible for replay for 24 hours', () => {
  const now = Date.now();
  assert.equal(isFreshCheckoutAttempt({ createdAt: now - CHECKOUT_ATTEMPT_MAX_AGE_MS + 1 }, now), true);
  assert.equal(isFreshCheckoutAttempt({ createdAt: now - CHECKOUT_ATTEMPT_MAX_AGE_MS }, now), false);
});

test('web shipping conversion preserves the combined cent for tiny foreign seller fees', () => {
  const allocations = convertCurrencyLineAmounts([
    { unitAmount: 1, quantity: 1, sourceCurrency: 'PKR' },
    { unitAmount: 1, quantity: 1, sourceCurrency: 'PKR' },
  ], 'USD', { USD: 1, PKR: 284.6 });

  assert.deepEqual(allocations, [0.01, 0]);
  assert.equal(addCurrencyAmounts(...allocations), 0.01);
});

test('web checkout accepts only canonical shipping data for exactly the cart sellers', () => {
  const payload = () => ({
    success: true,
    shippingMethods: {
      'seller-a': {
        seller: { _id: 'seller-a', username: 'Store A' },
        paymentPolicy: 'online_and_cod',
        allowsCashOnDelivery: true,
        methods: [{
          type: 'standard',
          cost: 25.5,
          currency: 'PKR',
          costCurrency: 'PKR',
          costInputAmount: 25.5,
          deliveryDays: 3,
          isActive: true,
        }],
      },
    },
  });
  assert.equal(
    parseCheckoutShippingMethodsResponse(payload(), ['seller-a'])['seller-a'].methods[0].cost,
    25.5,
  );

  const corruptions = [
    (value) => { value.success = false; },
    (value) => { value.shippingMethods['seller-b'] = value.shippingMethods['seller-a']; },
    (value) => { value.shippingMethods['seller-a'].seller._id = 'seller-b'; },
    (value) => { value.shippingMethods['seller-a'].paymentPolicy = 'advance_only'; },
    (value) => { value.shippingMethods['seller-a'].methods[0].cost = '25.50'; },
    (value) => { value.shippingMethods['seller-a'].methods[0].cost = 25.501; },
    (value) => { value.shippingMethods['seller-a'].methods[0].currency = 'pkr'; },
    (value) => { value.shippingMethods['seller-a'].methods[0].costCurrency = 'USD'; },
    (value) => { value.shippingMethods['seller-a'].methods[0].costInputAmount = null; },
    (value) => { value.shippingMethods['seller-a'].methods[0].deliveryDays = 1.5; },
    (value) => { value.shippingMethods['seller-a'].methods[0].isActive = false; },
    (value) => { value.shippingMethods['seller-a'].methods.push({ ...value.shippingMethods['seller-a'].methods[0] }); },
  ];
  corruptions.forEach((corrupt) => {
    const value = payload();
    corrupt(value);
    assert.throws(() => parseCheckoutShippingMethodsResponse(value, ['seller-a']));
  });
  assert.throws(() => parseCheckoutShippingMethodsResponse(payload(), ['seller-b']));
});

test('web tax loading accepts explicit zero configurations and rejects malformed values', () => {
  assert.deepEqual(
    parseCheckoutTaxConfigResponse({ success: true, taxConfig: { type: 'none', value: 0, currency: 'USD' } }),
    { type: 'none', value: 0, currency: 'USD' },
  );
  assert.deepEqual(
    parseCheckoutTaxConfigResponse({ success: true, taxConfig: { type: 'fixed', value: 25.25, currency: 'PKR' } }),
    { type: 'fixed', value: 25.25, currency: 'PKR' },
  );
  assert.equal(
    parseCheckoutTaxConfigResponse({ success: true, taxConfig: { type: 'percentage', value: 7.5, currency: 'USD' } }).value,
    7.5,
  );
  assert.deepEqual(
    parseCheckoutTaxConfigResponse({ success: true, taxConfig: { type: 'percentage', value: 0, currency: 'USD' } }),
    { type: 'percentage', value: 0, currency: 'USD' },
  );
  assert.deepEqual(
    parseCheckoutTaxConfigResponse({ success: true, taxConfig: { type: 'fixed', value: 0, currency: 'PKR' } }),
    { type: 'fixed', value: 0, currency: 'PKR' },
  );

  [
    { success: false, taxConfig: { type: 'none', value: 0 } },
    { success: true },
    { success: true, taxConfig: [] },
    { success: true, taxConfig: { type: 'NONE', value: 0, currency: 'USD' } },
    { success: true, taxConfig: { type: 'none', value: 9, currency: 'PKR' } },
    { success: true, taxConfig: { type: 'none', value: 0, currency: 'pkr' } },
    { success: true, taxConfig: { type: 'percentage', value: '7.5', currency: 'USD' } },
    { success: true, taxConfig: { type: 'percentage', value: 7.1234567, currency: 'USD' } },
    { success: true, taxConfig: { type: 'percentage', value: 7.5, currency: 'PKR' } },
    { success: true, taxConfig: { type: 'percentage', value: 101 } },
    { success: true, taxConfig: { type: 'fixed', value: 1, currency: 'JPY' } },
    { success: true, taxConfig: { type: 'fixed', value: '1.00', currency: 'USD' } },
    { success: true, taxConfig: { type: 'fixed', value: 1.001, currency: 'USD' } },
    { success: true, taxConfig: { type: 'fixed', value: 1, currency: 'usd' } },
    { success: true, taxConfig: { type: 'fixed', value: true, currency: 'USD' } },
  ].forEach((payload) => assert.throws(() => parseCheckoutTaxConfigResponse(payload)));
});

test('web coupon availability and apply responses require canonical authoritative terms', () => {
  const coupon = {
    _id: 'coupon-a',
    code: 'SAVE_10',
    discountType: 'percentage',
    discountValue: 10,
    currency: 'PKR',
    applicableTo: 'selected',
    applicableProducts: ['product-a'],
    minOrderAmount: 100,
    maxDiscountAmount: 25,
  };
  const available = parseCheckoutCouponAvailabilityResponse({
    sellerCoupons: { 'seller-a': [coupon] },
  }, ['seller-a']);
  assert.equal(available['seller-a'][0].discountValue, 10);

  const validated = parseValidatedCheckoutCouponResponse({
    valid: true,
    coupon: {
      ...coupon,
      seller: 'seller-a',
      applicableProductIds: ['product-a'],
    },
  }, { expectedSellerIds: ['seller-a'], expectedProductIds: ['product-a'] });
  assert.equal(validated.seller, 'seller-a');

  for (const mutation of [
    { discountValue: '10' },
    { discountValue: 10.1234567 },
    { currency: 'pkr' },
    { minOrderAmount: 100.001 },
    { maxDiscountAmount: 0 },
    { applicableProducts: [] },
  ]) {
    assert.throws(() => parseCheckoutCouponAvailabilityResponse({
      sellerCoupons: { 'seller-a': [{ ...coupon, ...mutation }] },
    }, ['seller-a']));
  }
  assert.throws(() => parseCheckoutCouponAvailabilityResponse({
    sellerCoupons: { 'seller-b': [coupon] },
  }, ['seller-a']));
  assert.throws(() => parseValidatedCheckoutCouponResponse({
    valid: true,
    coupon: { ...coupon, seller: 'seller-b', applicableProductIds: ['product-a'] },
  }, { expectedSellerIds: ['seller-a'], expectedProductIds: ['product-a'] }));
});

test('web rate payload validation rejects coercible booleans and the wrong USD base', () => {
  assert.deepEqual(
    normalizeCompleteExchangeRates({ USD: 1, PKR: '284.6', EUR: 0.92, GBP: 0.79 }),
    { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
  );
  assert.equal(normalizeCompleteExchangeRates({ USD: 1, PKR: true, EUR: 0.92, GBP: 0.79 }), null);
  assert.equal(normalizeCompleteExchangeRates({ USD: 2, PKR: 284.6, EUR: 0.92, GBP: 0.79 }), null);
});

test('web refreshes stale live rates and retries fallback rates without focus storms', () => {
  const now = 1_000_000;
  assert.equal(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 5_000, lastLiveAt: 0 }), false);
  assert.equal(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 60_000, lastLiveAt: 0 }), true);
  assert.equal(shouldRefreshExchangeRates({ now, lastAttemptAt: now - 60_000, lastLiveAt: now - 10_000 }), false);
  assert.equal(shouldRefreshExchangeRates({
    now,
    lastAttemptAt: now - 60_000,
    lastLiveAt: now - (15 * 60 * 1000),
  }), true);
});

test('web recognizes only the authoritative checkout reprice conflict', () => {
  assert.equal(isCheckoutRepriceRequired({ response: { status: 409, data: { code: 'CHECKOUT_REPRICE_REQUIRED' } } }), true);
  assert.equal(isCheckoutRepriceRequired({ response: { status: 409, data: { code: 'COUPON_UPDATE_CONFLICT' } } }), false);
  assert.equal(isCheckoutRepriceRequired({ response: { status: 400, data: { code: 'CHECKOUT_REPRICE_REQUIRED' } } }), false);
});

test('web labels positive native shipping that rounds below one target cent without calling it free', () => {
  assert.equal(isPositiveSourceAmountRoundedToZero(1, 0), true);
  assert.equal(isPositiveSourceAmountRoundedToZero(0, 0), false);
  assert.equal(isPositiveSourceAmountRoundedToZero(1, 0.01), false);
});

test('web cart identity and reconciliation track product plus seller without depending on object order', () => {
  const cart = [
    { product: { _id: 'product-b', seller: { _id: 'seller-b' } } },
    { product: { _id: 'product-a', seller: 'seller-a' } },
  ];
  const reorderedClone = [
    { product: { _id: 'product-a', seller: { _id: 'seller-a' } } },
    { product: { _id: 'product-b', seller: 'seller-b' } },
  ];
  assert.equal(createCheckoutMoneyCartSignature(cart), createCheckoutMoneyCartSignature(reorderedClone));
  assert.notEqual(
    createCheckoutMoneyCartSignature(cart),
    createCheckoutMoneyCartSignature([
      { product: { _id: 'product-b', seller: 'seller-a' } },
      { product: { _id: 'product-a', seller: 'seller-a' } },
    ]),
  );

  const selections = selectCheckoutShippingMethods({
    'seller-a': { methods: [{ type: 'standard', cost: 7, isActive: true }] },
  }, {
    'seller-a': { type: 'standard', cost: 5 },
    'seller-b': { type: 'fast', cost: 10 },
  });
  assert.deepEqual(selections, { 'seller-a': { type: 'standard', cost: 7, isActive: true } });

  const reconciled = reconcileAppliedCheckoutCoupons({
    'seller-seller-a': {
      _id: 'coupon-a', seller: 'seller-a', discountValue: 5,
      applicableProductIds: ['product-a', 'product-b'],
    },
    'seller-seller-b': {
      _id: 'coupon-b', seller: 'seller-b', applicableProductIds: ['product-b'],
    },
  }, [cart[1]], {
    'seller-a': [{ _id: 'coupon-a', applicableTo: 'all', discountValue: 8 }],
  });
  assert.deepEqual(Object.keys(reconciled), ['seller-seller-a']);
  assert.equal(reconciled['seller-seller-a'].discountValue, 8);
  assert.deepEqual(reconciled['seller-seller-a'].applicableProductIds, ['product-a']);
});

test('web checkout wiring blocks unknown tax and requires a fresh submit after authoritative repricing', () => {
  const source = readFileSync(
    new URL('../src/components/layout/Checkout.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /const \[taxStatus, setTaxStatus\] = useState\('loading'\)/);
  assert.match(source, /const checkoutBlocked = !isCartReady \|\| taxUnavailable \|\| !shippingReady \|\| checkoutRatesUnavailable/);
  assert.match(source, /parseCheckoutShippingMethodsResponse\(res\.data, expectedSellerIds\)/);
  assert.match(source, /parseCheckoutCouponAvailabilityResponse\(res\.data, sellerIds\)/);
  assert.match(source, /setAppliedCoupons\(\{\}\);[\s\S]*?fetchAvailableCoupons\(cartItems\.cart, couponCandidates\)/);
  assert.match(source, /if \(isCheckoutRepriceRequired\(error\)\)/);
  assert.match(source, /clearPersistedMutationAttemptFromLedger\([\s\S]*?fingerprint,[\s\S]*?attemptKey,/);
  assert.match(source, /Review the new total and press the payment button again/);
  assert.match(source, /formatShippingOptionPrice\(method, \{ seller \}\)/);
  assert.doesNotMatch(source, /methodCost === 0 \? ['"]Free['"]/);
});

test('web coupon totals use backend-equivalent global foreign-cent allocation', () => {
  const rates = { USD: 1, PKR: 284.6 };
  assert.deepEqual(allocateConvertedCurrencyAmounts([
    { sourceAmount: 4, sourceCurrency: 'PKR', maximumTargetAmount: 1, maximumAllocatedTargetAmount: 1 },
    { sourceAmount: 4, sourceCurrency: 'PKR', maximumTargetAmount: 1, maximumAllocatedTargetAmount: 1 },
  ], 'USD', rates), [0.02, 0.01]);

  const pricing = calculateCheckoutCouponPricing({
    appliedCoupons: [
      { _id: 'coupon-b', code: 'B', currency: 'PKR', discountType: 'fixed', discountValue: 4, applicableProductIds: ['product-b'] },
      { _id: 'coupon-a', code: 'A', currency: 'PKR', discountType: 'fixed', discountValue: 4, applicableProductIds: ['product-a'] },
    ],
    cartItems: [
      { _id: 'line-a', product: { _id: 'product-a' }, qty: 1 },
      { _id: 'line-b', product: { _id: 'product-b' }, qty: 1 },
    ],
    getItemLineTotal: () => 1,
    convertCouponAmount: (amount, coupon) => convertCurrencyAmount(amount, coupon.currency, 'USD', rates),
    targetCurrency: 'USD',
    exchangeRates: rates,
  });

  assert.equal(pricing.error, null);
  assert.equal(pricing.totalDiscount, 0.03);
  assert.deepEqual(pricing.couponDiscounts.map(({ coupon, discount }) => [coupon._id, discount]), [
    ['coupon-a', 0.02],
    ['coupon-b', 0.01],
  ]);
});

test('web coupon preview rejects coercible, sub-cent, and unsupported server fields', () => {
  for (const override of [
    { discountValue: true },
    { discountValue: '1' },
    { discountValue: 1.001 },
    { discountType: 'percentage', discountValue: 0.1234567 },
    { minOrderAmount: false },
    { maxDiscountAmount: false },
    { currency: undefined },
    { currency: 'usd' },
    { currency: 'CAD' },
    { discountType: 'mystery' },
    { discountValue: 70368744177664.02 },
  ]) {
    const pricing = calculateCheckoutCouponPricing({
      appliedCoupons: [{
        _id: 'coupon-corrupt',
        code: 'BAD',
        currency: 'USD',
        discountType: 'fixed',
        discountValue: 1,
        applicableProductIds: ['product-a'],
        ...override,
      }],
      cartItems: [{ _id: 'line-a', product: { _id: 'product-a' }, qty: 1 }],
      getItemLineTotal: () => 10,
      targetCurrency: 'USD',
      exchangeRates: { USD: 1 },
    });
    assert.equal(pricing.totalDiscount, 0);
    assert.match(pricing.error, /invalid/);
  }
});

test('web money/chat mutations reuse persisted 24-hour attempts and rotate on intent changes', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const uuids = ['first', 'second'];
  const now = 1_800_000_000_000;
  const first = getOrCreatePersistedMutationAttempt({
    storage, storageKey: 'attempt', fingerprint: 'USD:5.00', keyPrefix: 'wallet',
    randomUUID: () => uuids.shift(), now,
  });
  const replay = getOrCreatePersistedMutationAttempt({
    storage, storageKey: 'attempt', fingerprint: 'USD:5.00', keyPrefix: 'wallet',
    randomUUID: () => uuids.shift(), now: now + MUTATION_ATTEMPT_MAX_AGE_MS - 1,
  });
  const changed = getOrCreatePersistedMutationAttempt({
    storage, storageKey: 'attempt', fingerprint: 'PKR:5.00', keyPrefix: 'wallet',
    randomUUID: () => uuids.shift(), now: now + 1000,
  });

  assert.equal(MUTATION_ATTEMPT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  assert.equal(createScopedMutationStorageKey('checkout', 'seller/one'), 'checkout:seller%2Fone');
  assert.notEqual(
    createScopedMutationStorageKey('checkout', 'seller-a'),
    createScopedMutationStorageKey('checkout', 'seller-b'),
  );
  assert.equal(replay.key, first.key);
  assert.notEqual(changed.key, first.key);
  assert.equal(
    createChatMutationFingerprint({ actorId: 'u1', currency: 'pkr', text: ' Confirm order ' }),
    createChatMutationFingerprint({ actorId: 'u1', currency: 'PKR', text: 'Confirm order' }),
  );
});

test('web mutations fail closed when durable attempt persistence cannot be read back', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  assert.throws(() => getOrCreatePersistedMutationAttempt({
    storage,
    storageKey: 'attempt',
    fingerprint: 'USD:5.00',
    keyPrefix: 'wallet',
    randomUUID: () => 'uuid',
  }), /could not be confirmed/);
});

test('web chat uses independent collision-free records and rotates only a terminal intent', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const uuids = ['first', 'second', 'after-terminal'];
  const now = 1_800_000_000_000;
  const [first, second] = await Promise.all([
    getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
      randomUUID: () => uuids.shift(), now,
    }),
    getOrCreatePersistedMutationAttemptForFingerprint({
      storage, storageKey: 'chat-ledger', fingerprint: 'intent-b', keyPrefix: 'chat',
      randomUUID: () => uuids.shift(), now: now + 1,
    }),
  ]);
  const firstReplay = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
    randomUUID: () => uuids.shift(), now: now + 2,
  });

  assert.equal(firstReplay.key, first.key);
  assert.notEqual(second.key, first.key);
  const firstRecordKey = await createMutationAttemptRecordStorageKey('chat-ledger', 'intent-a');
  const secondRecordKey = await createMutationAttemptRecordStorageKey('chat-ledger', 'intent-b');
  assert.notEqual(firstRecordKey, secondRecordKey);
  assert.equal(firstRecordKey.includes('intent-a'), false);
  assert.ok(firstRecordKey.length < 100);
  assert.equal(JSON.parse(values.get(firstRecordKey)).attempt.key, first.key);
  assert.equal(JSON.parse(values.get(secondRecordKey)).attempt.key, second.key);
  assert.equal(values.has('chat-ledger'), false);

  assert.equal(
    await clearPersistedMutationAttemptForFingerprint(storage, 'chat-ledger', 'intent-b', second.key, now + 3),
    true,
  );
  const afterTerminal = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: 'intent-b', keyPrefix: 'chat',
    randomUUID: () => uuids.shift(), now: now + 4,
  });
  assert.notEqual(afterTerminal.key, second.key);
  assert.equal(JSON.parse(values.get(firstRecordKey)).attempt.key, first.key);
});

test('web migrates every fresh legacy retry without deleting the shared safety copy', async () => {
  const now = 1_800_000_000_000;
  const legacyAttempts = [
    { key: 'chat:legacy-a', fingerprint: 'intent-a', createdAt: now - 2 },
    { key: 'chat:legacy-b', fingerprint: 'intent-b', createdAt: now - 1 },
  ];
  const values = new Map([[
    'chat-ledger',
    JSON.stringify({ version: 1, attempts: legacyAttempts }),
  ]]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: 'intent-c', keyPrefix: 'chat',
    randomUUID: () => 'new-c', now,
  });
  for (const attempt of legacyAttempts) {
    const recordKey = await createMutationAttemptRecordStorageKey('chat-ledger', attempt.fingerprint);
    const persisted = JSON.parse(values.get(recordKey));
    assert.equal(persisted.attempt.key, attempt.key);
    assert.equal(persisted.attempt.createdAt, attempt.createdAt);
  }
  assert.deepEqual(JSON.parse(values.get('chat-ledger')).attempts, legacyAttempts);

  await clearPersistedMutationAttemptForFingerprint(
    storage,
    'chat-ledger',
    'intent-a',
    legacyAttempts[0].key,
    now + 1,
  );
  const rotated = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: 'intent-a', keyPrefix: 'chat',
    randomUUID: () => 'new-a', now: now + 2,
  });
  assert.notEqual(rotated.key, legacyAttempts[0].key);
  assert.match(rotated.key, /^chat:v2:[a-f0-9]{64}:1$/);
});

test('web confirmation retries remain fail-closed until their exact attempt is terminal', async () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const now = 1_800_000_000_000;
  const fingerprint = createChatMutationFingerprint({
    actorId: 'buyer-1', currency: 'PKR', text: 'yes',
  });
  const retypedFingerprint = createChatMutationFingerprint({
    actorId: 'buyer-1', currency: 'pkr', text: ' YES ',
    conversationId: 'changed-after-lost-response',
  });
  assert.equal(retypedFingerprint, fingerprint);

  const first = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint, keyPrefix: 'chat',
    randomUUID: () => 'first', now,
  });
  const unresolvedRetry = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: retypedFingerprint, keyPrefix: 'chat',
    randomUUID: () => 'must-not-run', now: now + 1,
  });
  assert.equal(unresolvedRetry.key, first.key);

  await clearPersistedMutationAttemptForFingerprint(
    storage,
    'chat-ledger',
    fingerprint,
    first.key,
    now + 2,
  );
  const deliberateNextYes = await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint, keyPrefix: 'chat',
    randomUUID: () => 'second', now: now + 3,
  });
  assert.notEqual(deliberateNextYes.key, first.key);
  assert.equal([...values.keys()].filter(key => key.includes(':terminal:')).length, 1);

  await getOrCreatePersistedMutationAttemptForFingerprint({
    storage, storageKey: 'chat-ledger', fingerprint: 'cleanup-trigger', keyPrefix: 'chat',
    now: now + MUTATION_ATTEMPT_MAX_AGE_MS + 4,
  });
  assert.equal([...values.keys()].filter(key => key.includes(':terminal:')).length, 0);
});

test('web tabs without Web Locks derive one idempotency key for a same-fingerprint race', async () => {
  const nonce = `${Date.now()}-${Math.random()}`;
  const moduleUrl = new URL('../src/utils/persistedMutationAttempt.js', import.meta.url);
  const [tabA, tabB] = await Promise.all([
    import(`${moduleUrl.href}?tab-a=${nonce}`),
    import(`${moduleUrl.href}?tab-b=${nonce}`),
  ]);
  const values = new Map();
  const makeStorage = () => ({
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  const now = 1_800_000_000_000;
  const [attemptA, attemptB] = await Promise.all([
    tabA.getOrCreatePersistedMutationAttemptForFingerprint({
      storage: makeStorage(), storageKey: 'chat-ledger', fingerprint: 'same-intent',
      keyPrefix: 'chat', now,
    }),
    tabB.getOrCreatePersistedMutationAttemptForFingerprint({
      storage: makeStorage(), storageKey: 'chat-ledger', fingerprint: 'same-intent',
      keyPrefix: 'chat', now,
    }),
  ]);
  assert.equal(attemptA.key, attemptB.key);
  assert.match(attemptA.key, /^chat:v2:[a-f0-9]{64}:0$/);
});

test('web checkout, Wallet, and withdrawal tabs cannot split one intent into different keys', async () => {
  const moduleUrl = new URL('../src/utils/persistedMutationAttempt.js', import.meta.url);
  const surfaces = [
    { storageKey: 'checkout:user-1', fingerprint: 'buyer-1:checkout-intent', keyPrefix: 'web-checkout' },
    { storageKey: 'wallet:user-1', fingerprint: 'buyer-1:PKR:500.00', keyPrefix: 'web-wallet' },
    { storageKey: 'withdrawal:seller-1', fingerprint: 'seller-1:USD:25.00', keyPrefix: 'seller-withdrawal' },
  ];

  for (const [index, surface] of surfaces.entries()) {
    const nonce = `${Date.now()}-${Math.random()}-${index}`;
    const [tabA, tabB, tabC] = await Promise.all([
      import(`${moduleUrl.href}?money-tab-a=${nonce}`),
      import(`${moduleUrl.href}?money-tab-b=${nonce}`),
      import(`${moduleUrl.href}?money-tab-c=${nonce}`),
    ]);
    const values = new Map();
    const makeStorage = () => ({
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    });
    const options = { ...surface, storage: makeStorage(), now: 1_800_000_000_000 };
    const [attemptA, attemptB, attemptC] = await Promise.all([
      tabA.getOrCreatePersistedMutationAttemptInLedger(options),
      tabB.getOrCreatePersistedMutationAttemptInLedger({ ...options, storage: makeStorage() }),
      tabC.getOrCreatePersistedMutationAttemptInLedger({ ...options, storage: makeStorage() }),
    ]);

    assert.equal(attemptA.key, attemptB.key, surface.keyPrefix);
    assert.equal(attemptA.key, attemptC.key, surface.keyPrefix);
    assert.match(
      attemptA.key,
      new RegExp(`^${surface.keyPrefix}:v2:[a-f0-9]{64}:0$`),
    );
  }
});

test('web chat fails closed when an independent attempt cannot be read back', async () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  await assert.rejects(getOrCreatePersistedMutationAttemptForFingerprint({
    storage,
    storageKey: 'chat-ledger',
    fingerprint: 'intent-a',
    keyPrefix: 'chat',
    randomUUID: () => 'uuid',
  }), /could not be confirmed/);
});

test('web retains retry keys for ambiguous conflict responses', () => {
  assert.equal(shouldRetainIdempotencyKey(409), true);
  assert.equal(shouldRetainIdempotencyKey(400), false);
});

test('Wallet rotates only an authoritative terminal top-up retry response', () => {
  assert.equal(shouldRetainWalletTopUpAttempt({
    response: { status: 409, data: { code: 'WALLET_TOP_UP_RETRY_REQUIRED' } },
  }), false);
  assert.equal(shouldRetainWalletTopUpAttempt({
    response: { status: 409, data: { code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING' } },
  }), true);
  assert.equal(shouldRetainWalletTopUpAttempt({
    response: { status: 409, data: { code: 'IDEMPOTENCY_CONFLICT' } },
  }), true);
  assert.equal(shouldRetainWalletTopUpAttempt({ response: { status: 503, data: {} } }), true);
  assert.equal(shouldRetainWalletTopUpAttempt({ response: { status: 400, data: {} } }), false);
});

test('web money surfaces are wired to the per-fingerprint ledger and exact terminal clearing', () => {
  const checkoutSource = readFileSync(
    new URL('../src/components/layout/Checkout.jsx', import.meta.url),
    'utf8',
  );
  const walletSource = readFileSync(
    new URL('../src/components/layout/Wallet.jsx', import.meta.url),
    'utf8',
  );
  const withdrawalSource = readFileSync(
    new URL('../src/components/layout/SellerPayments.jsx', import.meta.url),
    'utf8',
  );

  for (const source of [checkoutSource, walletSource, withdrawalSource]) {
    assert.match(source, /await getOrCreatePersistedMutationAttemptInLedger\(\{/);
    assert.match(source, /clearPersistedMutationAttemptFromLedger\(/);
    assert.doesNotMatch(source, /const attempt = getOrCreatePersistedMutationAttempt\(\{/);
  }
  assert.match(walletSource, /shouldRetainWalletTopUpAttempt/);
  assert.match(walletSource, /\/top-ups\/\$\{encodeURIComponent\(transactionId\)\}\/status/);
  assert.match(walletSource, /Stripe checkout was closed\. Rozare is verifying the exact top-up/);
  assert.match(checkoutSource, /if \(!successAuthenticated\) \{[\s\S]*?navigate\('\/user-dashboard\/orders'/);
  assert.match(checkoutSource, /attemptFingerprint: fingerprint/);
  assert.match(checkoutSource, /attemptKey,/);
  assert.match(walletSource, /attemptKey: attempt\.key/);
  assert.doesNotMatch(walletSource, /clearPersistedMutationAttempt,/);
});

test('web stale generation completion and uncorrelated returns cannot terminalize a newer attempt', async () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const options = {
    storage,
    storageKey: 'wallet:buyer-1',
    fingerprint: 'buyer-1:PKR:500.00',
    keyPrefix: 'web-wallet',
  };
  const now = 1_800_000_000_000;
  const generation0 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now });
  assert.equal(await clearPersistedMutationAttemptForFingerprint(
    storage, options.storageKey, options.fingerprint, generation0.key, now + 1,
  ), true);
  const generation1 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now: now + 2 });

  assert.equal(await clearPersistedMutationAttemptForFingerprint(
    storage, options.storageKey, options.fingerprint, generation0.key, now + 3,
  ), false);
  assert.equal(await clearPersistedMutationAttemptForFingerprint(
    storage, options.storageKey, options.fingerprint, '', now + 4,
  ), false);
  const replay = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now: now + 5 });
  assert.equal(replay.key, generation1.key);
});

test('web ledger compaction never recycles an old durable backend idempotency key', async () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const options = {
    storage,
    storageKey: 'checkout:buyer-1',
    fingerprint: 'same-order-intent',
    keyPrefix: 'web-checkout',
  };
  const now = 1_800_000_000_000;
  const generation0 = await getOrCreatePersistedMutationAttemptForFingerprint({ ...options, now });
  assert.equal(await clearPersistedMutationAttemptForFingerprint(
    storage,
    options.storageKey,
    options.fingerprint,
    generation0.key,
    now + 1,
  ), true);

  const afterCompaction = await getOrCreatePersistedMutationAttemptForFingerprint({
    ...options,
    now: now + (32 * 24 * 60 * 60 * 1000),
  });
  assert.notEqual(afterCompaction.key, generation0.key);
  assert.match(afterCompaction.key, /^web-checkout:v2:[a-f0-9]{64}:1$/);
});

test('web chat attachment identity includes modification time and mobile asset identity', () => {
  const base = { actorId: 'u1', currency: 'PKR', text: 'Order this', attachments: [{ name: 'proof.jpg', type: 'image/jpeg', size: 512, lastModified: 100 }] };
  const modified = { ...base, attachments: [{ ...base.attachments[0], lastModified: 101 }] };
  const mobileA = { ...base, attachments: [{ name: 'proof.jpg', type: 'image/jpeg', size: 512, uri: 'file:///asset-a', assetId: 'a' }] };
  const mobileB = { ...base, attachments: [{ name: 'proof.jpg', type: 'image/jpeg', size: 512, uri: 'file:///asset-b', assetId: 'b' }] };

  assert.notEqual(createChatMutationFingerprint(base), createChatMutationFingerprint(modified));
  assert.notEqual(createChatMutationFingerprint(mobileA), createChatMutationFingerprint(mobileB));
});

test('web chat sends the selected currency for JSON and multipart requests', () => {
  const source = readFileSync(
    new URL('../src/components/common/ChatBot.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /requestBody\.append\('currency', requestCurrency\)/);
  assert.match(source, /JSON\.stringify\(\{[\s\S]*?currency: requestCurrency,/);
});

test('authenticated currency never inherits a guest device preference and fallback FX retries promptly', () => {
  const webContext = readFileSync(
    new URL('../src/contexts/CurrencyContext.jsx', import.meta.url),
    'utf8',
  );
  const mobileContext = readFileSync(
    new URL('../../MobileApp/src/contexts/CurrencyContext.js', import.meta.url),
    'utf8',
  );

  assert.match(webContext, /if \(hasToken && activeAccountId\)[\s\S]*?setCurrency\('USD'\);\s*return;/);
  assert.match(mobileContext, /if \(hasToken && activeAccountId\)[\s\S]*?setCurrencyState\('USD'\);\s*return;/);
  assert.doesNotMatch(
    mobileContext,
    /accountCurrencyKey\(activeAccountId\),\s*deviceCurrency/,
  );
  for (const source of [webContext, mobileContext]) {
    assert.match(source, /lastLiveAt = res\.data\.fallback === false \? Date\.now\(\) : 0/);
    assert.match(source, /catch \(error\)[\s\S]*?lastLiveAt = 0/);
  }
});
