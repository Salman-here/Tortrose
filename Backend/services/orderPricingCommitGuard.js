'use strict';
const Store = require('../models/Store');
const Product = require('../models/Product');
const ShippingMethod = require('../models/ShippingMethod');
const { requireStoredProductCurrency, requireStoredProductEffectivePrice } = require('./productPricingService');
const changed = () => Object.assign(new Error('Store prices or shipping changed during checkout. Refresh the order preview and confirm the current total.'), { statusCode: 409, code: 'CHECKOUT_REPRICE_REQUIRED' });

// Only for first order insertion, never for payment callbacks or old orders.
// Shares the store document lock with product/currency/shipping writes.
async function verifyOrderPricingAtCommit(order, session) {
  const policies = [...(order.sellerPolicies || [])].sort((a,b) => String(a.seller).localeCompare(String(b.seller)));
  for (const policy of policies) {
    const lock = await Store.updateOne({ seller: policy.seller, productCurrency: policy.productCurrency,
      productCurrencyStatus: 'active', isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
    if (lock.matchedCount !== 1) throw changed();
  }
  const products = await Product.find({ _id: { $in: order.orderItems.map(item => item.productId) } }).session(session).lean();
  const byId = new Map(products.map(product => [String(product._id), product]));
  for (const item of order.orderItems) {
    const product = byId.get(String(item.productId));
    if (!product || String(product.seller) !== String(item.seller)
        || requireStoredProductCurrency(product, 'USD') !== item.sourceCurrency
        || requireStoredProductEffectivePrice(product) !== item.sourcePrice) throw changed();
  }
  const shipping = await ShippingMethod.find({ seller: { $in: policies.map(policy => policy.seller) } }).session(session).lean();
  for (const allocation of order.sellerShipping || []) {
    const document = shipping.find(doc => String(doc.seller) === String(allocation.seller));
    const snapshot = allocation.shippingMethod;
    if (!document) { if (snapshot.sourceCost !== 0) throw changed(); continue; }
    const method = document.methods.find(row => row.type === snapshot.name && row.isActive !== false);
    if (!method || method.cost !== snapshot.sourceCost || (method.currency || method.costCurrency || 'USD') !== snapshot.sourceCurrency
        || (method.deliveryDays ?? 5) !== snapshot.estimatedDays) throw changed();
  }
}
module.exports = { verifyOrderPricingAtCommit };
