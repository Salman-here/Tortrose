'use strict';

const mongoose = require('mongoose');
const Fuse = require('fuse.js');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const User = require('../models/User');
const { plainOptions, validateProductSelection, summarizeSelectionRequest } = require('./productSelectionService');
const { getExchangeRateSnapshot, isSupportedCurrency, formatMoneySync } = require('./currencyService');
const { requireStoredProductEffectivePrice, requireStoredProductCurrency } = require('./productPricingService');
const { priceOrderItemLines } = require('./orderLinePricingService');
const { sumMoney } = require('./moneyMath');
const { isProductBlocked } = require('./productModerationService');
const { getActiveSellerIds } = require('./publicCatalogService');

const id = value => String(value?._id || value || '');
const key = value => String(value || '').trim().toLowerCase();
const has = (value, field) => Object.prototype.hasOwnProperty.call(value || {}, field);
const exactQuantity = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const optionsKey = item => JSON.stringify(Object.entries(plainOptions(item.selectedOptions) || {}).sort(([a], [b]) => a.localeCompare(b)));
const selectionLabel = item => {
  const options = plainOptions(item.selectedOptions) || {};
  if (item.selectedColor && !Object.keys(options).some(name => key(name) === 'color')) options.Color = item.selectedColor;
  return Object.entries(options).map(([name, value]) => `${name}: ${value}`).join(', ');
};
const preview = (item, products) => ({
  cartItemId: id(item._id), productId: id(item.product),
  name: products.get(id(item.product))?.name || 'Unavailable product',
  quantity: item.qty, selectedColor: item.selectedColor || null,
  selectedOptions: plainOptions(item.selectedOptions) || {},
});

function selectCartLines(items, products, args) {
  let matches = items;
  if (args.cartItemId) matches = matches.filter(item => id(item._id) === id(args.cartItemId));
  if (args.productId) matches = matches.filter(item => id(item.product) === id(args.productId));
  if (!args.cartItemId && !args.productId && args.productName) {
    const query = key(args.productName);
    const exact = matches.filter(item => key(products.get(id(item.product))?.name) === query);
    const partial = exact.length ? exact : matches.filter(item => key(products.get(id(item.product))?.name).includes(query));
    matches = partial.length ? partial : new Fuse(matches.map(item => ({ item, name: products.get(id(item.product))?.name || '' })), {
      keys: ['name'], threshold: 0.35, ignoreLocation: true,
    }).search(query).map(result => result.item.item);
  }
  if (args.currentColor) matches = matches.filter(item => key(item.selectedColor || plainOptions(item.selectedOptions)?.Color) === key(args.currentColor));
  if (args.currentOptions && typeof args.currentOptions === 'object' && !Array.isArray(args.currentOptions)) {
    matches = matches.filter(item => Object.entries(args.currentOptions).every(([name, value]) => (
      Object.entries(plainOptions(item.selectedOptions) || {}).some(([storedName, storedValue]) => key(name) === key(storedName) && key(value) === key(storedValue))
    )));
  }
  // A single cart line is itself an unambiguous target for "that one".
  return matches;
}

function mergeSelectedOptions(item, args) {
  const merged = { ...(plainOptions(item.selectedOptions) || {}) };
  for (const [name, value] of Object.entries(args.selectedOptions || {})) {
    const oldName = Object.keys(merged).find(existing => key(existing) === key(name));
    if (oldName) delete merged[oldName];
    merged[name] = value;
  }
  if (has(args, 'selectedColor')) {
    const colorName = Object.keys(merged).find(name => key(name) === 'color');
    if (colorName) merged[colorName] = args.selectedColor;
  }
  const colorFromOptions = Object.entries(args.selectedOptions || {}).find(([name]) => key(name) === 'color');
  return {
    selectedOptions: merged,
    selectedColor: has(args, 'selectedColor') ? args.selectedColor : (colorFromOptions?.[1] ?? item.selectedColor),
  };
}

async function changeAICartItem(userId, args = {}, operation = 'update', { currency: requestedCurrency } = {}) {
  if (!mongoose.isValidObjectId(userId)) return { success: false, error: 'Please sign in to manage your cart.' };
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart?.cartItems?.length) return { success: false, error: 'Your cart is empty. Add an item first.' };
  const productDocs = await Product.find({ _id: { $in: cart.cartItems.map(item => item.product) } }).lean();
  const products = new Map(productDocs.map(product => [id(product), product]));
  const matches = selectCartLines(cart.cartItems, products, args);
  const removeAllMatches = operation === 'remove' && args.allMatching === true && (args.productId || args.productName);
  if (!matches.length) return { success: false, error: 'I could not find that item in your cart. Please choose an item from your current cart.', data: { items: cart.cartItems.map(item => preview(item, products)) } };
  if (matches.length > 1 && !removeAllMatches) return {
    success: false, needsCartItemSelection: true,
    error: `More than one cart item matches. Which one would you like to change?\n${matches.map((item, index) => `${index + 1}. ${preview(item, products).name}${selectionLabel(item) ? ` (${selectionLabel(item)})` : ''} — quantity ${item.qty}`).join('\n')}`,
    data: { items: matches.map(item => preview(item, products)) },
  };
  const before = cart.cartItems;
  if (before.some(line => !exactQuantity(line.qty))) return { success: false, error: 'A cart item has an invalid quantity. Please refresh your cart.' };
  let after = before.map(item => ({ ...item }));
  const item = after.find(line => id(line._id) === id(matches[0]._id));
  const product = products.get(id(item.product));
  if (operation === 'remove') {
    const removedIds = new Set(matches.map(line => id(line._id)));
    after = after.filter(line => !removedIds.has(id(line._id)));
  } else {
    if (!product || isProductBlocked(product)) return { success: false, error: 'This product is no longer available.' };
    const activeSellers = new Set((await getActiveSellerIds()).map(id));
    if (id(product.seller) && !activeSellers.has(id(product.seller))) return { success: false, error: 'This product is no longer available.' };
    if (!exactQuantity(item.qty)) return { success: false, error: 'This cart item has an invalid quantity. Please remove it and add it again.' };
    if (has(args, 'quantity') && !exactQuantity(args.quantity)) return { success: false, error: 'Choose a whole-number quantity of at least 1, or ask to remove the item.' };
    if (has(args, 'selectedOptions') && (!args.selectedOptions || typeof args.selectedOptions !== 'object' || Array.isArray(args.selectedOptions))) return { success: false, error: 'Please choose the product options by their names and values.' };
    const suppliedColorOption = Object.entries(args.selectedOptions || {}).find(([name]) => key(name) === 'color');
    if (has(args, 'selectedColor') && suppliedColorOption && key(args.selectedColor) !== key(suppliedColorOption[1])) return { success: false, error: 'Two different colors were selected. Which color would you like?' };
    if (!has(args, 'quantity') && !has(args, 'selectedColor') && !has(args, 'selectedOptions')) return { success: false, error: 'What would you like to change: color, size, another option, or quantity?' };
    const selection = validateProductSelection(product, mergeSelectedOptions(item, args));
    if (!selection.ok) return {
      success: false, needsSelection: true, error: summarizeSelectionRequest(product, selection, 'add'),
      data: { ...preview(item, products), missingOptions: selection.missingOptions, invalidOptions: selection.invalidOptions, requiredOptions: selection.requiredOptions },
    };
    item.qty = has(args, 'quantity') ? args.quantity : item.qty;
    item.selectedColor = selection.selectedColor;
    item.selectedOptions = selection.selectedOptions;
    const productLines = after.filter(line => id(line.product) === id(item.product));
    if (!Number.isSafeInteger(product.stock) || product.stock < 0 || productLines.some(line => !exactQuantity(line.qty))) return { success: false, error: 'This product has invalid stock or cart quantities. Please refresh your cart.' };
    const totalQuantity = productLines.reduce((sum, line) => sum + line.qty, 0);
    if (!Number.isSafeInteger(totalQuantity) || totalQuantity > product.stock) return { success: false, error: `Only ${product.stock} units of "${product.name}" are available, including all colors and sizes in your cart.` };
    // If the chosen variant is already another line, coalesce it without
    // dropping units. Every unrelated product/variant remains untouched.
    const duplicateLines = productLines.filter(line => id(line._id) !== id(item._id) && key(line.selectedColor) === key(item.selectedColor) && optionsKey(line) === optionsKey(item));
    item.qty += duplicateLines.reduce((sum, line) => sum + line.qty, 0);
    const duplicateIds = new Set(duplicateLines.map(line => id(line._id)));
    after = after.filter(line => !duplicateIds.has(id(line._id)));
  }

  const account = requestedCurrency === undefined ? await User.findById(userId).select('currency').lean() : null;
  const currency = requestedCurrency === undefined ? (account?.currency ?? 'USD') : requestedCurrency;
  if (typeof currency !== 'string' || currency !== currency.trim().toUpperCase() || !isSupportedCurrency(currency)) return { success: false, error: 'Your account currency could not be verified. Please refresh your profile.' };
  const nativeLines = after.flatMap(line => {
    const currentProduct = products.get(id(line.product));
    if (!currentProduct) return [];
    if (!exactQuantity(line.qty)) throw new Error('A cart item has an invalid quantity.');
    return [{ sourcePrice: requireStoredProductEffectivePrice(currentProduct), sourceCurrency: requireStoredProductCurrency(currentProduct, 'USD'), quantity: line.qty }];
  });
  const snapshot = await getExchangeRateSnapshot();
  const priced = priceOrderItemLines({ items: nativeLines, targetCurrency: currency, exchangeRates: snapshot.rates, exchangeRatesFallback: snapshot.fallback });
  const total = sumMoney(priced.map(line => line.lineSubtotal));
  // The total is already priced in the buyer's currency. Formatting must not
  // treat it as USD and convert it a second time. Do this before the write.
  const formattedTotal = formatMoneySync(total, currency, { sourceCurrency: currency });
  // Compare the entire read snapshot, not just one line. This also detects
  // changes from older cart clients whose updates do not increment __v.
  const saved = await Cart.updateOne({ _id: cart._id, user: userId, cartItems: before, __v: cart.__v ?? { $exists: false } }, {
    $set: { cartItems: after, totalCartPrice: total, totalCartCurrency: currency }, $inc: { __v: 1 },
  }, { runValidators: true });
  if (Number(saved.matchedCount ?? saved.n) !== 1) return { success: false, code: 'CART_CHANGED', error: 'Your cart changed while I was updating it. Please review the latest cart and try again; this change was not applied.' };
  const updatedItem = operation === 'update' ? preview(item, products) : null;
  const totalQuantity = after.reduce((sum, line) => sum + line.qty, 0);
  const detail = operation === 'update'
    ? `Updated "${product.name}"${selectionLabel(item) ? ` (${selectionLabel(item)})` : ''} — quantity ${item.qty}.`
    : `Removed ${matches.length} matching cart item${matches.length === 1 ? '' : 's'}.`;
  return {
    success: true,
    data: { item: updatedItem, items: after.map(line => preview(line, products)), cartItemCount: after.length, totalQuantity, totalCartPrice: total, totalCartCurrency: currency },
    message: `${detail} Your cart now contains ${totalQuantity} unit${totalQuantity === 1 ? '' : 's'}. Cart subtotal: ${formattedTotal}${currency === 'USD' ? ' USD' : ''}.`,
  };
}

module.exports = { changeAICartItem, selectCartLines, mergeSelectedOptions };
