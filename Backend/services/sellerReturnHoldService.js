'use strict';

const { buildSellerCurrencyItemMoneyAllocations } = require('./orderMoneyService');
const { toMinorUnits, fromMinorUnits, convertMoneyByRates } = require('./moneyMath');
const { returnEligibilityDeadline, isReturnWindowOpen } = require('./returnPolicyService');
const id = value => String(value?._id || value || '');
const ACTIVE_RETURN_STATUSES = new Set(['requested', 'approved', 'pickup_scheduled', 'picked_up',
  'in_transit_to_seller', 'received_by_seller', 'under_review', 'accepted_pending_payment']);

// Only checkout snapshots are consulted. Editing a store/product policy cannot
// shorten a purchased item's return window. All allocation arithmetic is cents.
function sellerReturnHold(order, sellerId, { returns = [], at = new Date(), remainingMinor = null } = {}) {
  const items = (order.orderItems || []).filter(item => id(item.seller) === id(sellerId));
  const money = buildSellerCurrencyItemMoneyAllocations(order, sellerId, items);
  if (!money) return { heldMinor: 0, items: [], activeReturn: false };
  const totalMinor = toMinorUnits(money.presentation.summary.totalAmount);
  const buyerMinor = toMinorUnits(money.presentation.buyerSummary.totalAmount);
  const fulfillment = (order.sellerFulfillment || []).find(row => id(row.seller) === id(sellerId));
  const deliveredAt = fulfillment?.deliveredAt || order.deliveredAt;
  const policy = (order.sellerPolicies || []).find(row => id(row.seller) === id(sellerId))?.returnPolicy;
  const relevant = returns.filter(row => id(row.order) === id(order) && id(row.seller) === id(sellerId));
  const active = relevant.filter(row => ACTIVE_RETURN_STATUSES.has(row.status));
  const completed = relevant.filter(row => row.status === 'returned');
  let heldMinor = 0;
  const details = items.map(item => {
    const key = money.itemKeys[(order.orderItems || []).indexOf(item)];
    const allocation = toMinorUnits(money.total.get(key) || 0);
    const frozen = item.returnPolicySnapshotVersion > 0 ? item.returnPolicy : policy;
    const returned = completed.reduce((sum, row) => sum + (row.items || [])
      .filter(line => id(line.orderItemId) === id(item)).reduce((n, line) => n + line.quantity, 0), 0);
    const requested = active.reduce((sum, row) => sum + (row.items || [])
      .filter(line => id(line.orderItemId) === id(item)).reduce((n, line) => n + line.quantity, 0), 0);
    const remaining = Math.max(0, item.quantity - returned);
    const enabled = frozen?.returnsEnabled === true;
    const windowOpen = enabled && (!deliveredAt || isReturnWindowOpen(deliveredAt, frozen.returnDuration, at));
    const quantity = windowOpen ? remaining : Math.min(remaining, requested);
    if (quantity) heldMinor += Number((BigInt(allocation) * BigInt(quantity) + BigInt(item.quantity - 1)) / BigInt(item.quantity));
    return { orderItemId: id(item), heldQuantity: quantity, returnWindowOpen: windowOpen,
      returnDeadline: enabled && deliveredAt ? returnEligibilityDeadline(deliveredAt, frozen.returnDuration) : null,
      activeReturn: requested > 0 };
  });
  // A partial return's frozen tax/discount/shipping allocation can differ from
  // the proportional item allocation. Never release the requested refund itself.
  const activeBuyerMinor = active.reduce((sum, row) => sum + toMinorUnits(row.refund?.totalAmount || 0), 0);
  const activeNativeMinor = activeBuyerMinor && buyerMinor
    ? toMinorUnits(convertMoneyByRates(fromMinorUnits(activeBuyerMinor), fromMinorUnits(buyerMinor), fromMinorUnits(totalMinor))) : 0;
  heldMinor = Math.min(remainingMinor ?? totalMinor, Math.max(heldMinor, activeNativeMinor));
  return { heldMinor: Math.max(0, heldMinor), items: details, activeReturn: active.length > 0 };
}

module.exports = { sellerReturnHold, ACTIVE_RETURN_STATUSES };
