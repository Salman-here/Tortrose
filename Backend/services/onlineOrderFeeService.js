'use strict';

const { toMinorUnits, fromMinorUnits, convertMoneyByRates, percentagePlusConvertedMoney, allocateMinorUnitsByWeights } = require('./moneyMath');
const { getFrozenSellerCurrencyMoney, getOrderExchangeRates } = require('./orderMoneyService');
const { isSupportedCurrency } = require('./currencyService');
const { isDeepStrictEqual } = require('node:util');

// Rozare's disclosed fixed deduction policy, not an assertion of a gateway's
// actual invoice or statutory tax liability. One fixed fee per checkout.
const POLICY_VERSION = 1;
const RATE_BPS = 620;
const FIXED_PKR_MINOR = 3000;
const fail = message => Object.assign(new Error(message), { code: 'ONLINE_FEE_SNAPSHOT_INVALID', statusCode: 409 });
const id = value => String(value?._id || value || '');
const safe = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const proportionalMinor = (amount, part, whole) => {
  if (![amount, part, whole].every(safe) || part > whole) throw fail('Invalid online deduction allocation.');
  if (!whole) return 0;
  const result = Number((BigInt(amount) * BigInt(part) * 2n + BigInt(whole)) / (2n * BigInt(whole)));
  if (!safe(result)) throw fail('Online deduction exceeds the supported money range.');
  return result;
};

function buildOnlineOrderFee(order) {
  if (!['safepay', 'wallet'].includes(order.paymentMethod)) return null;
  if (!isSupportedCurrency(order.currency)) throw fail('Unsupported online deduction currency.');
  const sellers = getFrozenSellerCurrencyMoney(order);
  if (!sellers?.length) throw fail('Online deductions require frozen seller allocations.');
  const grossMinor = toMinorUnits(order.orderSummary.totalAmount);
  if (!safe(grossMinor) || sellers.reduce((sum, row) => sum + row.buyerTotalMinor, 0) !== grossMinor) {
    throw fail('Online deduction does not reconcile with the checkout.');
  }
  const rates = getOrderExchangeRates(order);
  if (order.currency !== 'PKR' && (!rates || !(rates.PKR > 0) || !(rates[order.currency] > 0))) {
    throw fail('The checkout PKR exchange rate is required for the fixed deduction.');
  }
  const fixedMinor = grossMinor === 0 ? 0 : order.currency === 'PKR' ? FIXED_PKR_MINOR
    : toMinorUnits(convertMoneyByRates(fromMinorUnits(FIXED_PKR_MINOR), rates.PKR, rates[order.currency]));
  const percentageMinor = Number((BigInt(grossMinor) * BigInt(RATE_BPS) + 5000n) / 10000n);
  const combinedMinor = grossMinor === 0 ? 0 : toMinorUnits(percentagePlusConvertedMoney(fromMinorUnits(grossMinor), RATE_BPS / 100,
    fromMinorUnits(FIXED_PKR_MINOR), order.currency === 'PKR' ? 1 : rates.PKR, order.currency === 'PKR' ? 1 : rates[order.currency]));
  const feeMinor = Math.min(grossMinor, combinedMinor);
  if (![percentageMinor, fixedMinor, feeMinor].every(safe)) throw fail('Invalid online deduction total.');
  const shares = allocateMinorUnitsByWeights(feeMinor, sellers.map(row => ({ key: row.seller, weight: row.buyerTotalMinor })));
  return { version: POLICY_VERSION, rateBps: RATE_BPS, fixedCurrency: 'PKR', fixedPkrMinor: FIXED_PKR_MINOR,
    currency: order.currency, grossMinor, fixedMinor, percentageMinor, roundingMinor: combinedMinor - fixedMinor - percentageMinor, feeMinor,
    sellers: sellers.map(row => ({ seller: row.seller, currency: row.currency, grossMinor: row.totalMinor,
      buyerGrossMinor: row.buyerTotalMinor, buyerFeeMinor: shares.get(row.seller),
      feeMinor: proportionalMinor(row.totalMinor, shares.get(row.seller), row.buyerTotalMinor) })) };
}

function getOnlineOrderFee(order) {
  // Existing orders keep their original terms. No retroactive fee migration.
  if (order.onlineFeeSnapshot === undefined || order.onlineFeeSnapshot === null) return null;
  const stored = order.onlineFeeSnapshot;
  const expected = buildOnlineOrderFee(order);
  if (!expected || !isDeepStrictEqual(stored, expected)) {
    throw fail('The saved online deduction does not match the original checkout.');
  }
  return expected;
}

function sellerOnlineFee(order, sellerId) {
  const snapshot = getOnlineOrderFee(order);
  if (!snapshot) return null;
  const row = snapshot.sellers.find(entry => entry.seller === id(sellerId));
  if (!row) throw fail('The seller does not own an online deduction allocation.');
  return { version: POLICY_VERSION, ...row };
}

module.exports = { POLICY_VERSION, RATE_BPS, FIXED_PKR_MINOR, buildOnlineOrderFee, getOnlineOrderFee, sellerOnlineFee, proportionalMinor };
