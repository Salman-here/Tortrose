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

export const BUYER_CANCELLABLE_RETURN_STATUSES = new Set([
  'requested',
  'approved',
  'pickup_scheduled',
]);

export const RETURN_STATUS_TRANSITIONS = Object.freeze({
  requested: ['approved', 'rejected'],
  approved: ['pickup_scheduled', 'picked_up', 'rejected'],
  pickup_scheduled: ['picked_up', 'rejected'],
  picked_up: ['in_transit_to_seller'],
  in_transit_to_seller: ['received_by_seller'],
  received_by_seller: ['under_review'],
  under_review: ['rejected'],
  accepted_pending_payment: [],
  returned: [],
  replacement_approved: [],
  rejected: [],
  cancelled_by_buyer: [],
});

export const returnResolutionLabel = (value) => ({
  full_refund: 'Full refund to Rozare Wallet',
  store_credit: 'Rozare Wallet credit',
  replacement_only: 'Replacement only',
}[value] || 'No return resolution');

export const returnStatusColor = (status, palette) => {
  if (['returned', 'replacement_approved'].includes(status)) return palette.colors.success;
  if (['rejected', 'cancelled_by_buyer'].includes(status)) return palette.colors.error;
  if (status === 'accepted_pending_payment') return palette.colors.warning;
  return palette.colors.primary;
};
