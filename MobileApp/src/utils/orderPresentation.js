export const ORDER_STAGES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

export const ACTIVE_ORDER_STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped']);

export const normalizeOrderStatus = (status) => {
  const value = String(status || 'pending').toLowerCase();
  return [...ORDER_STAGES, 'cancelled'].includes(value) ? value : 'pending';
};

export const getOrderDisplayId = (order) => {
  const raw = String(order?.orderId || order?._id || '').trim();
  if (!raw) return 'Order';
  return raw.startsWith('#') ? raw : `#${raw}`;
};

export const getOrderItemCount = (order) => (order?.orderItems || []).reduce((total, item) => {
  const quantity = Number(item?.quantity || item?.qty || 1);
  return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1);
}, 0);

export const getOrderTotal = (order) => {
  const summary = order?.orderSummary || {};
  if (summary.totalAmount !== null && summary.totalAmount !== undefined && Number.isFinite(Number(summary.totalAmount))) {
    return Number(summary.totalAmount);
  }
  const subtotal = Number(summary.subtotal || 0);
  const shipping = Number(summary.shippingCost || 0);
  const tax = Number(summary.tax || 0);
  const discount = Number(summary.couponDiscount || 0);
  return Math.max(0, subtotal + shipping + tax - discount);
};

export const getOrderLeadItem = (order) => (order?.orderItems || [])[0] || null;

export const formatOrderItemOptions = (item) => {
  const values = [];
  if (item?.selectedColor) values.push(`Color: ${item.selectedColor}`);
  const options = item?.selectedOptions;
  if (options && typeof options === 'object') {
    Object.entries(options).forEach(([name, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        values.push(`${name}: ${value}`);
      }
    });
  }
  return values.join('  •  ');
};

export const getEstimatedDeliveryDate = (order) => {
  if (!order?.createdAt) return null;
  const sellerDays = (order.sellerShipping || [])
    .map((entry) => Number(entry?.shippingMethod?.estimatedDays))
    .filter((days) => Number.isFinite(days) && days > 0);
  const primaryDays = Number(order?.shippingMethod?.estimatedDays);
  const estimatedDays = sellerDays.length
    ? Math.max(...sellerDays)
    : (Number.isFinite(primaryDays) && primaryDays > 0 ? primaryDays : 7);
  const estimate = new Date(order.createdAt);
  if (Number.isNaN(estimate.getTime())) return null;
  estimate.setDate(estimate.getDate() + estimatedDays);
  return estimate;
};

export const getOrderProgress = (status) => {
  const normalized = normalizeOrderStatus(status);
  if (normalized === 'cancelled') return 0;
  const index = ORDER_STAGES.indexOf(normalized);
  return index < 0 ? 1 : index + 1;
};

export const canCancelOrder = (orderOrStatus) => {
  if (orderOrStatus === null || orderOrStatus === undefined || orderOrStatus === '') return false;
  const order = typeof orderOrStatus === 'string'
    ? { orderStatus: orderOrStatus }
    : (orderOrStatus || {});
  const rawStatus = order.orderStatus || order.status;
  if (!rawStatus || ![...ORDER_STAGES, 'cancelled'].includes(String(rawStatus).toLowerCase())) return false;
  const status = normalizeOrderStatus(rawStatus);
  const fulfillmentStarted = (order.sellerFulfillment || []).some((entry) =>
    ['shipped', 'delivered'].includes(normalizeOrderStatus(entry?.status)));
  return ['pending', 'confirmed', 'processing'].includes(status)
    && !order.isPaid
    && !order.isDelivered
    && !fulfillmentStarted;
};

export const filterOrders = (orders, { search = '', status = 'all', payment = 'all' } = {}) => {
  const term = String(search || '').trim().toLowerCase();
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const normalizedStatus = normalizeOrderStatus(order?.orderStatus || order?.status);
    const statusMatches = status === 'all'
      || (status === 'active' && ACTIVE_ORDER_STATUSES.has(normalizedStatus))
      || normalizedStatus === status;
    const paymentMatches = payment === 'all'
      || (payment === 'paid' && !!order?.isPaid)
      || (payment === 'unpaid' && !order?.isPaid);
    if (!statusMatches || !paymentMatches) return false;
    if (!term) return true;
    const searchable = [
      order?.orderId,
      order?._id,
      order?.shippingInfo?.fullName,
      ...(order?.orderItems || []).map((item) => item?.name),
      ...(order?.sellerPolicies || []).map((policy) => policy?.storeName),
    ].filter(Boolean).join(' ').toLowerCase();
    return searchable.includes(term);
  });
};
