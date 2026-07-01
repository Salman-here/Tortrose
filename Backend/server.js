const dotenv = require('dotenv')
dotenv.config()

const cors = require('cors')
const rateLimit = require('express-rate-limit')
const express = require('express')
const app = express()
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1))

// ── Stripe Configuration with Live/Test Mode Support ──
const STRIPE_MODE = process.env.STRIPE_MODE || 'test'; // 'test' or 'live'
const STRIPE_SECRET_KEY = STRIPE_MODE === 'live' 
  ? process.env.STRIPE_LIVE_SECRET_KEY 
  : process.env.STRIPE_TEST_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live'
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET
  : process.env.STRIPE_TEST_WEBHOOK_SECRET;

const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

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
  if (['checkout.session.completed', 'customer.subscription.deleted', 'invoice.payment_failed', 'invoice.payment_succeeded'].includes(event.type)) {
    await handleSubscriptionWebhook(event);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Skip subscription checkouts (handled above)
    if (session.mode === 'subscription') {
      return res.sendStatus(200);
    }

    // Skip subdomain purchases (handled above in handleSubscriptionWebhook)
    if (session.metadata?.type === 'subdomain_purchase') {
      return res.sendStatus(200);
    }

    console.log("✅ Payment succeeded!");
    console.log("Session ID:", session.id);
    console.log("Order ID (metadata):", session.metadata?.orderId);

    const paymentIntentId = session.payment_intent;
    const email = session.customer_details?.email;

    const orderId = session.metadata?.orderId;
    let order = await Order.findOne({ orderId });
    if (order) {
      order.isPaid = true;
      order.paidAt = Date.now();
      order.paymentResult.paymentIntentId = paymentIntentId;
      order.paymentResult.emailAddress = email;

      // Auto-confirm online-paid orders — buyer already committed by paying.
      // Also clear the `awaitingPayment` gate so the order becomes visible to
      // sellers / users / admins.
      const wasAwaiting = order.awaitingPayment === true;
      order.awaitingPayment = false;
      order.orderStatus = 'confirmed';
      if (order.confirmation) {
        order.confirmation.confirmedAt = new Date();
        order.confirmation.confirmedVia = 'stripe_payment';
      }

      await order.save();
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
        // total. Same entitlement gate as COD: WhatsApp must be connected
        // AND at least one seller in the order must have the WhatsApp bonus.
        try {
          const WhatsAppConfig = require('./models/WhatsAppConfig');
          const { nVerify } = require('./controllers/subscriptionController');
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
            let entitled = false;
            for (const sid of resolvedSellerIds) {
              if (await nVerify(sid)) { entitled = true; break; }
            }
            if (!entitled) {
              if (order.confirmation) {
                order.confirmation.whatsappSentAt = new Date();
                order.confirmation.whatsappSentSuccess = false;
                order.confirmation.whatsappError =
                  'No seller in this order has the WhatsApp verification bonus enabled';
                await order.save();
              }
            } else {
              await enqueueOrderPlacedInfo(order);
              console.log(`[whatsapp] info enqueued for paid order ${order.orderId}`);
            }
          }
        } catch (waErr) {
          console.error('Failed to enqueue buyer WhatsApp info:', waErr.message);
        }
      }

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

      for (const item of order.orderItems) {
        await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.quantity } });
      }

      const cart = await Cart.findOne({ user: order.user });
      if (cart) {
        cart.cartItems = [];
        await cart.save();
      }
    }
  }

  // ── Abandoned / failed Stripe checkout cleanup ──
  // When a buyer closes the Stripe page or the session expires, DELETE the
  // awaiting-payment order entirely. We never want unpaid orders to appear
  // in the buyer/seller dashboards (not even as "cancelled").
  if (
    event.type === 'checkout.session.expired' ||
    event.type === 'checkout.session.async_payment_failed'
  ) {
    const session = event.data.object;
    if (session.mode === 'payment' && session.metadata?.orderId) {
      try {
        const order = await Order.findOne({ orderId: session.metadata.orderId });
        if (order && order.awaitingPayment && !order.isPaid) {
          await Order.deleteOne({ _id: order._id });
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
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
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
const sessionRoutes = require('./routes/sessionRoutes');
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
const storeReviewRoutes = require('./routes/storeReviewRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const sellerWhatsappRoutes = require('./routes/sellerWhatsappRoutes');
const userWhatsappRoutes = require('./routes/userWhatsappRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const Cart = require('./models/Cart');
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
app.use('/api/session', sessionRoutes);
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
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/store-reviews', storeReviewRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/seller-whatsapp', sellerWhatsappRoutes);
app.use('/api/user-whatsapp', userWhatsappRoutes);
app.use('/api/notifications', notificationRoutes);

// ── Dynamic SEO sitemaps (products & stores) ──
app.use('/', require('./routes/sitemapRoutes'));

// ── Trial expiration (runs on persistent Heroku dyno) ──
const { processTrialExpirations, migrateHasUsedFreePeriod } = require('./controllers/subscriptionController');
setInterval(processTrialExpirations, 60 * 60 * 1000); // every hour
setTimeout(processTrialExpirations, 30000); // 30s after boot

// ── One-time migration (runs on boot): mark existing paid sellers as hasUsedFreePeriod ──
setTimeout(migrateHasUsedFreePeriod, 15000); // 15s after boot

// ── Subdomain removal processor (runs every 6 hours) ──
const { processSubdomainRemovals } = require('./controllers/subdomainPurchaseController');
setInterval(processSubdomainRemovals, 6 * 60 * 60 * 1000); // every 6 hours
setTimeout(processSubdomainRemovals, 60000); // 60s after boot

// ── WhatsApp queue processor (Evolution API) ──
const { startQueueProcessor } = require('./services/whatsapp/queue');
startQueueProcessor();

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
