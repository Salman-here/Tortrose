'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Operation = require('../../models/SafepayBillingOperation');
const Payment = require('../../models/SafepayPayment');
const { proratedPlanChange } = require('../../services/safepayBillingMath');
const { metaFundingAllowance, capMetaCredit, currentMetaFunding, verifyMetaCreditQuote } = require('../../services/safepayMetaCreditService');
let replica;
const start = new Date('2026-10-08T03:53:39Z'), end = new Date('2026-11-08T03:53:39Z');
const addition = () => ({ kind: 'upgrade', terms: { plan: 'elite', includeMetaAds: true, sourcePlan: 'elite', sourceMetaAds: false,
  sourceMonthlyMinor: 2165, monthlyMinor: 2565, trialDays: 0, grossMinor: 399, dueMinor: 399, appliedCreditMinor: 0,
  proration: proratedPlanChange({ sourceMinor: 2165, targetMinor: 2565, periodStart: start, periodEnd: end, at: '2026-10-08T04:43:02Z' }) } });
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri()); await Promise.all([Operation.init(), Payment.init()]); }, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
afterEach(async () => { await Operation.deleteMany({}); await Payment.deleteMany({}); });

test('the observed $3.99 funded add-on can never mint a $4.00 removal credit at a later rounding boundary', () => {
  const source = addition(); expect(source.terms.proration.dueMinor).toBe(399);
  const raw = proratedPlanChange({ sourceMinor: 2565, targetMinor: 2165, periodStart: start, periodEnd: end, at: '2026-10-08T04:50:00Z' });
  expect(raw.creditMinor).toBe(400);
  const funding = { ...metaFundingAllowance(source), operationId: 'source-operation' };
  const result = capMetaCredit(raw, funding);
  expect(result.creditMinor).toBe(399); expect(result.metaCreditFunding.roundingCapMinor).toBe(1);
  expect(raw.creditMinor).toBe(400); // Do not mutate the original audit calculation.
});

test('a fully credit-funded add-on has real service value, but free introductory access does not create refund credit', () => {
  const source = addition(); source.terms.dueMinor = 0; source.terms.appliedCreditMinor = 399;
  expect(metaFundingAllowance(source).allowanceMinor).toBe(399);
  expect(metaFundingAllowance({ kind: 'enrollment', terms: { plan: 'elite', includeMetaAds: true, metaAddonMinor: 400,
    monthlyMinor: 2565, grossMinor: 0, dueMinor: 0, appliedCreditMinor: 0, trialDays: 45 } }).allowanceMinor).toBe(0);
  expect(capMetaCredit({ creditMinor: 1 }, { operationId: 'tiny', addonMonthlyMinor: 400, allowanceMinor: 0 }).creditMinor).toBe(0);
});

test('full-month Meta funding is bounded by its frozen original add-on rate, including founder-priced plans', () => {
  for (const monthlyMinor of [1699, 2565]) expect(metaFundingAllowance({ kind: 'renewal', terms: {
    plan: 'elite', includeMetaAds: true, metaAddonMinor: 400, monthlyMinor, grossMinor: monthlyMinor,
    dueMinor: monthlyMinor, appliedCreditMinor: 0, trialDays: 0 } }).allowanceMinor).toBe(400);
});

test.each(['399', -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid funded money %s is rejected instead of guessed', value => {
  const source = addition(); source.terms.grossMinor = value;
  expect(() => metaFundingAllowance(source)).toThrow();
});

async function fixture() {
  const seller = new mongoose.Types.ObjectId(), subscription = new mongoose.Types.ObjectId(), contractId = String(new mongoose.Types.ObjectId());
  const raw = addition(); raw.terms.sourceContractId = contractId;
  const op = await Operation.create({ ...raw, seller, subscription, environment: 'sandbox', status: 'applied',
    requestKey: 'meta-credit-funded-fixture', fingerprint: 'a'.repeat(64), sourceVersion: 1,
    acceptedAt: new Date('2026-10-08T04:45:34Z'), appliedAt: new Date('2026-10-08T04:45:39Z') });
  const payment = await Payment.create({ user: seller, environment: 'sandbox', purpose: 'subscription',
    reference: `billing:${op._id}`, requestKey: 'meta-credit-funded-payment', fingerprint: 'b'.repeat(64),
    amountMinor: 399, currency: 'USD', status: 'paid', capturedMinor: 399, paidAt: new Date(), appliedAt: new Date(),
    terms: { billingOperationId: String(op._id) } });
  op.payment = payment._id; await op.save();
  return { op, payment, sub: { _id: subscription, seller, currentPeriodStart: start,
    safepayBilling: { contractId, monthlyMinor: 2565 } } };
}

test('credit proof binds the original owner, contract, period, currency and unreversed payment', async () => {
  const f = await fixture();
  expect(await currentMetaFunding(f.sub, 'sandbox')).toMatchObject({ allowanceMinor: 399, operationId: String(f.op._id) });
  await expect(currentMetaFunding({ ...f.sub, seller: new mongoose.Types.ObjectId() }, 'sandbox')).rejects.toThrow();
  await expect(currentMetaFunding(f.sub, 'production')).rejects.toThrow();
  await expect(currentMetaFunding({ ...f.sub, currentPeriodStart: new Date('2026-09-08') }, 'sandbox')).rejects.toThrow();
  await Payment.updateOne({ _id: f.payment._id }, { $set: { refundedMinor: 1 } });
  await expect(currentMetaFunding(f.sub, 'sandbox')).rejects.toThrow();
});

test('acceptance rechecks funded proof and rejects a tampered or more generous credit', async () => {
  const f = await fixture(), funding = await currentMetaFunding(f.sub, 'sandbox');
  const p = capMetaCredit(proratedPlanChange({ sourceMinor: 2565, targetMinor: 2165,
    periodStart: start, periodEnd: end, at: '2026-10-08T04:50:00Z' }), funding);
  const quote = { kind: 'meta_removal', terms: { sourceMonthlyMinor: 2565, monthlyMinor: 2165, creditMinor: 399, proration: p } };
  await expect(verifyMetaCreditQuote(quote, f.sub, 'sandbox', null)).resolves.toBeUndefined();
  quote.terms.creditMinor = 400;
  await expect(verifyMetaCreditQuote(quote, f.sub, 'sandbox', null)).rejects.toThrow();
});
