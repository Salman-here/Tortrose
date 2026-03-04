const dotenv = require('dotenv')
dotenv.config()

const cors = require('cors')
const rateLimit = require('express-rate-limit')
const express = require('express')
const app = express()
app.set('trust proxy', 1)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const mongoose = require('mongoose')
const Order = require('./models/Order')
const Product = require('./models/Product')
// const bodyParser = require('body-parser')


app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.sendStatus(400);
  }
   


  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ Payment succeeded!");
    console.log("Session ID:", session.id);
    console.log("Order ID (metadata):", session.metadata?.orderId);

    const paymentIntentId = session.payment_intent;
    console.log("Payment Intent ID:", paymentIntentId);

    const email = session.customer_details?.email;
    console.log("Customer email:", email);

    // Update order
    const orderId = session.metadata?.orderId;
    let order = await Order.findOne({ orderId });
    if (order) {
      order.isPaid = true;
      order.paidAt = Date.now();
      order.paymentResult.paymentIntentId = paymentIntentId;
      order.paymentResult.emailAddress = email;
      await order.save();
      console.log("✅ Order updated:", order);

      const user = await User.findById(order.user)

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Order Confirmation</title>
  <style>
    body {
      background-color: #F8F9FA;
      font-family: 'Inter', 'Lato', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #1A1A1A;
      line-height: 1.6;
      font-size: 16px;
      margin: 0;
      padding: 0; 
    }
    .email-wrapper {
      max-width: 600px;
      margin: 0 auto;
      padding: 1.5rem;
    }
    .card {
      background-color: #FFFFFF;
      border-radius: 16px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
      padding: 2rem;
    }
    .header {
      background-color: #16A34A; /* green */
      color: #ffffff;
      padding: 1rem 2rem;
      border-radius: 12px 12px 0 0;
      font-family: 'Poppins', sans-serif;
      font-size: 1.25rem;
      font-weight: 600;
      text-align: center;
    }
    .content {
      padding: 1.5rem 0;
    }
    .content p {
      margin: 1rem 0;
    }
    .footer {
      font-size: 14px;
      text-align: center;
      color: #6B7280;
      margin-top: 2rem;
    }
    .button {
      display: inline-block;
      margin-top: 1.5rem;
      background-color: #16A34A;
      color: white !important;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      transition: background-color 0.3s ease;
    }
    .button:hover {
      background-color: #15803d;
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="card"> 
      <div class="header">🎉 Payment Successful!</div>
      <div class="content">
        <p>Hello ${user.username || 'Customer'},</p>
        <p>We have successfully received your payment of <strong>USD ${order.orderSummary.totalAmount}</strong> for your order <strong>#${order.orderId}</strong>.</p>
        <p>Your order is now confirmed and will be delivered to you shortly.</p>
        <p style="text-align: center;">
          <a href="${process.env.FRONTEND_URL}/user-dashboard/order/detail/${order._id}" class="button">View Your Order</a>
        </p>
        <p>Thank you for shopping with <strong>Tortrose</strong>. We’ll notify you as soon as your order is shipped.</p>
        <p>Stay safe,<br/>The Tortrose Team</p>
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Tortrose. All rights reserved.
    </div>
  </div>
</body>
</html>
`;



      await sendEmail({
        to: email,
        subject: `Your Order #${order.orderId} is Confirmed 🎉`,
        text: `We’ve received your payment of USD ${order.totalPrice}. Your order will be delivered soon.`,
        html: html,
      });

      for (const item of order.orderItems) {
        await Product.findByIdAndUpdate(
          item.productId,
          { $inc: { stock: -item.quantity } },
        );
      }



      const cart = await Cart.findOne({ user: order.user })
      console.log(cart);

      if (cart) {
        cart.cartItems = []
        await cart.save()
      }

    }

  }


  res.sendStatus(200);
});


// CORS - Restrict to known origins (React Native apps are not browser-based, not affected by CORS)
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, server-to-server, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS policy: origin not allowed'));
  },
  credentials: true,
}));

// Rate Limiting - Protect auth endpoints from brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // max 20 auth requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { msg: 'Too many requests, please try again later.' },
  handler: (req, res, _next, options) => {
    return res.status(options.statusCode).json(options.message)
  },
});

app.use(express.json())
app.use(express.urlencoded({ extended: true }));

const ConnectDB = require('./config/db')
ConnectDB()

// Initialize Passport
const passport = require('passport')
require('./middleware/googleStreatgy')
app.use(passport.initialize())

const resetPasswordRoutes = require('./routes/resetPasswordRoutes')
const productRoutes = require('./routes/productRoutes')
const authRoutes = require('./routes/authRoutes')
const cartRoutes = require('./routes/cartRoutes')
const orderRoutes = require('./routes/orderRoutes')
const userRoutes = require('./routes/userRoutes')
const uploadRoutes = require('./routes/uploadRoutes')
const sessionRoutes = require('./routes/sessionRoutes')
// const spinRoutes = require('./routes/spinRoutes') // SPIN WHEEL DISABLED
const storeRoutes = require('./routes/storeRoutes')
const taxRoutes = require('./routes/taxRoutes')
const shippingRoutes = require('./routes/shippingRoutes')
const currencyRoutes = require('./routes/currencyRoutes')
const trustRoutes = require('./routes/trustRoutes')
const { getOrderDetail } = require('./controllers/orderController')
const Cart = require('./models/Cart')
const { sendEmail } = require('./controllers/mailController')
const User = require('./models/User')


app.use('/api/products', productRoutes)
app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/password', authLimiter, resetPasswordRoutes)
app.use('/api/cart', cartRoutes)
app.use('/api/order', orderRoutes)
app.use('/api/user', userRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/session', sessionRoutes)
// app.use('/api/spin', spinRoutes) // SPIN WHEEL DISABLED
app.use('/api/stores', trustRoutes)
app.use('/api/stores', storeRoutes)
app.use('/api/tax', taxRoutes)
app.use('/api/shipping', shippingRoutes)
app.use('/api/currency', currencyRoutes)

 


const PORT = process.env.PORT || 5000
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
})

