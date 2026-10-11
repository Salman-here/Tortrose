'use strict';
const { normalizeProductReturnPolicy, normalizeReturnPolicy } = require('./returnPolicyService');
const POLICY_FIELDS = ['returnsEnabled', 'returnDuration', 'refundType', 'policyDescription',
  'warrantyEnabled', 'warrantyDuration', 'warrantyDescription'];

// AI writes a product-specific policy object, not a form with an implicit
// checked "inherit store" control. Explicit custom terms must override the
// store; omitted fields in an edit retain the currently effective policy.
function normalizeAIProductReturnPolicy(value, { previousPolicy = {}, storePolicy = {} } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Product return policy must be a structured object.');
  }
  if (Object.hasOwn(value, 'useStorePolicy') && typeof value.useStorePolicy !== 'boolean') {
    throw new Error('Choose whether this product inherits its store policy using true or false.');
  }
  const hasCustomTerms = POLICY_FIELDS.some(field => Object.hasOwn(value, field));
  const useStorePolicy = Object.hasOwn(value, 'useStorePolicy') ? value.useStorePolicy
    : hasCustomTerms ? false : previousPolicy.useStorePolicy !== false;
  const effectivePrevious = previousPolicy.useStorePolicy === false ? previousPolicy : storePolicy;
  const base = useStorePolicy ? previousPolicy : effectivePrevious;
  return normalizeProductReturnPolicy({ ...base, ...value, useStorePolicy }, { strict: true });
}
const effectiveAIProductReturnPolicy = (productPolicy, storePolicy) => normalizeReturnPolicy(
  productPolicy?.useStorePolicy === false ? productPolicy : storePolicy || {},
);
module.exports = { normalizeAIProductReturnPolicy, effectiveAIProductReturnPolicy };
