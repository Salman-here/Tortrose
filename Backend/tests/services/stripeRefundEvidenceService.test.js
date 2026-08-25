'use strict';

const {
  STRIPE_REFUND_PAGE_SIZE,
  hydrateStripeChargeRefundEvidence,
} = require('../../services/stripeRefundEvidenceService');

const refund = ({ id, amount, status = 'succeeded' }) => ({
  id,
  amount,
  status,
  currency: 'usd',
  charge: 'ch_refund_hydration',
  payment_intent: 'pi_refund_hydration',
  created: 1787620000,
});

const charge = overrides => ({
  id: 'ch_refund_hydration',
  amount: 10000,
  amount_refunded: 3000,
  currency: 'usd',
  payment_intent: 'pi_refund_hydration',
  refunds: { object: 'list', data: [], has_more: true },
  ...overrides,
});

describe('Stripe Charge Refund evidence hydration', () => {
  test('keeps an already complete signed Refund list without a provider call', async () => {
    const complete = charge({
      refunds: {
        object: 'list',
        data: [refund({ id: 're_complete', amount: 3000 })],
        has_more: false,
      },
    });
    const stripe = { refunds: { list: jest.fn() } };
    await expect(hydrateStripeChargeRefundEvidence({
      stripe,
      charge: complete,
      eventCreatedAt: 1787620100,
    })).resolves.toBe(complete);
    expect(stripe.refunds.list).not.toHaveBeenCalled();
  });

  test('fails closed when a complete embedded list does not exactly match the signed snapshot', async () => {
    const embeddedMismatch = charge({
      refunds: {
        object: 'list',
        data: [refund({ id: 're_embedded_mismatch', amount: 2999 })],
        has_more: false,
      },
    });
    await expect(hydrateStripeChargeRefundEvidence({
      stripe: { refunds: { list: jest.fn() } },
      charge: embeddedMismatch,
      eventCreatedAt: 1787620100,
    })).rejects.toMatchObject({
      code: 'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
      statusCode: 503,
    });
  });

  test('paginates every Refund through the signed event cutoff and freezes an exact complete list', async () => {
    const pages = [
      {
        data: [
          refund({ id: 're_newest', amount: 1000 }),
          refund({ id: 're_pending', amount: 9000, status: 'pending' }),
        ],
        has_more: true,
      },
      { data: [refund({ id: 're_oldest', amount: 2000 })], has_more: false },
    ];
    const stripe = { refunds: { list: jest.fn().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]) } };
    const hydrated = await hydrateStripeChargeRefundEvidence({
      stripe,
      charge: charge(),
      eventCreatedAt: 1787620100,
    });

    expect(stripe.refunds.list).toHaveBeenNthCalledWith(1, {
      charge: 'ch_refund_hydration',
      created: { lte: 1787620100 },
      limit: STRIPE_REFUND_PAGE_SIZE,
    });
    expect(stripe.refunds.list).toHaveBeenNthCalledWith(2, {
      charge: 'ch_refund_hydration',
      created: { lte: 1787620100 },
      limit: STRIPE_REFUND_PAGE_SIZE,
      starting_after: 're_pending',
    });
    expect(hydrated.refunds).toEqual({
      object: 'list',
      data: [...pages[0].data, ...pages[1].data],
      has_more: false,
    });
  });

  test('hydrates when the Charge omitted its embedded Refund list', async () => {
    const stripe = {
      refunds: {
        list: jest.fn().mockResolvedValue({
          data: [refund({ id: 're_missing_embedded', amount: 3000 })],
          has_more: false,
        }),
      },
    };
    const hydrated = await hydrateStripeChargeRefundEvidence({
      stripe,
      charge: charge({ refunds: undefined }),
      eventCreatedAt: 1787620100,
    });
    expect(hydrated.refunds.data.map(entry => entry.id)).toEqual(['re_missing_embedded']);
  });

  test.each([
    {
      label: 'malformed page',
      page: { data: null, has_more: false },
      code: 'STRIPE_REFUND_EVIDENCE_PAGE_INVALID',
    },
    {
      label: 'stalled page',
      page: { data: [], has_more: true },
      code: 'STRIPE_REFUND_EVIDENCE_PAGINATION_STALLED',
    },
    {
      label: 'provider total below the signed snapshot',
      page: { data: [refund({ id: 're_too_small', amount: 2999 })], has_more: false },
      code: 'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
    },
    {
      label: 'provider total above the signed snapshot',
      page: { data: [refund({ id: 're_too_large', amount: 3001 })], has_more: false },
      code: 'STRIPE_REFUND_EVIDENCE_SNAPSHOT_MISMATCH',
    },
  ])('fails closed on $label', async ({ page, code }) => {
    const stripe = { refunds: { list: jest.fn().mockResolvedValue(page) } };
    await expect(hydrateStripeChargeRefundEvidence({
      stripe,
      charge: charge(),
      eventCreatedAt: 1787620100,
    })).rejects.toMatchObject({ code, statusCode: 503 });
  });

  test('rejects duplicate Refund ids across provider pages', async () => {
    const stripe = {
      refunds: {
        list: jest.fn()
          .mockResolvedValueOnce({ data: [refund({ id: 're_duplicate', amount: 1000 })], has_more: true })
          .mockResolvedValueOnce({ data: [refund({ id: 're_duplicate', amount: 2000 })], has_more: false }),
      },
    };
    await expect(hydrateStripeChargeRefundEvidence({
      stripe,
      charge: charge(),
      eventCreatedAt: 1787620100,
    })).rejects.toMatchObject({ code: 'STRIPE_REFUND_EVIDENCE_PAGE_INVALID', statusCode: 503 });
  });

  test('fails closed when authoritative evidence exceeds its bounded object limit', async () => {
    const stripe = {
      refunds: {
        list: jest.fn().mockResolvedValue({
          data: [
            refund({ id: 're_limit_one', amount: 1000 }),
            refund({ id: 're_limit_two', amount: 2000 }),
          ],
          has_more: false,
        }),
      },
    };
    await expect(hydrateStripeChargeRefundEvidence({
      stripe,
      charge: charge(),
      eventCreatedAt: 1787620100,
      maxRefunds: 1,
    })).rejects.toMatchObject({ code: 'STRIPE_REFUND_EVIDENCE_LIMIT_EXCEEDED', statusCode: 503 });
  });

  test.each([
    ['incomplete provider list', charge()],
    ['complete embedded list', charge({
      refunds: {
        object: 'list',
        data: [refund({ id: 're_complete_invalid_time', amount: 3000 })],
        has_more: false,
      },
    })],
  ])('requires an authoritative event timestamp for an $label', async (_label, refundCharge) => {
    await expect(hydrateStripeChargeRefundEvidence({
      stripe: { refunds: { list: jest.fn() } },
      charge: refundCharge,
      eventCreatedAt: null,
    })).rejects.toMatchObject({ code: 'STRIPE_REFUND_EVIDENCE_EVENT_TIME_INVALID', statusCode: 503 });
  });

  test('fails closed when a refund event has no positive safe cumulative snapshot', async () => {
    const zero = charge({ amount_refunded: 0, refunds: undefined });
    const stripe = { refunds: { list: jest.fn() } };
    await expect(hydrateStripeChargeRefundEvidence({
      stripe,
      charge: zero,
      eventCreatedAt: 1787620100,
    })).rejects.toMatchObject({
      code: 'STRIPE_REFUND_EVIDENCE_SNAPSHOT_INVALID',
      statusCode: 503,
    });
    expect(stripe.refunds.list).not.toHaveBeenCalled();
  });
});
