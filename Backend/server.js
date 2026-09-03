const dotenv = require('dotenv')
dotenv.config()

const cors = require('cors')
const rateLimit = require('express-rate-limit')
const express = require('express')
const app = express()
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))
const {
  createWhatsAppWebhookIngress,
  resolveWhatsAppWebhookSecrets,
} = require('./services/whatsapp/webhookSecurity')
const whatsappWebhookSecretConfig = resolveWhatsAppWebhookSecrets()
if (!whatsappWebhookSecretConfig.configured) {
  console.error('❌ WHATSAPP_WEBHOOK_SECRET is not configured; Evolution webhooks will be rejected')
} else if (whatsappWebhookSecretConfig.usingLegacyFallback) {
  console.warn('⚠️  Using legacy EVOLUTION_WEBHOOK_SECRET; migrate it to WHATSAPP_WEBHOOK_SECRET')
} else if (whatsappWebhookSecretConfig.rotatingFromLegacy) {
  console.warn('⚠️  WhatsApp webhook secret migration active; both canonical and legacy values are temporarily accepted')
}

// ── Stripe Configuration with Live/Test Mode Support ──
const { stripe, STRIPE_MODE, STRIPE_WEBHOOK_SECRET } = require('./config/stripe');

if (stripe) {
  console.log(`✅ Stripe initialized in ${STRIPE_MODE.toUpperCase()} mode`);
} else {
  console.warn('⚠️  Stripe not configured - payment features disabled');
}

const mongoose = require('mongoose')
const Order = require('./models/Order')
const { trackOrderEvent } = require('./services/tiktokEventsApi')
const { deleteUnpaidOrderAndReleaseCoupons } = require('./services/couponUsageService')
const { resolveStripeOrderForEvent } = require('./services/stripeOrderLookupService')
const { trustedRequestIp } = require('./services/requestIdentityService')
const {
  enqueuePaidOrderBuyerNotifications,
  enqueuePaidOrderSellerNotifications,
} = require('./services/financialNotificationOutboxService')
const {
  fulfillStripeOrder,
  fulfillStripeOrderPaymentIntent,
  recordStripeOrderPaymentFailure,
  attachStripeOrderReference,
} = require('./services/stripeOrderPaymentService')


// ── Stripe Webhook (raw body required — must come before express.json) ──
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) {
    console.error("❌ Stripe not configured");
    return res.sendStatus(500);
  }
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.sendStatus(400);
  }

  // Handle subscription webhook events
  const { handleWebhook: handleSubscriptionWebhook } = require('./controllers/subscriptionController');
  const { routesToSubscriptionWebhook } = require('./services/subscriptionWebhookRoutingService');
  if (routesToSubscriptionWebhook(event.type)) {
    try {
      await handleSubscriptionWebhook(event);
    } catch (subscriptionWebhookError) {
      console.error('❌ Subscription webhook processing failed:', subscriptionWebhookError.message);
      return res.sendStatus(500);
    }
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    let session = event.data.object;
    const isPaymentIntentEvent = event.type === 'payment_intent.succeeded';
    if (isPaymentIntentEvent) {
      try {
        const {
          resolvePaymentIntentLifecycleRoute,
        } = require('./services/stripePaymentIntentEventRoutingService');
        const routing = await resolvePaymentIntentLifecycleRoute(session);
        if (routing.route === 'hosted_checkout') return res.sendStatus(200);
        if (routing.route === 'ambiguous') {
          console.error('[stripe] PaymentIntent success routing is ambiguous:', routing.reason);
          return res.sendStatus(500);
        }
        session = routing.paymentIntent || session;
      } catch (routingError) {
        console.error('[stripe] PaymentIntent success routing failed:', routingError.message);
        return res.sendStatus(500);
      }
    }

    // Skip subscription checkouts (handled above)
    if (!isPaymentIntentEvent && session.mode === 'subscription') {
      return res.sendStatus(200);
    }

    // Skip subdomain purchases (handled above in handleSubscriptionWebhook)
    if (session.metadata?.type === 'subdomain_purchase') {
      return res.sendStatus(200);
    }

    if (session.metadata?.type === 'wallet_top_up') {
      try {
        const {
          completeWalletTopUp,
          completeWalletTopUpFromPaymentIntent,
        } = require('./services/walletService');
        const { notifyTopUpCompleted } = require('./controllers/walletController');
        const transaction = isPaymentIntentEvent
          ? await completeWalletTopUpFromPaymentIntent(session, event.id)
          : await completeWalletTopUp(session, event.id);
        await notifyTopUpCompleted(transaction);
        console.log(`[wallet] completed top-up ${transaction?._id || session.id}`);
        return res.sendStatus(200);
      } catch (walletError) {
        console.error('[wallet] top-up webhook failed:', walletError.message);
        if (walletError?.code === 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION') {
          // A refund/dispute webhook won the completion race. The risk marker is
          // durable and the local top-up was closed without credit, so retrying
          // this success webhook can never make progress and must be acknowledged.
          return res.sendStatus(200);
        }
        return res.sendStatus(500);
      }
    }

    // PaymentIntents from subscriptions and unrelated Stripe integrations are
    // handled by their own event types/controllers. Never treat them as orders.
    if (isPaymentIntentEvent && session.metadata?.type !== 'order_payment') {
      return res.sendStatus(200);
    }

    if (!isPaymentIntentEvent && session.metadata?.type === 'return_settlement') {
      try {
        const { completeReturnCardSettlement } = require('./services/returnService');
        const { notifyReturnSettlementCompleted } = require('./services/returnNotificationService');
        const returnRequest = await completeReturnCardSettlement(session);
        const returnOrder = returnRequest ? await Order.findById(returnRequest.order).lean() : null;
        if (returnRequest?.settlement?.status === 'completed') {
          await notifyReturnSettlementCompleted(returnRequest, returnOrder);
        }
        console.log(`[returns] completed card settlement ${returnRequest?._id || session.id}`);
        return res.sendStatus(200);
      } catch (returnError) {
        console.error('[returns] settlement webhook failed:', returnError.message);
        return res.sendStatus(500);
      }
    }

    console.log("✅ Payment succeeded!");
    console.log("Session ID:", session.id);
    console.log("Order ID (metadata):", session.metadata?.orderId);

    let order;
    try {
      order = await resolveStripeOrderForEvent({
        stripeObject: session,
        paymentFlow: isPaymentIntentEvent ? 'payment_sheet' : 'checkout_session',
      });
    } catch (lookupError) {
      console.error('[stripe] order lookup rejected:', lookupError.code || lookupError.message);
      return res.sendStatus(lookupError.statusCode >= 500 ? 500 : 400);
    }

    let fulfillmentResult;
    try {
      order = await attachStripeOrderReference({
        order,
        stripeObject: session,
        paymentFlow: isPaymentIntentEvent ? 'payment_sheet' : 'checkout_session',
      });
      fulfillmentResult = isPaymentIntentEvent
        ? await fulfillStripeOrderPaymentIntent({
          order,
          paymentIntent: session,
          eventId: event.id,
        })
        : await fulfillStripeOrder({
          order,
          stripeSession: session,
          eventId: event.id,
        });
    } catch (paymentError) {
      console.error('[stripe] order fulfillment rejected:', paymentError.code || paymentError.message);
      return res.sendStatus(paymentError.statusCode >= 500 ? 500 : 400);
    }
    order = fulfillmentResult.order;
    const wasAwaiting = fulfillmentResult.newlyFulfilled;
    if (fulfillmentResult.paymentRefunded) {
      // Keep the buyer's cart intact: this order was never fulfillable and the
      // captured legacy payment has already been returned through Stripe.
      return res.sendStatus(200);
    }
    if (fulfillmentResult.paymentReversed) {
      // A refund/dispute webhook won the durable completion race. No buyer or
      // seller value was granted, so this signed success event is terminal.
      return res.sendStatus(200);
    }
    try {
      const { removeFulfilledOrderItemsFromCart } = require('./services/cartFulfillmentService');
      await removeFulfilledOrderItemsFromCart({
        userId: order.user,
        orderItems: order.orderItems,
        fulfillmentId: order._id,
      });
    } catch (cartCleanupError) {
      // The cleanup write is idempotent by order ID, so asking Stripe to retry
      // is safe even when the first database response was ambiguous.
      console.error('[cart] fulfilled-order cleanup failed:', cartCleanupError.message);
      return res.sendStatus(500);
    }

    // Enqueue the financial notifications on every successful webhook replay,
    // not only on the transition winner. If the process committed fulfillment
    // and then stopped before this point, Stripe's retry repairs the durable
    // outbox. Event keys make each recipient/channel enqueue idempotent.
    try {
      const settlementSellerIds = [...new Set((order.sellerSettlement || [])
        .map(entry => entry?.seller?.toString?.() || '')
        .filter(Boolean))];
      if (settlementSellerIds.length === 0) {
        const notificationError = new Error(
          'The paid order has no frozen seller settlement for notification routing.'
        );
        notificationError.code = 'PAID_ORDER_NOTIFICATION_SETTLEMENT_MISSING';
        throw notificationError;
      }
      await enqueuePaidOrderBuyerNotifications(order);
      for (const sellerId of settlementSellerIds) {
        await enqueuePaidOrderSellerNotifications(order, sellerId);
      }
    } catch (notificationError) {
      console.error(
        '[notification-outbox] paid-order enqueue failed:',
        notificationError.code || notificationError.message
      );
      return res.sendStatus(500);
    }

    if (!wasAwaiting) return res.sendStatus(200);

    if (order) {
      console.log("✅ Order updated & auto-confirmed:", order.orderId);

      trackOrderEvent({
        event: 'Purchase',
        req,
        order,
        eventId: order.tracking?.tiktokPurchaseEventId || session.metadata?.tiktokPurchaseEventId,
        tracking: order.tracking || {},
      }).catch(() => {});

    }
  }

  // ── Abandoned / failed Stripe checkout cleanup ──
  // When a buyer closes the Stripe page or the session expires, DELETE the
  // awaiting-payment order entirely. We never want unpaid orders to appear
  // in the buyer/seller dashboards (not even as "cancelled").
  if (event.type === 'payment_intent.payment_failed') {
    let paymentIntent = event.data.object;
    try {
      const {
        resolvePaymentIntentLifecycleRoute,
      } = require('./services/stripePaymentIntentEventRoutingService');
      const routing = await resolvePaymentIntentLifecycleRoute(paymentIntent);
      if (routing.route === 'hosted_checkout') return res.sendStatus(200);
      if (routing.route === 'ambiguous') {
        console.error('[stripe] PaymentIntent failure routing is ambiguous:', routing.reason);
        return res.sendStatus(500);
      }
      paymentIntent = routing.paymentIntent || paymentIntent;
      if (paymentIntent.metadata?.type === 'wallet_top_up') {
        const { recordWalletTopUpPaymentFailure } = require('./services/walletService');
        await recordWalletTopUpPaymentFailure(paymentIntent, event.id);
      } else if (paymentIntent.metadata?.type === 'order_payment') {
        let order = await resolveStripeOrderForEvent({
          stripeObject: paymentIntent,
          paymentFlow: 'payment_sheet',
        });
        order = await attachStripeOrderReference({
          order,
          stripeObject: paymentIntent,
          paymentFlow: 'payment_sheet',
        });
        await recordStripeOrderPaymentFailure({ order, paymentIntent });
      }
      return res.sendStatus(200);
    } catch (error) {
      console.error('[stripe] PaymentIntent failure processing failed:', error.message);
      return res.sendStatus(error.statusCode >= 500 ? 500 : 400);
    }
  }

  if (event.type === 'payment_intent.canceled') {
    let paymentIntent = event.data.object;
    try {
      const {
        resolvePaymentIntentLifecycleRoute,
      } = require('./services/stripePaymentIntentEventRoutingService');
      const routing = await resolvePaymentIntentLifecycleRoute(paymentIntent);
      if (routing.route === 'hosted_checkout') return res.sendStatus(200);
      if (routing.route === 'ambiguous') {
        console.error('[stripe] PaymentIntent cancellation routing is ambiguous:', routing.reason);
        return res.sendStatus(500);
      }
      paymentIntent = routing.paymentIntent || paymentIntent;
      if (paymentIntent.metadata?.type === 'wallet_top_up') {
        const { cancelWalletTopUpFromPaymentIntent } = require('./services/walletService');
        await cancelWalletTopUpFromPaymentIntent(paymentIntent, {
          eventId: event.id,
          status: 'cancelled',
          reason: 'Stripe confirmed that the Wallet top-up was cancelled.',
        });
      } else if (paymentIntent.metadata?.type === 'order_payment') {
        const { closeOrderPaymentIntent } = require('./services/stripePendingPaymentService');
        let order = await resolveStripeOrderForEvent({
          stripeObject: paymentIntent,
          paymentFlow: 'payment_sheet',
        });
        order = await attachStripeOrderReference({
          order,
          stripeObject: paymentIntent,
          paymentFlow: 'payment_sheet',
        });
        await closeOrderPaymentIntent(order, {
          status: 'cancelled',
          reason: 'Stripe confirmed that the payment was cancelled.',
        });
      }
      return res.sendStatus(200);
    } catch (error) {
      console.error('[stripe] PaymentIntent cancellation processing failed:', error.message);
      return res.sendStatus(error.statusCode >= 500 ? 500 : 400);
    }
  }

  if (event.type === 'setup_intent.succeeded') {
    try {
      if (event.data.object.metadata?.type !== 'saved_payment_method_setup') {
        return res.sendStatus(200);
      }
      const { finalizeSavedPaymentMethodSetup } = require('./services/stripeCustomerService');
      await finalizeSavedPaymentMethodSetup(event.data.object);
      return res.sendStatus(200);
    } catch (error) {
      console.error('[stripe] saved-card setup processing failed:', error.message);
      return res.sendStatus(error.statusCode >= 500 ? 500 : 400);
    }
  }

  if ([
    'charge.refunded',
    'charge.dispute.created',
    'charge.dispute.closed',
    'charge.dispute.funds_withdrawn',
    'charge.dispute.funds_reinstated',
  ].includes(event.type)) {
    let charge = event.data.object;
    try {
      if (event.type.startsWith('charge.dispute.') && charge.charge) {
        const dispute = charge;
        const chargeId = typeof charge.charge === 'string' ? charge.charge : charge.charge.id;
        const retrievedCharge = await stripe.charges.retrieve(chargeId);
        charge = {
          ...retrievedCharge,
          disputeId: dispute.id,
          disputeAmount: dispute.amount,
          disputeStatus: dispute.status,
        };
      }
      if (event.type === 'charge.refunded') {
        const {
          hydrateStripeChargeRefundEvidence,
        } = require('./services/stripeRefundEvidenceService');
        charge = await hydrateStripeChargeRefundEvidence({
          stripe,
          charge,
          eventCreatedAt: event.created,
        });
      }
      const { flagStripePaymentRisk } = require('./services/stripePaymentRiskService');
      await flagStripePaymentRisk({
        charge,
        eventId: event.id,
        eventType: event.type,
        eventCreatedAt: event.created,
      });
      return res.sendStatus(200);
    } catch (error) {
      // Acknowledge only after the affected Wallet lock or seller-balance
      // debit commits. Stripe retries signed events when accounting is down.
      console.error('[payments] Stripe refund/dispute accounting failed:', error.message);
      try {
        const {
          recordFailedStripePaymentRiskReview,
        } = require('./services/stripePaymentRiskService');
        await recordFailedStripePaymentRiskReview({
          charge,
          eventId: event.id,
          eventType: event.type,
          eventCreatedAt: event.created,
          error,
        });
      } catch (reviewError) {
        console.error('[payments] Failed to persist Stripe payment-risk manual review:', reviewError.message);
      }
      return res.sendStatus(500);
    }
  }

  if (
    event.type === 'checkout.session.expired' ||
    event.type === 'checkout.session.async_payment_failed'
  ) {
    const session = event.data.object;
    if (session.metadata?.type === 'wallet_top_up') {
      const { failWalletTopUp } = require('./services/walletService');
      try {
        await failWalletTopUp(session, 'Stripe checkout expired or failed.', event.id);
        return res.sendStatus(200);
      } catch (error) {
        // Returning 500 is intentional: Stripe must retry if the durable
        // reference attachment or local close transition did not commit.
        console.error('[wallet] failed to mark top-up failed:', error.message);
        return res.sendStatus(500);
      }
    }
    if (session.metadata?.type === 'return_settlement') {
      const { failReturnCardSettlement } = require('./services/returnService');
      try {
        const returnRequest = await failReturnCardSettlement(
          session,
          'The seller card payment expired or failed. The return is back under review.'
        );
        if (returnRequest) {
          const { notifyBuyerReturnStatus } = require('./services/returnNotificationService');
          const returnOrder = await Order.findById(returnRequest.order).lean();
          await notifyBuyerReturnStatus(
            returnRequest,
            returnOrder,
            'Seller refund funding was not completed. The seller can try again.'
          );
        }
      } catch (error) {
        console.error('[returns] failed to reset settlement:', error.message);
        return res.sendStatus(500);
      }
      return res.sendStatus(200);
    }
    if (session.mode === 'payment' && session.metadata?.orderId) {
      try {
        let order = await resolveStripeOrderForEvent({
          stripeObject: session,
          paymentFlow: 'checkout_session',
        });
        order = await attachStripeOrderReference({
          order,
          stripeObject: session,
          paymentFlow: 'checkout_session',
        });
        if (order && order.awaitingPayment && !order.isPaid) {
          await deleteUnpaidOrderAndReleaseCoupons({
            orderId: order._id,
            requireAwaitingPayment: true,
            reason: 'Stripe Checkout expired or failed before payment.',
          });
          console.log(`🗑️  Deleted abandoned/unpaid checkout order ${order.orderId}`);
        }
      } catch (cleanupErr) {
        console.error('Failed to delete abandoned order:', cleanupErr.message);
        // Do not acknowledge a failed lifecycle transition. Stripe retries
        // signed webhook deliveries, giving the atomic inventory/coupon cleanup
        // another chance instead of leaking a reservation permanently.
        return res.sendStatus(500);
      }
    }
  }

  res.sendStatus(200);
});


// ── CORS ──
const normalizeOrigin = (origin) => {
  if (!origin) return '';
  try {
    const parsed = new URL(String(origin).trim());
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch (_) {
    return String(origin || '').trim().replace(/\/+$/, '');
  }
};
const configuredOrigins = [
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
  process.env.FRONTEND_URLS,
  process.env.ALLOWED_ORIGINS,
]
  .filter(Boolean)
  .flatMap(value => String(value).split(','))
  .map(normalizeOrigin)
  .filter(Boolean);

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8081',
  'http://localhost:19006',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:19006',
  'https://www.rozare.com',
  'https://rozare.com',
  ...configuredOrigins,
].map(normalizeOrigin));

const allowedCorsHeaders = [
  'Accept',
  'accept',
  'Authorization',
  'authorization',
  'Content-Type',
  'content-type',
  'Origin',
  'origin',
  'X-Requested-With',
  'x-requested-with',
  'Idempotency-Key',
  'idempotency-key',
  'X-Idempotency-Key',
  'x-idempotency-key',
];

const isAllowedCorsOrigin = (origin) => {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.has(normalized)) return true;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const isRozareDomain = hostname === 'rozare.com' || hostname.endsWith('.rozare.com');
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

    if (parsed.protocol === 'https:' && isRozareDomain) return true;
    if (process.env.NODE_ENV !== 'production' && isLocalhost) return true;
  } catch (_) {
    // Fall through to the environment fallback below.
  }

  return process.env.NODE_ENV !== 'production';
};

const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin;
  if (!origin || !isAllowedCorsOrigin(origin)) return false;

  const requestedHeaders = req.headers['access-control-request-headers'];

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    requestedHeaders || allowedCorsHeaders.join(', ')
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, X-Content-Range');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers');

  return true;
};

const corsOptions = {
  origin: function (origin, callback) {
    return callback(null, isAllowedCorsOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: allowedCorsHeaders,
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
  optionsSuccessStatus: 204
};

// Apply CORS before rate limits and body parsing so preflight requests from
// store subdomains never get blocked before the browser sees the right headers.
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use(cors(corsOptions));

// Ensure CORS headers on ALL responses (including errors)
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  next();
});

// ── Rate Limiting ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { msg: 'Too many requests, please try again later.' },
  validate: false,
  keyGenerator: trustedRequestIp,
  handler: (req, res, _next, options) => {
    return res.status(options.statusCode).json(options.message);
  },
});

// ── Body Parsing ──
// The Evolution WhatsApp webhook carries inbound media inline as base64 (voice
// notes, product images, documents) when webhookBase64 is enabled, so its
// payloads can be several MB. Rate-limit and authenticate that route before any
// bytes are JSON-parsed, then apply its larger limit before the global parser.
// body-parser skips re-parsing once req._body is set, so the global parser below
// remains a no-op for this route and unchanged elsewhere.
app.use(
  '/api/whatsapp/webhook',
  ...createWhatsAppWebhookIngress({
    jsonParser: express.json({ limit: process.env.WHATSAPP_WEBHOOK_BODY_LIMIT || '30mb' }),
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Meta browser event relay does not require a database connection.
app.use('/api/meta', require('./routes/metaRoutes'));

// ── Database ──
const ConnectDB = require('./config/db');
const {
  isNotificationOutboxWorkerRunning,
  startNotificationOutboxWorker,
  stopNotificationOutboxWorker,
} = require('./services/notificationOutboxWorker');
const ensureNotificationOutboxWorkerStarted = () => {
  if (mongoose.connection.readyState !== 1) return false;
  const worker = startNotificationOutboxWorker();
  if (worker.started) {
    console.log(`[notification-outbox] worker started (${worker.workerId})`);
  }
  return isNotificationOutboxWorkerRunning();
};
const databaseReady = ConnectDB();
databaseReady
  .then(() => {
    if (mongoose.connection.readyState !== 1) {
      console.warn('[notification-outbox] worker not started because MongoDB is unavailable');
      return;
    }
    ensureNotificationOutboxWorkerStarted();
  })
  .catch(err => console.error('DB init error:', err.message));

// Middleware to ensure DB is connected before processing any API request
app.use('/api', async (req, res, next) => {
  try {
    await ConnectDB();
    ensureNotificationOutboxWorkerStarted();
    next();
  } catch (err) {
    console.error('DB middleware connection error:', err.message);
    return res.status(503).json({ msg: 'Database temporarily unavailable. Please retry.' });
  }
});

// ── Passport (Google OAuth) ──
const passport = require('passport');
require('./middleware/googleStreatgy');
app.use(passport.initialize());

// ── Route imports ──
const resetPasswordRoutes = require('./routes/resetPasswordRoutes');
const productRoutes = require('./routes/productRoutes');
const authRoutes = require('./routes/authRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const userRoutes = require('./routes/userRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const storeRoutes = require('./routes/storeRoutes');
const taxRoutes = require('./routes/taxRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const locationRoutes = require('./routes/locationRoutes');
const trustRoutes = require('./routes/trustRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const subdomainRoutes = require('./routes/subdomain');
const chatbotRoutes = require('./routes/chatbotRoutes');
const smartTagRoutes = require('./routes/smartTagRoutes');
const aiActionRoutes = require('./routes/aiActionRoutes');
const aiChatRoutes = require('./routes/aiChatRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const couponRoutes = require('./routes/couponRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const paymentMethodRoutes = require('./routes/paymentMethodRoutes');
const walletRoutes = require('./routes/walletRoutes');
const returnRoutes = require('./routes/returnRoutes');
const storeReviewRoutes = require('./routes/storeReviewRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const sellerWhatsappRoutes = require('./routes/sellerWhatsappRoutes');
const userWhatsappRoutes = require('./routes/userWhatsappRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const sellerAdRoutes = require('./routes/sellerAdRoutes');

// ── Routes ──
app.use('/api/products', productRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/password', authLimiter, resetPasswordRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/order-confirm', require('./routes/orderConfirmationRoutes'));
app.use('/api/user', userRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/stores', trustRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/tax', taxRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/currency', currencyRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/subdomain', subdomainRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/smart-tags', smartTagRoutes);
app.use('/api/ai-actions', aiActionRoutes);
app.use('/api/ai-chat', aiChatRoutes);
app.use('/api/safety', require('./routes/safetyRoutes'));
app.use('/api/ai-assist', require('./routes/aiAssistRoutes'));
app.use('/api/ai-prompts', require('./routes/aiPromptRoutes'));
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/payment-methods', paymentMethodRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/ads', sellerAdRoutes);
app.use('/api/store-reviews', storeReviewRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/seller-whatsapp', sellerWhatsappRoutes);
app.use('/api/user-whatsapp', userWhatsappRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/seo', require('./routes/seoRoutes'));

// ── Dynamic SEO sitemaps (products & stores) ──
app.use('/', require('./routes/sitemapRoutes'));

// ── Trial expiration (runs on persistent Heroku dyno) ──
const {
  processTrialExpirations,
  migrateHasUsedFreePeriod,
  migrateFounderPromotion,
} = require('./controllers/subscriptionController');
setInterval(processTrialExpirations, 60 * 60 * 1000); // every hour
setTimeout(processTrialExpirations, 30000); // 30s after boot

// ── One-time migration (runs on boot): mark existing paid sellers as hasUsedFreePeriod ──
setTimeout(migrateHasUsedFreePeriod, 15000); // 15s after boot
setTimeout(migrateFounderPromotion, 17000); // preserve existing subscriber pricing before new billing cycles

// Cancel and release stale native PaymentIntents so reserved stock and pending
// Wallet top-ups cannot remain open indefinitely after an app is closed.
if (stripe) {
  const { cleanupStaleStripePaymentIntents } = require('./services/stripePendingPaymentService');
  const {
    processPendingStripeSubscriptionCleanups,
  } = require('./services/stripeSubscriptionCleanupService');
  const runStripePaymentCleanup = () => cleanupStaleStripePaymentIntents()
    .catch(error => console.error('[stripe-cleanup] scheduled cleanup failed:', error.message));
  const cleanupTimer = setInterval(runStripePaymentCleanup, 5 * 60 * 1000);
  cleanupTimer.unref?.();
  const initialCleanupTimer = setTimeout(runStripePaymentCleanup, 45000);
  initialCleanupTimer.unref?.();

  const runStripeSubscriptionCleanup = () => processPendingStripeSubscriptionCleanups({ limit: 10 })
    .catch(error => console.error('[subscription-cleanup] scheduled recovery failed:', error.message));
  const subscriptionCleanupTimer = setInterval(runStripeSubscriptionCleanup, 5 * 60 * 1000);
  subscriptionCleanupTimer.unref?.();
  const initialSubscriptionCleanupTimer = setTimeout(runStripeSubscriptionCleanup, 55000);
  initialSubscriptionCleanupTimer.unref?.();
}

// ── Subdomain removal processor (runs every 6 hours) ──
const { processSubdomainRemovals } = require('./controllers/subdomainPurchaseController');
setInterval(processSubdomainRemovals, 6 * 60 * 60 * 1000); // every 6 hours
setTimeout(processSubdomainRemovals, 60000); // 60s after boot

// ── WhatsApp queue processor (Evolution API) ──
const { startQueueProcessor } = require('./services/whatsapp/queue');
startQueueProcessor();

// ── WhatsApp gateway health monitor (detects zombie Baileys sockets) ──
const { startGatewayHealthMonitor } = require('./services/whatsapp/gatewayHealthMonitor');
startGatewayHealthMonitor();

// Re-apply the signed Evolution webhook and inline-media settings on boot.
// Without this, voice notes can silently stop working after gateway changes
// until an administrator manually reconnects the instance.
const { registerConfiguredWebhooks } = require('./controllers/whatsappController');
const webhookRegistrationTimer = setTimeout(() => {
  registerConfiguredWebhooks().catch(err => {
    console.warn('[whatsapp] startup webhook registration failed:', err.message);
  });
}, 8000);
webhookRegistrationTimer.unref?.();

// ── Admin broadcast dispatcher (runs every minute on the persistent dyno) ──
const { processDueBroadcasts } = require('./controllers/notificationController');
setInterval(() => {
  processDueBroadcasts().catch(err => console.error('[broadcast] tick error:', err.message));
}, 60 * 1000);
setTimeout(() => processDueBroadcasts().catch(() => {}), 15000);

// ── Centralized error handler ──
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  if (res.headersSent) return next(err);
  setCorsHeaders(req, res);
  return res.status(err?.status || 500).json({ msg: err?.message || 'Internal Server Error' });
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    gitCommit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '',
    buildMarker: 'whatsapp-unified-gateway-v1',
    mongoConnected: mongoose.connection.readyState === 1,
    notificationOutboxWorkerStarted: isNotificationOutboxWorkerRunning(),
  });
});

// ── Root ──
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Rozare API is running',
    version: '1.0.0',
    endpoints: { health: '/health', products: '/api/products', auth: '/api/auth' }
  });
});

// ── Start server ──
const PORT = process.env.PORT || 5000;
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

if (require.main === module) {
  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining server and notification worker`);
    const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
    forceExitTimer.unref?.();
    try {
      await Promise.all([
        stopNotificationOutboxWorker(),
        new Promise(resolve => httpServer.close(resolve)),
      ]);
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close(false);
      }
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      console.error('[shutdown] graceful shutdown failed:', error.message);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
