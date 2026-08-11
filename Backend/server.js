const dotenv = require('dotenv')
dotenv.config()

const cors = require('cors')
const rateLimit = require('express-rate-limit')
const express = require('express')
const app = express()
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))

// ── Stripe Configuration with Live/Test Mode Support ──
const { stripe, STRIPE_MODE, STRIPE_WEBHOOK_SECRET } = require('./config/stripe');

if (stripe) {
  console.log(`✅ Stripe initialized in ${STRIPE_MODE.toUpperCase()} mode`);
} else {
  console.warn('⚠️  Stripe not configured - payment features disabled');
}

const mongoose = require('mongoose')
const Order = require('./models/Order')
const Product = require('./models/Product')
const { trackOrderEvent } = require('./services/tiktokEventsApi')
const { configKeyFor } = require('./services/whatsapp/gatewayMode')
const { restoreOrderInventory } = require('./services/orderInventoryService')
const {
  fulfillStripeOrder,
  fulfillStripeOrderPaymentIntent,
  recordStripeOrderPaymentFailure,
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
  if (['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.deleted', 'invoice.payment_failed', 'invoice.payment_succeeded'].includes(event.type)) {
    try {
      await handleSubscriptionWebhook(event);
    } catch (subscriptionWebhookError) {
      console.error('❌ Subscription webhook processing failed:', subscriptionWebhookError.message);
      return res.sendStatus(500);
    }
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const session = event.data.object;
    const isPaymentIntentEvent = event.type === 'payment_intent.succeeded';

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
        if (returnRequest) {
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

    const orderId = session.metadata?.orderId;
    let order = await Order.findOne({ orderId });
    if (!order) {
      console.error('[stripe] checkout references an unknown order:', orderId);
      return res.sendStatus(400);
    }

    let fulfillmentResult;
    try {
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
    if (!wasAwaiting) return res.sendStatus(200);
    const email = (isPaymentIntentEvent ? session.receipt_email : session.customer_details?.email)
      || order.shippingInfo?.email;

    if (order) {
      console.log("✅ Order updated & auto-confirmed:", order.orderId);

      trackOrderEvent({
        event: 'Purchase',
        req,
        order,
        eventId: order.tracking?.tiktokPurchaseEventId || session.metadata?.tiktokPurchaseEventId,
        tracking: order.tracking || {},
      }).catch(() => {});

      // If this order was awaiting payment, send seller "new order" notifications
      // now (we deliberately deferred them at place-time so abandoned checkouts
      // don't spam sellers).
      let resolvedSellerIds = [];
      if (wasAwaiting) {
        try {
          const { newOrderSellerEmail } = require('./utils/emailTemplates');
          const { notifySeller } = require('./services/whatsapp/sellerNotificationService');
          const sellerTemplates = require('./services/whatsapp/sellerMessageTemplates');
          const sellerIds = [...new Set((order.orderItems || []).map(i => {
            // orderItems on the saved order don't always carry seller; look it up via product
            return i.seller?.toString();
          }).filter(Boolean))];
          // Fallback: derive sellers from products
          resolvedSellerIds = sellerIds;
          if (resolvedSellerIds.length === 0) {
            const productIds = (order.orderItems || []).map(i => i.productId).filter(Boolean);
            const products = await Product.find({ _id: { $in: productIds } }).select('seller');
            resolvedSellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
          }
          for (const sellerId of resolvedSellerIds) {
            const sellerUser = await User.findById(sellerId);
            if (sellerUser?.email) {
              const sellerEmailData = newOrderSellerEmail(order, sellerUser.username);
              await sendEmail({ to: sellerUser.email, ...sellerEmailData }).catch(e =>
                console.error('Seller new-order email failed:', e.message)
              );
            }
            notifySeller(sellerId, 'new_order', sellerTemplates.new_order(order)).catch(e =>
              console.error('[whatsapp] seller new order notification failed:', e.message)
            );
          }
        } catch (notifyErr) {
          console.error('Failed to send post-payment seller notifications:', notifyErr.message);
        }

        // ── Buyer WhatsApp info notification (post-payment only) ──
        // Online-paid orders auto-confirm at payment time, so we send the
        // buyer an INFO message (no Yes/No poll) listing items + stores +
        // total. This is a core checkout notification for the buyer — it is
        // NOT gated by any seller subscription/plan. Only precondition: the
        // WhatsApp gateway is connected (valid phone is checked in the queue).
        try {
          const WhatsAppConfig = require('./models/WhatsAppConfig');
          const { enqueueOrderPlacedInfo } = require('./services/whatsapp/queue');

          const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
          if (!cfg || cfg.status !== 'connected') {
            if (order.confirmation) {
              order.confirmation.whatsappSentAt = new Date();
              order.confirmation.whatsappSentSuccess = false;
              order.confirmation.whatsappError = cfg
                ? `WhatsApp status: ${cfg.status} (not connected)`
                : 'WhatsApp not configured';
              await order.save();
            }
          } else {
            await enqueueOrderPlacedInfo(order);
            console.log(`[whatsapp] info enqueued for paid order ${order.orderId}`);
          }
        } catch (waErr) {
          console.error('Failed to enqueue buyer WhatsApp info:', waErr.message);
        }
      }

      if (wasAwaiting) {
        try {
          const user = await User.findById(order.user);
          const { formatOrderMoney } = require('./utils/orderPresentation');
          const paidAmount = formatOrderMoney(order.orderSummary?.totalAmount || 0, order.currency || 'USD');
          const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Order Confirmation</title>
  <style>
    body { background-color:#F8F9FA; font-family:'Inter','Segoe UI',sans-serif; color:#1A1A1A; line-height:1.6; margin:0; padding:0; }
    .email-wrapper { max-width:600px; margin:0 auto; padding:1.5rem; }
    .card { background:#FFFFFF; border-radius:16px; box-shadow:0 10px 25px rgba(0,0,0,0.05); padding:2rem; }
    .header { background:#16A34A; color:#fff; padding:1rem 2rem; border-radius:12px 12px 0 0; font-size:1.25rem; font-weight:600; text-align:center; }
    .button { display:inline-block; margin-top:1.5rem; background:#16A34A; color:white!important; padding:0.75rem 1.5rem; border-radius:8px; text-decoration:none; font-weight:500; }
    .footer { font-size:14px; text-align:center; color:#6B7280; margin-top:2rem; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="card">
      <div class="header">🎉 Payment Successful!</div>
      <div style="padding:1.5rem 0;">
        <p>Hello ${user?.username || 'Customer'},</p>
        <p>We have successfully received your payment of <strong>${paidAmount}</strong> for your order <strong>#${order.orderId}</strong>.</p>
        <p>Your order is now confirmed and will be delivered to you shortly.</p>
        <p style="text-align:center;">
          <a href="${process.env.FRONTEND_URL}/user-dashboard/order/detail/${order._id}" class="button">View Your Order</a>
        </p>
        <p>Thank you for shopping with <strong>Rozare</strong>.</p>
        <p>Stay safe,<br/>The Rozare Team</p>
      </div>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} Rozare. All rights reserved.</div>
  </div>
</body>
</html>`;

          await sendEmail({
            to: email,
            subject: `Your Order #${order.orderId} is Confirmed 🎉`,
            text: `We've received your payment of ${paidAmount}. Your order will be delivered soon.`,
            html: html,
          });
        } catch (emailErr) {
          console.error('Failed to send payment confirmation email:', emailErr.message);
        }
      }

      if (wasAwaiting && order.user && Array.isArray(order.appliedCoupons)) {
        const { recordCouponUsage } = require('./controllers/couponController');
        for (const couponData of order.appliedCoupons) {
          if (couponData?.couponId) {
            await recordCouponUsage(couponData.couponId, order.user.toString());
          }
        }
      }

    }
  }

  // ── Abandoned / failed Stripe checkout cleanup ──
  // When a buyer closes the Stripe page or the session expires, DELETE the
  // awaiting-payment order entirely. We never want unpaid orders to appear
  // in the buyer/seller dashboards (not even as "cancelled").
  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    try {
      if (paymentIntent.metadata?.type === 'wallet_top_up') {
        const { recordWalletTopUpPaymentFailure } = require('./services/walletService');
        await recordWalletTopUpPaymentFailure(paymentIntent, event.id);
      } else if (paymentIntent.metadata?.type === 'order_payment') {
        const order = await Order.findOne({
          orderId: paymentIntent.metadata.orderId,
          stripePaymentIntentId: paymentIntent.id,
          paymentFlow: 'payment_sheet',
        });
        if (!order) return res.sendStatus(400);
        await recordStripeOrderPaymentFailure({ order, paymentIntent });
      }
      return res.sendStatus(200);
    } catch (error) {
      console.error('[stripe] PaymentIntent failure processing failed:', error.message);
      return res.sendStatus(error.statusCode >= 500 ? 500 : 400);
    }
  }

  if (event.type === 'payment_intent.canceled') {
    const paymentIntent = event.data.object;
    try {
      if (paymentIntent.metadata?.type === 'wallet_top_up') {
        const { cancelWalletTopUpFromPaymentIntent } = require('./services/walletService');
        await cancelWalletTopUpFromPaymentIntent(paymentIntent, {
          eventId: event.id,
          status: 'cancelled',
          reason: 'Stripe confirmed that the Wallet top-up was cancelled.',
        });
      } else if (paymentIntent.metadata?.type === 'order_payment') {
        const { closeOrderPaymentIntent } = require('./services/stripePendingPaymentService');
        const order = await Order.findOne({
          orderId: paymentIntent.metadata.orderId,
          stripePaymentIntentId: paymentIntent.id,
          paymentFlow: 'payment_sheet',
        });
        if (!order) return res.sendStatus(400);
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

  if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    try {
      let charge = event.data.object;
      if (event.type === 'charge.dispute.created' && charge.charge) {
        const chargeId = typeof charge.charge === 'string' ? charge.charge : charge.charge.id;
        const retrievedCharge = await stripe.charges.retrieve(chargeId);
        charge = { ...retrievedCharge, amount: charge.amount || retrievedCharge.amount };
      }
      const { flagWalletTopUpPaymentRisk } = require('./services/walletPaymentRiskService');
      await flagWalletTopUpPaymentRisk({ charge, eventId: event.id, eventType: event.type });
      return res.sendStatus(200);
    } catch (error) {
      console.error('[wallet] Stripe refund/dispute review failed:', error.message);
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
      await failWalletTopUp(session).catch(error =>
        console.error('[wallet] failed to mark top-up failed:', error.message)
      );
      return res.sendStatus(200);
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
      }
      return res.sendStatus(200);
    }
    if (session.mode === 'payment' && session.metadata?.orderId) {
      try {
        const order = await Order.findOne({
          orderId: session.metadata.orderId,
          stripeSessionId: session.id,
          paymentMethod: 'stripe',
        });
        if (order && order.awaitingPayment && !order.isPaid) {
          if (order.inventoryCommitted) await restoreOrderInventory(order._id);
          await Order.deleteOne({ _id: order._id, isPaid: false, awaitingPayment: true });
          console.log(`🗑️  Deleted abandoned/unpaid checkout order ${order.orderId}`);
        }
      } catch (cleanupErr) {
        console.error('Failed to delete abandoned order:', cleanupErr.message);
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
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown',
  handler: (req, res, _next, options) => {
    return res.status(options.statusCode).json(options.message);
  },
});

// ── Body Parsing ──
// The Evolution WhatsApp webhook carries inbound media inline as base64 (voice
// notes, product images, documents) when webhookBase64 is enabled, so its
// payloads can be several MB. Parse that route with a larger limit BEFORE the
// global 100kb json parser — body-parser skips re-parsing once req._body is set,
// so the global parser below is a no-op for this route and unchanged elsewhere.
app.use('/api/whatsapp/webhook', express.json({ limit: process.env.WHATSAPP_WEBHOOK_BODY_LIMIT || '30mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Meta browser event relay does not require a database connection.
app.use('/api/meta', require('./routes/metaRoutes'));

// ── Database ──
const ConnectDB = require('./config/db');
ConnectDB().catch(err => console.error('DB init error:', err.message));

// Middleware to ensure DB is connected before processing any API request
app.use('/api', async (req, res, next) => {
  try {
    await ConnectDB();
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
const { sendEmail } = require('./controllers/mailController');
const User = require('./models/User');

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
  const runStripePaymentCleanup = () => cleanupStaleStripePaymentIntents()
    .catch(error => console.error('[stripe-cleanup] scheduled cleanup failed:', error.message));
  const cleanupTimer = setInterval(runStripePaymentCleanup, 5 * 60 * 1000);
  cleanupTimer.unref?.();
  const initialCleanupTimer = setTimeout(runStripePaymentCleanup, 45000);
  initialCleanupTimer.unref?.();
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
    mongoConnected: mongoose.connection.readyState === 1
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

module.exports = app;
