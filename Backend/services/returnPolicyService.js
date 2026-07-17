'use strict';

const RETURN_REFUND_TYPES = Object.freeze([
  'none',
  'full_refund',
  'replacement_only',
  'store_credit',
]);

const RETURN_STATUS_LABELS = Object.freeze({
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

const RETURN_STATUS_TRANSITIONS = Object.freeze({
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

const cleanText = (value, maxLength) => String(value || '').trim().slice(0, maxLength);

const returnPolicyError = (message, code) => {
  const error = new Error(message);
  error.status = 400;
  error.statusCode = 400;
  error.code = code;
  return error;
};

const normalizeRefundType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return RETURN_REFUND_TYPES.includes(normalized) ? normalized : 'none';
};

const normalizeReturnPolicy = (value = {}, { strict = false } = {}) => {
  if (strict && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw returnPolicyError('Return policy must be a structured object.', 'INVALID_RETURN_POLICY');
  }

  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const returnsEnabled = source.returnsEnabled === true;
  const returnDuration = Math.trunc(Number(source.returnDuration) || 0);
  const refundType = normalizeRefundType(source.refundType);
  const warrantyEnabled = source.warrantyEnabled === true;
  const warrantyDuration = Math.trunc(Number(source.warrantyDuration) || 0);

  if (strict && returnsEnabled) {
    if (returnDuration < 1 || returnDuration > 365) {
      throw returnPolicyError('Return window must be between 1 and 365 days.', 'INVALID_RETURN_WINDOW');
    }
    if (refundType === 'none') {
      throw returnPolicyError('Choose a refund or replacement resolution when returns are enabled.', 'INVALID_RETURN_RESOLUTION');
    }
  }

  if (strict && warrantyEnabled && (warrantyDuration < 1 || warrantyDuration > 120)) {
    throw returnPolicyError('Warranty duration must be between 1 and 120 months.', 'INVALID_WARRANTY_WINDOW');
  }

  return {
    returnsEnabled,
    returnDuration: returnsEnabled ? Math.min(365, Math.max(0, returnDuration)) : 0,
    refundType: returnsEnabled ? refundType : 'none',
    warrantyEnabled,
    warrantyDuration: warrantyEnabled ? Math.min(120, Math.max(0, warrantyDuration)) : 0,
    warrantyDescription: cleanText(source.warrantyDescription, 200),
    policyDescription: cleanText(source.policyDescription, 500),
  };
};

const normalizeProductReturnPolicy = (value = {}, { strict = false } = {}) => {
  if (strict && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw returnPolicyError('Product return policy must be a structured object.', 'INVALID_PRODUCT_RETURN_POLICY');
  }

  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const useStorePolicy = source.useStorePolicy !== false;

  return {
    useStorePolicy,
    ...normalizeReturnPolicy(source, { strict: strict && !useStorePolicy }),
  };
};

const returnEligibilityDeadline = (deliveredAt, returnDuration) => {
  const delivered = new Date(deliveredAt);
  if (Number.isNaN(delivered.getTime())) return null;
  const days = Math.trunc(Number(returnDuration) || 0);
  if (days <= 0) return null;
  return new Date(delivered.getTime() + days * 24 * 60 * 60 * 1000);
};

const isReturnWindowOpen = (deliveredAt, returnDuration, at = new Date()) => {
  const deadline = returnEligibilityDeadline(deliveredAt, returnDuration);
  return !!deadline && new Date(at).getTime() <= deadline.getTime();
};

const canTransitionReturnStatus = (currentStatus, nextStatus) =>
  (RETURN_STATUS_TRANSITIONS[currentStatus] || []).includes(nextStatus);

module.exports = {
  RETURN_REFUND_TYPES,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_TRANSITIONS,
  normalizeRefundType,
  normalizeReturnPolicy,
  normalizeProductReturnPolicy,
  returnEligibilityDeadline,
  isReturnWindowOpen,
  canTransitionReturnStatus,
};
