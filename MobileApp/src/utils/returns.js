export const returnGroupPolicyLabel = (group) => {
  const policies = (group?.items || []).map(item => item.returnPolicy || group?.policy).filter(Boolean);
  const signatures = new Set(policies.map(policy =>
    JSON.stringify([policy.returnsEnabled, policy.returnDuration, policy.refundType])));
  if (signatures.size > 1) return 'Item-specific return policies apply';
  const policy = policies[0] || group?.policy;
  return policy?.returnsEnabled
    ? `${policy.returnDuration}-day returns - ${returnResolutionLabel(policy.refundType)}`
    : 'Returns are not available for these ordered items';
};

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
  replacement_shipped: 'Replacement shipped',
  replacement_delivered: 'Replacement received',
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
  full_refund: 'Refund to Rozare Wallet',
  store_credit: 'Refund to Rozare Wallet',
  replacement_only: 'Replacement only',
}[value] || 'No return resolution');

export const returnStatusColor = (status, palette) => {
  if (['returned', 'replacement_delivered'].includes(status)) return palette.colors.success;
  if (['rejected', 'cancelled_by_buyer'].includes(status)) return palette.colors.error;
  if (status === 'accepted_pending_payment') return palette.colors.warning;
  return palette.colors.primary;
};

export const RETURN_RESOLUTION_CHOICES = Object.freeze([
  { value: 'full_refund', label: 'Refund to Rozare Wallet', title: 'Refund to Rozare Wallet', icon: 'wallet-outline', desc: 'Refund the original approved amount to the buyer’s Rozare Wallet.' },
  { value: 'replacement_only', label: 'Replacement only', title: 'Replacement only', icon: 'swap-horizontal-outline', desc: 'Replace the returned product without another buyer payment.' },
]);
export const editableReturnResolution = value => value === 'store_credit' ? 'full_refund' : value || 'none';
export const warrantyStatusLabel = status => ({ requested: 'Claim received', approved: 'Claim approved',
  rejected: 'Claim declined', returned: 'Wallet refund completed', under_review: 'Warranty inspection',
  accepted_pending_payment: 'Refund funding pending' }[status] || RETURN_STATUS_LABELS[status] || 'Claim update');
