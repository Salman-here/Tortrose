'use strict';
// Isolated developer UI fixture. No production database, workers or outbound messages.
// Run only with VISIBILITY_QA_UI=1 and VISIBILITY_QA_PASSWORD set.
if (process.env.VISIBILITY_QA_UI !== '1' || !process.env.VISIBILITY_QA_PASSWORD) {
  throw new Error('This preview requires explicit local QA mode and a local account password.');
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
process.env.STRIPE_TEST_SECRET_KEY = '';
process.env.STRIPE_LIVE_SECRET_KEY = '';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const express = require('express');
const path = require('path');
const cors = require('cors');
const rates = require('../services/currencyService');
rates.getExchangeRateSnapshot = async () => ({ base: 'USD', rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, capturedAt: new Date().toISOString(), source: 'isolated-ui-fixture', fallback: false });
for (const modulePath of ['../services/tiktokEventsApi', '../services/metaConversionsApi']) {
  const tracking = require(modulePath);
  Object.keys(tracking).filter(key => key.startsWith('track')).forEach(key => { tracking[key] = async () => ({ skipped: true }); });
}
const operational = require('../services/sellerOperationalNotificationService');
operational.enqueueStoreCreatedNotification = async () => {};
operational.ensureSellerWelcomeNotification = async () => {};
const verifiedPhones = new Set();
const phoneKey = (user, phone) => String(user) + ':' + String(phone).replace(/\D/g, '');
require('../controllers/sellerWhatsappController').consumeVerifiedWhatsAppNumber = async (phone, user) => {
  const key = phoneKey(user, phone), verified = verifiedPhones.has(key);
  verifiedPhones.delete(key); return verified;
};
const User = require('../models/User');
const Store = require('../models/Store');
const Product = require('../models/Product');
const auth = require('../controllers/authController');
const users = require('../controllers/userController');
const products = require('../controllers/productController');
const currency = require('../controllers/currencyController');
const { normalizeStoreVisibility } = require('../services/storeVisibilityService');
const verifyToken = require('../middleware/authMiddleware');
const { optionalAuth } = require('../middleware/authMiddleware');

(async () => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replica.getUri();
  if (!uri.startsWith('mongodb://127.0.0.1:')) throw new Error('Refusing a non-local QA database.');
  await mongoose.connect(uri);
  for (const email of ['visibility.buyer@qa.invalid', 'visibility.mobile@qa.invalid']) {
    await User.create({ username: 'Visibility QA Buyer', email, password: process.env.VISIBILITY_QA_PASSWORD, role: 'user', currency: 'PKR', isVerified: true, savedShippingInfo: { country: 'Pakistan', countryCode: 'PK', state: 'Punjab', city: 'Lahore', address: '100 QA Road' } });
  }
  const image = 'http://localhost:5191/qa/mug.png';
  for (const [key, label, mode, countryName, code] of [
    ['pk', 'Pakistan Country', 'country', 'Pakistan', 'PK'],
    ['us', 'United States Country', 'country', 'United States', 'US'],
    ['global', 'Global Travel', 'global', 'Pakistan', 'PK'],
    ['state', 'Punjab State', 'region', 'Pakistan', 'PK'],
    ['city', 'Lahore City', 'city', 'Pakistan', 'PK'],
    ['town', 'Gulberg Town', 'town', 'Pakistan', 'PK'],
  ]) {
    const seller = await User.create({ username: label + ' Seller', email: key + '.seller@qa.invalid', role: 'seller', status: 'active', currency: 'USD' });
    await Store.create({ seller: seller._id, storeName: label + ' Store', storeSlug: 'visibility-qa-' + key, description: 'Isolated visibility preview store.', isActive: true, productCurrency: 'USD', productCurrencyStatus: 'active', address: { country: countryName, countryCode: code, city: 'Lahore' }, visibility: normalizeStoreVisibility({ mode, country: countryName, countryCode: code, region: mode === 'global' || mode === 'country' ? '' : 'Punjab', regionCode: mode === 'global' || mode === 'country' ? '' : 'PB', city: 'Lahore', town: 'Gulberg' }) });
    await Product.create({ seller: seller._id, name: label + ' Mug', description: 'A locally seeded QA product. No real purchase or dispatch.', price: 10, currency: 'USD', stock: 10, image, category: 'Home & Kitchen', brand: label });
  }
  const app = express();
  app.use(cors({ origin: (origin, done) => done(null, !origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)), credentials: true }));
  app.use(express.json());
  app.get('/qa/mug.png', (_req, res) => res.sendFile(path.resolve(__dirname, '../../test-assets/aurora-thermal-travel-mug.png')));
  app.get('/api/currency/detect', (_req, res) => res.json({ success: true, detected: true, country: 'PK', countryName: 'Pakistan', currency: 'PKR' }));
  app.get('/api/currency/rates', currency.getExchangeRates);
  app.get('/api/currency/list', currency.getCurrencies);
  app.patch('/api/currency/update', verifyToken, currency.updateUserCurrency);
  app.use('/api/locations', require('../routes/locationRoutes'));
  app.get('/api/products/get-products', optionalAuth, products.getProducts);
  app.get('/api/products/get-filters', optionalAuth, products.getFilters);
  app.get('/api/products/get-single-product/:id', optionalAuth, products.getSingleProduct);
  app.get('/api/products/get-wishlist', (_req, res) => res.json({ wishlist: [] }));
  app.get('/api/notifications*', (_req, res) => res.json({ notifications: [], unreadCount: 0 }));
  app.get('/api/ai-chat/conversations', (_req, res) => res.json({ success: true, conversations: [] }));
  app.get('/api/cart*', (_req, res) => res.json({ cart: [], totalCartPrice: 0, totalCartCurrency: 'PKR' }));
  app.get('/api/order/get', (_req, res) => res.json({ orders: [] }));
  app.get('/api/coupons/store/:id', (_req, res) => res.json({ coupons: [] }));
  app.post('/api/auth/login', auth.login);
  app.get('/api/user/single', verifyToken, users.getSingle);
  app.post('/api/user/become-seller', verifyToken, users.becomeSeller);
  app.post('/api/seller-whatsapp/send-otp', verifyToken, (_req, res) => res.json({ success: true, message: 'Local QA code: 123456. No WhatsApp message was sent.' }));
  app.post('/api/seller-whatsapp/verify-otp', verifyToken, (req, res) => {
    if (req.body.otp !== '123456') return res.status(400).json({ message: 'Use the local QA verification code.' });
    verifiedPhones.add(phoneKey(req.user.id, req.body.whatsappNumber));
    res.json({ success: true });
  });
  app.use('/api/stores', require('../routes/trustRoutes'));
  app.use('/api/stores', require('../routes/storeRoutes'));
  app.get('/api/subscription/catalog', require('../controllers/subscriptionController').getSubscriptionCatalog);
  const server = app.listen(5191, '127.0.0.1', () => console.log('Isolated visibility QA API: http://localhost:5191. Accounts: visibility.buyer@qa.invalid and visibility.mobile@qa.invalid. No production data or external notifications.'));
  const stop = async () => { server.close(); await mongoose.disconnect(); await replica.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch(error => { console.error('Local preview failed:', error.message); process.exit(1); });
