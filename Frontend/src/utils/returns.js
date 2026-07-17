export const RETURN_STATUS_LABELS = Object.freeze({
  requested: 'Return requested',
  approved: 'Return approved',
  pickup_scheduled: 'Pickup scheduled',
  picked_up: 'Picked up',
  in_transit_to_seller: 'On the way to seller',
  received_by_seller: 'Received by seller',
  under_review: 'Seller is reviewing',
  accepted_pending_payment: 'Accepted - refund payment pending',
  returned: 'Returned - wallet refund issued',
  replacement_approved: 'Replacement approved',
  rejected: 'Return rejected',
  cancelled_by_buyer: 'Cancelled by buyer',
});

export const RETURN_STATUS_TRANSITIONS = Object.freeze({
  requested: ['approved', 'rejected'],
  approved: ['pickup_scheduled', 'picked_up', 'rejected'],
  pickup_scheduled: ['picked_up', 'rejected'],
  picked_up: ['in_transit_to_seller'],
  in_transit_to_seller: ['received_by_seller'],
  received_by_seller: ['under_review'],
  under_review: ['rejected'],
});

export const BUYER_CANCELLABLE_RETURN_STATUSES = new Set([
  'requested',
  'approved',
  'pickup_scheduled',
]);

export const returnStatusTone = (status) => {
  if (['returned', 'replacement_approved'].includes(status)) {
    return { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 38%)' };
  }
  if (['rejected', 'cancelled_by_buyer'].includes(status)) {
    return { background: 'rgba(239, 68, 68, 0.1)', color: 'hsl(0, 72%, 52%)' };
  }
  if (status === 'accepted_pending_payment') {
    return { background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(38, 85%, 42%)' };
  }
  return { background: 'rgba(59, 130, 246, 0.1)', color: 'hsl(215, 75%, 50%)' };
};

export const returnResolutionLabel = (refundType) => ({
  full_refund: 'Rozare Wallet refund',
  store_credit: 'Rozare Wallet credit',
  replacement_only: 'Replacement only',
}[refundType] || 'Seller resolution');
