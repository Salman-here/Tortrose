'use strict';

const { stripe, STRIPE_MODE } = require('../config/stripe');
const {
  getStripeOrderChargeAmountMinor,
  toStripeMinorUnits,
} = require('./stripeOrderPaymentService');
const {
  buildCustomerInitiatedPaymentIntentParams,
  isStripeIdempotentReplayWithinAuthorityWindow,
} = require('./stripePaymentIntentFactory');
const { getOrderItemLineSubtotal } = require('./orderLinePricingService');

const MAX_CHECKOUT_LINE_ITEMS = 100;

const setupError = (message, code = 'PAYMENT_SETUP_INVALID', statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const requireOrderStripeMode = order => {
  const mode = order?.stripeMode;
  if (!['test', 'live'].includes(mode) || mode !== STRIPE_MODE) {
    throw setupError(
      'The order Stripe environment snapshot is invalid.',
      'PAYMENT_MODE_MISMATCH',
    );
  }
  return mode;
};

const requireOrderClientSurface = order => {
  const surface = order?.clientSurface;
  if (!['web', 'mobile'].includes(surface)) {
    throw setupError('The order payment client surface is invalid.');
  }
  return surface;
};

const requireOrderCustomer = order => {
  const customerId = order?.stripeCustomerId;
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw setupError('The order payment customer snapshot is missing.');
  }
  return customerId;
};

const requirePaymentExpiryUnix = order => {
  const expiry = order?.paymentExpiresAt;
  if (!(expiry instanceof Date) || !Number.isFinite(expiry.getTime())) {
    throw setupError('The order payment expiry snapshot is invalid.');
  }
  const unix = Math.floor(expiry.getTime() / 1000);
  if (!Number.isSafeInteger(unix) || unix <= 0) {
    throw setupError('The order payment expiry snapshot is invalid.');
  }
  return unix;
};

const requireSafeStripeCreateWindow = order => {
  if (order?.paymentSetupState !== 'creating') return;
  if (!isStripeIdempotentReplayWithinAuthorityWindow({
    createdAt: order.paymentSetupStartedAt,
  })) {
    throw setupError(
      'This Stripe setup is too old for safe automatic replay and requires provider reconciliation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      503,
    );
  }
};

const buildOrderCheckoutReturnUrls = order => {
  const isMobile = requireOrderClientSurface(order) === 'mobile';
  const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
  return {
    successUrl: isMobile
      ? `rozare://payment-success?session_id={CHECKOUT_SESSION_ID}&orderId=${order.orderId}`
      : `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}&orderId=${order.orderId}`,
    cancelUrl: isMobile
      ? `rozare://payment-cancel?orderId=${order.orderId}`
      : `${frontendUrl}/checkout`,
  };
};

const requireOrderCheckoutReturnUrls = order => {
  const successUrl = order?.stripeCheckoutSuccessUrl;
  const cancelUrl = order?.stripeCheckoutCancelUrl;
  if (typeof successUrl === 'string' && successUrl && typeof cancelUrl === 'string' && cancelUrl) {
    return { successUrl, cancelUrl };
  }
  // A create already in flight must never rebuild mutable parameters. Orders
  // created before URL snapshots require provider reconciliation instead.
  if (order?.paymentSetupState === 'creating') {
    throw setupError(
      'This hosted Stripe setup is missing immutable return URLs and requires provider reconciliation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
      503,
    );
  }
  return buildOrderCheckoutReturnUrls(order);
};

const createNativeOrderPaymentIntent = order => {
  requireSafeStripeCreateWindow(order);
  const expectedAmountMinor = getStripeOrderChargeAmountMinor(order);
  const stripeMode = requireOrderStripeMode(order);
  const customerId = requireOrderCustomer(order);
  requireOrderClientSurface(order);
  return stripe.paymentIntents.create(
    buildCustomerInitiatedPaymentIntentParams({
      amountMinor: expectedAmountMinor,
      currency: order.currency,
      customerId,
      receiptEmail: order.shippingInfo?.email,
      metadata: {
        type: 'order_payment',
        paymentFlow: 'payment_sheet',
        orderId: order.orderId,
        mongoOrderId: String(order._id),
        userId: String(order.user || ''),
        amountMinor: String(expectedAmountMinor),
        currency: order.currency,
        stripeMode,
        tiktokPurchaseEventId: order.tracking?.tiktokPurchaseEventId || '',
      },
    }),
    { idempotencyKey: `rozare-order-pi:${stripeMode}:${order._id}` },
  );
};

const hostedOrderLineItems = order => {
  // Reconcile the complete stored order before reading any individual value
  // for Stripe presentation. This prevents a truthy/falsey display branch
  // from hiding a malformed persisted quantity, tax, or discount.
  getStripeOrderChargeAmountMinor(order);
  const currency = order.currency.toLowerCase();
  const productLineItems = (order.orderItems || []).map(item => ({
      price_data: {
        currency,
        product_data: {
          name: `${item.name} x${item.quantity}`,
          images: item.image ? [item.image] : undefined,
        },
        // Stripe only accepts whole minor units. The authoritative converted
        // line total is therefore one Checkout line, rather than a rounded
        // converted unit amount multiplied by quantity.
        unit_amount: toStripeMinorUnits(getOrderItemLineSubtotal(item), order.currency),
      },
      quantity: 1,
    })).filter(line => line.price_data.unit_amount > 0);
  const componentLineItems = [
    ...(order.orderSummary.shippingCost > 0 ? [{
      price_data: {
        currency,
        product_data: {
          name: (order.sellerShipping || []).length > 1
            ? `Shipping (${order.sellerShipping.length} sellers)`
            : `${order.shippingMethod.name} Shipping`,
        },
        unit_amount: toStripeMinorUnits(order.orderSummary.shippingCost, order.currency),
      },
      quantity: 1,
    }] : []),
    ...(order.orderSummary.tax > 0 ? [{
      price_data: {
        currency,
        product_data: { name: 'Tax' },
        unit_amount: toStripeMinorUnits(order.orderSummary.tax, order.currency),
      },
      quantity: 1,
    }] : []),
  ];
  if (productLineItems.length + componentLineItems.length <= MAX_CHECKOUT_LINE_ITEMS) {
    return [...productLineItems, ...componentLineItems];
  }

  // Stripe payment-mode Checkout Sessions accept at most 100 line items.
  // Consolidating only the receipt presentation preserves the exact stored
  // order subtotal, coupon, shipping, tax, and seller allocations.
  const subtotalMinor = toStripeMinorUnits(order.orderSummary.subtotal, order.currency);
  const consolidatedProducts = subtotalMinor > 0 ? [{
    price_data: {
      currency,
      product_data: {
        name: `Order items (${(order.orderItems || []).length} lines)`,
      },
      unit_amount: subtotalMinor,
    },
    quantity: 1,
  }] : [];
  const consolidated = [...consolidatedProducts, ...componentLineItems];
  if (!consolidated.length || consolidated.length > MAX_CHECKOUT_LINE_ITEMS) {
    throw setupError('The order cannot be represented safely in Stripe Checkout.');
  }
  return consolidated;
};

const createHostedOrderCheckoutSession = async order => {
  requireSafeStripeCreateWindow(order);
  const expectedAmountMinor = getStripeOrderChargeAmountMinor(order);
  const stripeMode = requireOrderStripeMode(order);
  const customerId = requireOrderCustomer(order);
  const clientSurface = requireOrderClientSurface(order);
  const expiresAt = requirePaymentExpiryUnix(order);
  const stripeCurrency = order.currency.toLowerCase();
  const metadata = {
    type: 'order_payment',
    paymentFlow: 'checkout_session',
    orderId: order.orderId,
    mongoOrderId: String(order._id),
    userId: String(order.user || ''),
    amountMinor: String(expectedAmountMinor),
    currency: order.currency,
    stripeMode,
    tiktokPurchaseEventId: order.tracking?.tiktokPurchaseEventId || '',
  };
  let discounts;
  const discountAmount = order.orderSummary.couponDiscount;
  if (discountAmount > 0) {
    const amountOff = toStripeMinorUnits(discountAmount, order.currency);
    if (amountOff > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: amountOff,
        currency: stripeCurrency,
        duration: 'once',
        name: 'Coupon discount',
      }, {
        idempotencyKey: `rozare-order-coupon:${stripeMode}:${order._id}`,
      });
      discounts = [{ coupon: coupon.id }];
    }
  }
  const isMobile = clientSurface === 'mobile';
  const { successUrl, cancelUrl } = requireOrderCheckoutReturnUrls(order);
  return stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer: customerId,
    saved_payment_method_options: {
      payment_method_save: 'enabled',
      payment_method_remove: 'disabled',
    },
    ...(isMobile ? { origin_context: 'mobile_app' } : {}),
    // Checkout Session metadata is not copied to the PaymentIntent/Charge.
    // Put the same immutable ownership snapshot on the PaymentIntent so an
    // out-of-order refund/dispute webhook can still be classified and retried
    // safely before the completion webhook attaches its local reference.
    payment_intent_data: { metadata },
    line_items: hostedOrderLineItems(order),
    ...(discounts ? { discounts } : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: expiresAt,
    metadata,
  }, {
    idempotencyKey: `rozare-order-checkout:${stripeMode}:${order._id}`,
  });
};

module.exports = {
  buildOrderCheckoutReturnUrls,
  createHostedOrderCheckoutSession,
  createNativeOrderPaymentIntent,
  hostedOrderLineItems,
};
