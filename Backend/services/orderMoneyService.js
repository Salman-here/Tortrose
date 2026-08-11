const { normalizeCurrency, convertAmount, formatMoneySync } = require('./currencyService');

const roundMoney = (value) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
};

const toId = (value) => value?._id?.toString?.() || value?.toString?.() || String(value || '');

const getOrderCurrency = (order, fallbackCurrency = 'USD') =>
  normalizeCurrency(order?.currency || order?.displayCurrency || order?.orderCurrency || fallbackCurrency);

const getRequestedCurrency = (req, fallbackCurrency = 'USD') =>
  normalizeCurrency(req?.query?.currency || req?.body?.currency || req?.user?.currency || fallbackCurrency);

const resolveRequestedCurrency = async (req, UserModel, fallbackCurrency = 'USD') => {
  const directCurrency = req?.query?.currency || req?.body?.currency || req?.user?.currency;
  if (directCurrency) return normalizeCurrency(directCurrency);

  const userId = req?.user?.id || req?.user?._id;
  if (userId && UserModel?.findById) {
    const user = await UserModel.findById(userId).select('currency').lean();
    if (user?.currency) return normalizeCurrency(user.currency);
  }

  return normalizeCurrency(fallbackCurrency);
};

const lineTotal = (item) =>
  (Number(item?.price) || 0) * (Number(item?.quantity) || 0);

const buildIdSet = (ids) =>
  ids instanceof Set ? ids : new Set((ids || []).map(toId));

// Order item seller snapshots are immutable ownership evidence. The current
// product owner is only a compatibility fallback for legacy lines that were
// created before seller snapshots were stored.
const itemBelongsToSeller = (item, sellerId, sellerProductIds = []) => {
  const snapshotSellerId = toId(item?.seller);
  if (snapshotSellerId) return snapshotSellerId === toId(sellerId);
  return buildIdSet(sellerProductIds).has(toId(item?.productId));
};

const orderItemsSubtotal = (order, predicate = () => true) =>
  (order?.orderItems || []).reduce((sum, item) => (
    predicate(item) ? sum + lineTotal(item) : sum
  ), 0);

const orderSubtotal = (order) => {
  const summarySubtotal = Number(order?.orderSummary?.subtotal);
  return Number.isFinite(summarySubtotal) && summarySubtotal > 0
    ? summarySubtotal
    : orderItemsSubtotal(order);
};

const convertOrderAmount = async (order, amount, targetCurrency = 'USD') =>
  convertAmount(amount, getOrderCurrency(order, targetCurrency), targetCurrency);

const convertOrderTotal = async (order, targetCurrency = 'USD') =>
  convertOrderAmount(order, Number(order?.orderSummary?.totalAmount) || 0, targetCurrency);

const sellerOrderSubtotal = (order, sellerProductIds, sellerId) => {
  const idSet = buildIdSet(sellerProductIds);
  return orderItemsSubtotal(order, item => (
    sellerId
      ? itemBelongsToSeller(item, sellerId, idSet)
      : idSet.has(toId(item?.productId))
  ));
};

const sellerOrderUnits = (order, sellerProductIds, sellerId) => {
  const idSet = buildIdSet(sellerProductIds);
  return (order?.orderItems || []).reduce((sum, item) => (
    (sellerId
      ? itemBelongsToSeller(item, sellerId, idSet)
      : idSet.has(toId(item?.productId)))
      ? sum + (Number(item.quantity) || 0)
      : sum
  ), 0);
};

const sellerShippingAmount = (order, sellerId) => {
  const sellerShipping = (order?.sellerShipping || []).find(
    ss => toId(ss.seller) === toId(sellerId)
  );
  return Number(sellerShipping?.shippingMethod?.price) || 0;
};

const sellerOrderSummary = (order, sellerProductIds, sellerId) => {
  const subtotal = sellerOrderSubtotal(order, sellerProductIds, sellerId);
  const totalOrderSubtotal = orderSubtotal(order);
  const sellerProportion = totalOrderSubtotal > 0 ? subtotal / totalOrderSubtotal : 0;
  const tax = (Number(order?.orderSummary?.tax) || 0) * sellerProportion;
  const shipping = sellerShippingAmount(order, sellerId);

  return {
    subtotal: roundMoney(subtotal),
    shippingCost: roundMoney(shipping),
    tax: roundMoney(tax),
    totalAmount: roundMoney(subtotal + shipping + tax),
  };
};

const sellerOrderSummaryInCurrency = async (order, sellerProductIds, sellerId, targetCurrency = 'USD') => {
  const summary = sellerOrderSummary(order, sellerProductIds, sellerId);
  const [subtotal, shippingCost, tax, totalAmount] = await Promise.all([
    convertOrderAmount(order, summary.subtotal, targetCurrency),
    convertOrderAmount(order, summary.shippingCost, targetCurrency),
    convertOrderAmount(order, summary.tax, targetCurrency),
    convertOrderAmount(order, summary.totalAmount, targetCurrency),
  ]);

  return { subtotal, shippingCost, tax, totalAmount };
};

const formatOrderMoney = (amount, currency) =>
  formatMoneySync(amount, normalizeCurrency(currency), { sourceCurrency: normalizeCurrency(currency) });

module.exports = {
  roundMoney,
  toId,
  getOrderCurrency,
  getRequestedCurrency,
  resolveRequestedCurrency,
  lineTotal,
  itemBelongsToSeller,
  orderItemsSubtotal,
  orderSubtotal,
  convertOrderAmount,
  convertOrderTotal,
  sellerOrderSubtotal,
  sellerOrderUnits,
  sellerOrderSummary,
  sellerOrderSummaryInCurrency,
  formatOrderMoney,
};
