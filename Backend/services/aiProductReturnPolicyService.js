'use strict';
const { normalizeProductReturnPolicy, normalizeReturnPolicy } = require('./returnPolicyService');
const POLICY_FIELDS = ['returnsEnabled', 'returnDuration', 'refundType', 'policyDescription',
  'warrantyEnabled', 'warrantyDuration', 'warrantyDescription'];

// AI writes a product-specific policy object, not a form with an implicit
// checked "inherit store" control. Explicit custom terms must override the
// store; omitted fields in an edit retain the currently effective policy.
function normalizeAIProductReturnPolicy(value, { previousPolicy = {}, storePolicy = {}, userText = '' } = {}) {
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
  const next = { ...base, ...value, useStorePolicy };
  const keepWarranty = /\b(?:keep|leave|preserve)\b[^.!?\n]{0,160}\bwarranty\b|\bwarranty\b[^.!?\n]{0,70}\b(?:unchanged|the same|as is)\b/i.test(userText);
  const changeWarranty = /\b(?:enable|disable|add|remove)\s+(?:(?:the|its|a)\s+){0,2}(?:\d+[- ]month\s+)?warranty\b|\b(?:change|set|update|extend(?:ing)?|shorten(?:ing)?)\s+(?:(?:the|its|product|my)\s+){0,3}warranty\b/i.test(userText);
  if (keepWarranty && !changeWarranty && !useStorePolicy) {
    const prior = normalizeReturnPolicy(effectivePrevious);
    for (const field of ['warrantyEnabled', 'warrantyDuration', 'warrantyDescription']) next[field] = prior[field];
  }
  return normalizeProductReturnPolicy(next, { strict: true });
}
const effectiveAIProductReturnPolicy = (productPolicy, storePolicy) => normalizeReturnPolicy(
  productPolicy?.useStorePolicy === false ? productPolicy : storePolicy || {},
);
module.exports = { normalizeAIProductReturnPolicy, effectiveAIProductReturnPolicy };
