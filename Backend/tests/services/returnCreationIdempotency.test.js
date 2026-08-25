const mongoose = require('mongoose');

jest.mock('../../config/stripe', () => ({ stripe: null, STRIPE_MODE: 'test' }));

const {
  __private: {
    normalizeReturnRequestKey,
    returnRequestStorageKey,
    normalizeReturnCreationInput,
    assertReturnReplayMatches,
  },
} = require('../../services/returnService');

const buyerId = new mongoose.Types.ObjectId();
const sellerId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const firstItem = new mongoose.Types.ObjectId();
const secondItem = new mongoose.Types.ObjectId();

const input = (overrides = {}) => ({
  orderId,
  buyerId,
  sellerId,
  items: [
    { orderItemId: firstItem, quantity: 1 },
    { orderItemId: secondItem, quantity: 2 },
  ],
  reasonCategory: 'damaged',
  reasonDetails: 'The parcel arrived with visible damage.',
  requestKey: 'return-attempt-00000001',
  ...overrides,
});

describe('return creation idempotency contract', () => {
  test.each([undefined, null, '', 'short', ' leading-space-key-0001', 'bad key with spaces 0001']) (
    'rejects a missing or unsafe transport key: %p',
    (requestKey) => {
      expect(() => normalizeReturnRequestKey(requestKey)).toThrow(expect.objectContaining({
        code: requestKey ? 'RETURN_IDEMPOTENCY_KEY_INVALID' : 'RETURN_IDEMPOTENCY_KEY_REQUIRED',
      }));
    },
  );

  test('hashes the entire raw key instead of truncating a shared prefix', () => {
    const prefix = 'x'.repeat(120);
    const left = returnRequestStorageKey(buyerId, `${prefix}-left-000000000000`);
    const right = returnRequestStorageKey(buyerId, `${prefix}-right-00000000000`);
    expect(left).not.toBe(right);
    expect(left).toMatch(new RegExp(`^return:v2:${buyerId}:[a-f0-9]{64}$`));
  });

  test('normalizes item ordering into one stable logical fingerprint', () => {
    const forward = normalizeReturnCreationInput(input());
    const reverse = normalizeReturnCreationInput(input({ items: [...input().items].reverse() }));
    expect(forward.requestKey).toBe(reverse.requestKey);
    expect(forward.requestFingerprint).toBe(reverse.requestFingerprint);
  });

  test.each([
    ['order', { orderId: new mongoose.Types.ObjectId() }],
    ['seller', { sellerId: new mongoose.Types.ObjectId() }],
    ['quantity', { items: [{ orderItemId: firstItem, quantity: 2 }, { orderItemId: secondItem, quantity: 2 }] }],
    ['reason category', { reasonCategory: 'defective' }],
    ['reason text', { reasonDetails: 'The product is damaged in a different location.' }],
  ])('binds a key to the exact %s payload', (_label, override) => {
    const original = normalizeReturnCreationInput(input());
    const changed = normalizeReturnCreationInput(input(override));
    expect(changed.requestKey).toBe(original.requestKey);
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
    expect(() => assertReturnReplayMatches({
      requestFingerprint: original.requestFingerprint,
      $locals: {},
    }, changed.requestFingerprint)).toThrow(expect.objectContaining({
      code: 'RETURN_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    }));
  });

  test('marks an exact replay without persisting transport-only state', () => {
    const prepared = normalizeReturnCreationInput(input());
    const existing = { requestFingerprint: prepared.requestFingerprint, $locals: {} };
    expect(assertReturnReplayMatches(existing, prepared.requestFingerprint)).toBe(existing);
    expect(existing.$locals.idempotencyReplay).toBe(true);
  });

  test('quarantines legacy keys without a payload fingerprint', () => {
    expect(() => assertReturnReplayMatches({ $locals: {} }, 'a'.repeat(64))).toThrow(
      expect.objectContaining({
        code: 'RETURN_IDEMPOTENCY_LEGACY_RECOVERY_REQUIRED',
        statusCode: 409,
      }),
    );
  });

  test('rejects duplicate items before any database mutation', () => {
    expect(() => normalizeReturnCreationInput(input({
      items: [
        { orderItemId: firstItem, quantity: 1 },
        { orderItemId: firstItem, quantity: 2 },
      ],
    }))).toThrow(expect.objectContaining({ code: 'RETURN_ITEMS_INVALID' }));
  });
});
