'use strict';

// Shared by manual settings and AI. Only a completed currency switch starts
// the cooldown; abandoned previews/pending conversions must not lock a seller.
const DEFAULT_COOLDOWN_DAYS = 60;
const formatCurrencyChangeDate = value => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'UTC', timeZoneName: 'short',
}).format(new Date(value));
function storeCurrencyChangeLimit(store, now = Date.now()) {
  const raw = process.env.STORE_CURRENCY_CHANGE_COOLDOWN_DAYS;
  const days = raw === undefined ? DEFAULT_COOLDOWN_DAYS : Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    const error = new Error('Store currency change policy is unavailable. Please try again later.');
    error.status = 503;
    error.code = 'STORE_CURRENCY_POLICY_INVALID';
    throw error;
  }
  const last = store?.lastProductCurrencyChangeAt;
  const lastMs = last == null ? null : new Date(last).getTime();
  if (lastMs !== null && !Number.isFinite(lastMs)) {
    const error = new Error('Store currency change history is invalid. Please contact support.');
    error.status = 409;
    error.code = 'STORE_CURRENCY_HISTORY_INVALID';
    throw error;
  }
  const nextMs = lastMs === null ? null : lastMs + days * 86400000;
  return {
    cooldownDays: days,
    canChange: nextMs === null || now >= nextMs,
    lastChangedAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    nextAllowedAt: nextMs === null ? null : new Date(nextMs).toISOString(),
    daysRemaining: nextMs === null ? 0 : Math.max(0, Math.ceil((nextMs - now) / 86400000)),
  };
}

function assertStoreCurrencyChangeAllowed(store, now = Date.now()) {
  if (store?.isActive === false) {
    const error = new Error('Your store is blocked. Store currency cannot be changed while it is blocked.');
    error.status = 403;
    error.code = 'STORE_BLOCKED';
    throw error;
  }
  const limit = storeCurrencyChangeLimit(store, now);
  if (!limit.canChange) {
    const error = new Error(`Your store currency can be changed again on ${formatCurrencyChangeDate(limit.nextAllowedAt)} (${limit.daysRemaining} day(s) remaining). Currency changes have a ${limit.cooldownDays}-day waiting period.`);
    error.status = 409;
    error.code = 'STORE_CURRENCY_CHANGE_COOLDOWN';
    error.changeLimit = limit;
    throw error;
  }
  return limit;
}

module.exports = { storeCurrencyChangeLimit, assertStoreCurrencyChangeAllowed, formatCurrencyChangeDate };
