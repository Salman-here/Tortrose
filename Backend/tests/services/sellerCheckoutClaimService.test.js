const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SellerCheckoutClaim = require('../../models/SellerCheckoutClaim');
const {
  fingerprintCheckoutRequest,
  claimSellerCheckout,
  attachSellerCheckoutSession,
  releaseSellerCheckoutClaim,
} = require('../../services/sellerCheckoutClaimService');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await SellerCheckoutClaim.init();
}, 60000);

afterEach(async () => {
  await SellerCheckoutClaim.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('seller Checkout creation claims', () => {
  test('atomically grants only one live claim per seller and flow', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const fingerprint = fingerprintCheckoutRequest({ plan: 'starter', checkoutClient: 'mobile' });

    const results = await Promise.all(Array.from({ length: 8 }, () => (
      claimSellerCheckout({ sellerId, flow: 'subscription', requestFingerprint: fingerprint })
    )));

    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(results.filter(result => !result.acquired)).toHaveLength(7);
    await expect(SellerCheckoutClaim.countDocuments({ seller: sellerId, flow: 'subscription' })).resolves.toBe(1);
  });

  test('reuses the attached session for an identical retry and permits a new claim after release', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const fingerprint = fingerprintCheckoutRequest({ storeId: 'store-1', slug: 'example' });
    const first = await claimSellerCheckout({ sellerId, flow: 'subdomain', requestFingerprint: fingerprint });

    await attachSellerCheckoutSession({
      sellerId,
      flow: 'subdomain',
      token: first.claim.token,
      sessionId: 'cs_attached',
      sessionUrl: 'https://checkout.stripe.test/cs_attached',
    });
    const retry = await claimSellerCheckout({ sellerId, flow: 'subdomain', requestFingerprint: fingerprint });

    expect(retry.acquired).toBe(false);
    expect(retry.claim).toMatchObject({
      requestFingerprint: fingerprint,
      sessionId: 'cs_attached',
      sessionUrl: 'https://checkout.stripe.test/cs_attached',
    });

    await releaseSellerCheckoutClaim({
      sellerId,
      flow: 'subdomain',
      token: first.claim.token,
      sessionId: 'cs_attached',
    });
    const next = await claimSellerCheckout({ sellerId, flow: 'subdomain', requestFingerprint: fingerprint });
    expect(next.acquired).toBe(true);
    expect(next.claim.token).not.toBe(first.claim.token);
  });

  test('reclaims an expired lease even before the TTL monitor deletes it', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const fingerprint = fingerprintCheckoutRequest({ plan: 'elite' });
    const first = await claimSellerCheckout({ sellerId, flow: 'subscription', requestFingerprint: fingerprint });
    await SellerCheckoutClaim.updateOne(
      { _id: first.claim._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const reclaimed = await claimSellerCheckout({ sellerId, flow: 'subscription', requestFingerprint: fingerprint });
    expect(reclaimed.acquired).toBe(true);
    expect(reclaimed.claim.token).not.toBe(first.claim.token);
  });

  test('fingerprints are stable across object key order', () => {
    expect(fingerprintCheckoutRequest({ b: 2, a: { y: 2, x: 1 } })).toBe(
      fingerprintCheckoutRequest({ a: { x: 1, y: 2 }, b: 2 }),
    );
  });
});
