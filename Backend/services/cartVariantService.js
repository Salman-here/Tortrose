'use strict';
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const { runInTransaction } = require('./walletService');
const { publicProductFilter } = require('./productModerationService');
const { validateProductSelection, createProductSelectionError } = require('./productSelectionService');
const key = value => JSON.stringify(Object.entries(value instanceof Map ? Object.fromEntries(value) : value || {}).sort(([a],[b]) => a.localeCompare(b)));
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const identity = line => JSON.stringify([line.selectedColor || null, key(line.selectedOptions)]);
async function editCartVariant({ userId, lineId, selectedColor, selectedOptions, expected }) {
  if (!/^[a-f\d]{24}$/iu.test(lineId || '') || !expected || !Number.isSafeInteger(expected.qty) || expected.qty < 1) throw fail('Refresh your bag before editing this variant.', 'CART_VARIANT_INPUT_INVALID', 400);
  return runInTransaction(async session => {
    const cart = await Cart.findOne({ user: userId }).session(session);
    const line = cart?.cartItems.id(lineId);
    if (!line) throw fail('This cart item no longer exists. Refresh your bag.', 'CART_LINE_NOT_FOUND', 404);
    if (line.qty !== expected.qty || identity(line) !== identity(expected)) throw fail('This item changed on another screen. Review its latest quantity and options.', 'CART_VARIANT_STALE');
    const product = await Product.findOne(publicProductFilter({ _id: line.product })).session(session).lean();
    if (!product) throw fail('This product is no longer available.', 'CART_PRODUCT_UNAVAILABLE');
    const selection = validateProductSelection(product, { selectedColor, selectedOptions });
    if (!selection.ok) throw createProductSelectionError(product, selection, 'edit');
    const productLines = cart.cartItems.filter(row => String(row.product) === String(product._id));
    const total = productLines.reduce((sum, row) => { if (!Number.isSafeInteger(row.qty) || row.qty < 1 || !Number.isSafeInteger(sum + row.qty)) throw fail('Cart quantities could not be verified.', 'CART_QUANTITY_INVALID'); return sum + row.qty; }, 0);
    if (!Number.isSafeInteger(product.stock) || total > product.stock) throw fail('There is not enough stock for these quantities. Reduce the quantity first.', 'CART_STOCK_EXCEEDED');
    const wanted = { selectedColor: selection.selectedColor || null, selectedOptions: selection.selectedOptions };
    const other = productLines.find(row => String(row._id) !== lineId && identity(row) === identity(wanted));
    if (other) { other.qty += line.qty; line.deleteOne(); }
    else { line.selectedColor = wanted.selectedColor; line.selectedOptions = wanted.selectedOptions; }
    await cart.save({ session });
    return cart;
  });
}
async function addCartVariant({ userId, productId, selectedColor, selectedOptions }) {
  const attempt = () => runInTransaction(async session => {
    const product = await Product.findOne(publicProductFilter({ _id: productId })).session(session).lean();
    if (!product) throw fail('Product is not available.', 'CART_PRODUCT_UNAVAILABLE', 404);
    if (!Number.isSafeInteger(product.stock) || product.stock < 1) throw fail('Product is out of stock.', 'CART_STOCK_EXCEEDED');
    const selected = validateProductSelection(product, { selectedColor, selectedOptions });
    if (!selected.ok) throw createProductSelectionError(product, selected, 'add');
    let cart = await Cart.findOne({ user: userId }).session(session);
    const existing = cart?.cartItems.find(row => String(row.product) === String(product._id) && identity(row) === identity(selected));
    if (existing) { await cart.populate('cartItems.product'); return { cart, alreadyAdded: true }; }
    const count = (cart?.cartItems || []).filter(row => String(row.product) === String(product._id)).reduce((total,row) => {
      if (!Number.isSafeInteger(row.qty) || row.qty < 1 || !Number.isSafeInteger(total + row.qty)) throw fail('Cart quantities could not be verified.', 'CART_QUANTITY_INVALID');
      return total + row.qty;
    },0);
    if (count >= product.stock) throw fail('There is not enough stock to add another variant.', 'CART_STOCK_EXCEEDED');
    if (!cart) cart = new Cart({ user: userId, cartItems: [] });
    cart.cartItems.push({ product: product._id, selectedColor: selected.selectedColor || null, selectedOptions: selected.selectedOptions });
    await cart.save({ session });
    return { cart, alreadyAdded: false };
  });
  try { return await attempt(); }
  catch (error) { if (error.code === 11000 && error.keyPattern?.user) return attempt(); throw error; }
}
module.exports = { editCartVariant, addCartVariant };
