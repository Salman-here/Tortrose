'use strict';
const Operation = require('../models/SafepayBillingOperation');
const Payment = require('../models/SafepayPayment');
const { META_ADS_ADDON_CENTS } = require('./subscriptionPricingService');
const { proratedPlanChange } = require('./safepayBillingMath');
const id = value => String(value?._id || value || '');
const fail = () => Object.assign(new Error('The funded Meta add-on amount could not be verified. Contact support before changing this add-on.'),
  { code: 'SUBSCRIPTION_META_CREDIT_FUNDING_INVALID', statusCode: 409 });
const money = value => { if (!Number.isSafeInteger(value) || value < 0) throw fail(); return value; };
const second = value => { const n = new Date(value).getTime(); if (!value || !Number.isFinite(n)) throw fail(); return Math.floor(n / 1000); };

function metaFundingAllowance(operation) {
  const t = operation.terms || {};
  if (t.includeMetaAds !== true || t.plan !== 'elite') throw fail();
  let addon = t.metaAddonMinor;
  // Verified prepatch Elite -> Elite+Meta invoices freeze both rates. Their
  // difference is the original $4 add-on, without rewriting historical money.
  if (addon === undefined && operation.kind === 'upgrade' && t.sourcePlan === 'elite' && !t.sourceMetaAds
    && money(t.monthlyMinor) - money(t.sourceMonthlyMinor) === META_ADS_ADDON_CENTS) addon = META_ADS_ADDON_CENTS;
  money(addon);
  if (!addon || addon > money(t.monthlyMinor)) throw fail();
  const gross = money(t.grossMinor), due = money(t.dueMinor), credited = money(t.appliedCreditMinor || 0);
  if (due + credited !== gross) throw fail();
  if (t.trialDays > 0) {
    if (gross !== 0 || due !== 0 || operation.kind !== 'enrollment') throw fail();
    return { addonMonthlyMinor: addon, allowanceMinor: 0 };
  }
  if (['enrollment', 'renewal'].includes(operation.kind)) {
    if (gross !== t.monthlyMinor) throw fail();
    return { addonMonthlyMinor: addon, allowanceMinor: addon };
  }
  if (operation.kind !== 'upgrade' || t.sourceMetaAds || !t.proration) throw fail();
  const p = t.proration;
  const component = proratedPlanChange({ sourceMinor: t.monthlyMinor - addon, targetMinor: t.monthlyMinor,
    periodStart: p.periodStart, periodEnd: p.periodEnd, at: p.calculatedAt });
  return { addonMonthlyMinor: addon, allowanceMinor: Math.min(gross, component.dueMinor) };
}

async function currentMetaFunding(sub, environment, session = null) {
  const op = await Operation.findOne({ seller: sub.seller, subscription: sub._id, environment, status: 'applied',
    'terms.includeMetaAds': true, $or: [{ _id: sub.safepayBilling.contractId, kind: 'enrollment' },
      { 'terms.sourceContractId': sub.safepayBilling.contractId }] }).sort({ appliedAt: -1 }).session(session);
  if (!op?.acceptedAt || !op.appliedAt || op.terms.monthlyMinor !== sub.safepayBilling.monthlyMinor) throw fail();
  const start = op.kind === 'enrollment' ? op.acceptedAt : op.terms.proration?.periodStart || op.terms.periodStart;
  if (second(start) !== second(sub.currentPeriodStart)) throw fail();
  const funding = metaFundingAllowance(op);
  if (op.terms.dueMinor > 0) {
    const payment = await Payment.findOne({ _id: op.payment, user: sub.seller, environment,
      purpose: 'subscription', status: 'paid', appliedAt: { $ne: null }, riskPending: false }).session(session);
    if (!payment || payment.amountMinor !== op.terms.dueMinor || payment.capturedMinor !== payment.amountMinor
      || payment.refundedMinor !== 0 || payment.currency !== 'USD' || id(payment.terms?.billingOperationId) !== id(op)) throw fail();
  }
  return { ...funding, operationId: id(op) };
}

function capMetaCredit(proration, funding) {
  const raw = money(proration.creditMinor), allowance = money(funding.allowanceMinor);
  const creditMinor = Math.min(raw, allowance);
  return { ...proration, creditMinor, metaCreditFunding: { version: 1, operationId: funding.operationId,
    addonMonthlyMinor: money(funding.addonMonthlyMinor), allowanceMinor: allowance, rawCreditMinor: raw,
    roundingCapMinor: raw - creditMinor } };
}
const unboundedMetaQuote = operation => operation.kind === 'meta_removal' && operation.terms?.creditMinor > 0
  && operation.terms.proration?.metaCreditFunding?.version !== 1;

async function verifyMetaCreditQuote(operation, sub, environment, session) {
  if (operation.kind !== 'meta_removal' || !operation.terms?.proration?.metaCreditFunding) return;
  const t = operation.terms, p = t.proration, funding = await currentMetaFunding(sub, environment, session);
  const raw = proratedPlanChange({ sourceMinor: money(t.sourceMonthlyMinor), targetMinor: money(t.monthlyMinor),
    periodStart: p.periodStart, periodEnd: p.periodEnd, at: p.calculatedAt });
  const expected = capMetaCredit(raw, funding);
  if (t.sourceMonthlyMinor !== sub.safepayBilling.monthlyMinor || t.creditMinor !== expected.creditMinor
    || p.creditMinor !== expected.creditMinor || Object.entries(expected.metaCreditFunding)
      .some(([key, value]) => p.metaCreditFunding[key] !== value)) throw fail();
}
module.exports = { metaFundingAllowance, currentMetaFunding, capMetaCredit, unboundedMetaQuote, verifyMetaCreditQuote };
