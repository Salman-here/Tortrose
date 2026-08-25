const mongoose = require('mongoose');

jest.mock('../../models/Order', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
}));

const Order = require('../../models/Order');
const {
  resolveStripeOrderForEvent,
  resolveStripeOrderForPaymentIntentRoute,
} = require('../../services/stripeOrderLookupService');

const orderId = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId().toString();

describe('Stripe order lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses immutable Mongo ownership before the public display order id', async () => {
    const exact = { _id: orderId, orderId: 'duplicate-public-id' };
    Order.findOne.mockResolvedValue(exact);

    await expect(resolveStripeOrderForEvent({
      stripeObject: {
        id: 'cs_exact',
        metadata: { mongoOrderId: orderId, orderId: 'duplicate-public-id' },
      },
      paymentFlow: 'checkout_session',
    })).resolves.toBe(exact);

    expect(Order.findOne).toHaveBeenCalledWith({
      _id: orderId,
      paymentMethod: 'stripe',
      paymentFlow: 'checkout_session',
    });
    expect(Order.find).not.toHaveBeenCalled();
  });

  test('an invalid or unknown Mongo ownership reference never falls back to orderId', async () => {
    await expect(resolveStripeOrderForEvent({
      stripeObject: {
        id: 'pi_bad_id',
        metadata: { mongoOrderId: 'not-an-object-id', orderId: 'shared' },
      },
      paymentFlow: 'payment_sheet',
    })).rejects.toMatchObject({ code: 'STRIPE_ORDER_REFERENCE_INVALID', statusCode: 400 });
    expect(Order.findOne).not.toHaveBeenCalled();
    expect(Order.find).not.toHaveBeenCalled();

    Order.findOne.mockResolvedValue(null);
    await expect(resolveStripeOrderForEvent({
      stripeObject: {
        id: 'pi_unknown_id',
        metadata: { mongoOrderId: orderId, orderId: 'shared' },
      },
      paymentFlow: 'payment_sheet',
    })).rejects.toMatchObject({ code: 'STRIPE_ORDER_NOT_FOUND', statusCode: 404 });
    expect(Order.find).not.toHaveBeenCalled();
  });

  test('legacy public ids are accepted only when owner-scoped lookup is unique', async () => {
    Order.findOne.mockResolvedValue(null);
    const limit = jest.fn().mockResolvedValue([{ _id: orderId }, { _id: new mongoose.Types.ObjectId() }]);
    Order.find.mockReturnValue({ limit });

    await expect(resolveStripeOrderForEvent({
      stripeObject: {
        id: 'cs_legacy',
        metadata: { orderId: 'shared', userId },
      },
      paymentFlow: 'checkout_session',
    })).rejects.toMatchObject({
      code: 'STRIPE_ORDER_REFERENCE_AMBIGUOUS',
      statusCode: 409,
    });
    expect(Order.find).toHaveBeenCalledWith({
      paymentMethod: 'stripe',
      paymentFlow: 'checkout_session',
      orderId: 'shared',
      user: userId,
    });
    expect(limit).toHaveBeenCalledWith(2);
  });

  test('legacy routing also fails closed instead of selecting the first duplicate', async () => {
    Order.findOne.mockResolvedValue(null);
    Order.find.mockReturnValue({
      limit: jest.fn().mockResolvedValue([{ paymentFlow: 'payment_sheet' }, { paymentFlow: 'checkout_session' }]),
    });

    await expect(resolveStripeOrderForPaymentIntentRoute({
      id: 'pi_legacy_duplicate',
      metadata: { orderId: 'shared', userId },
    })).rejects.toMatchObject({ code: 'STRIPE_ORDER_REFERENCE_AMBIGUOUS' });
  });
});
