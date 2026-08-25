export const resolveSubdomainOwnershipTerms = (value) => {
  const directMinor = value?.priceMinor;
  const legacyMajor = value?.price;
  const hasDirectMinor = Number.isSafeInteger(directMinor) && directMinor >= 0;
  const amountMinor = hasDirectMinor
    ? directMinor
    : (typeof legacyMajor === 'number'
      && Number.isFinite(legacyMajor)
      && legacyMajor >= 0
      && Number.isSafeInteger(Math.round(legacyMajor * 100))
      && Math.round(legacyMajor * 100) / 100 === legacyMajor
      ? Math.round(legacyMajor * 100)
      : null);
  const currency = typeof value?.priceCurrency === 'string'
    ? value.priceCurrency.trim().toUpperCase()
    : (!hasDirectMinor && amountMinor !== null ? 'USD' : '');
  const years = Number.isSafeInteger(value?.ownershipYears) && value.ownershipYears > 0
    ? value.ownershipYears
    : null;
  if (amountMinor === null || currency !== 'USD' || years === null) return null;
  return {
    amountMinor,
    currency,
    years,
    priceLabel: `${new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100)} ${currency}`,
  };
};

const validDateOrNull = (value) => (
  value === null
  || (typeof value === 'string' && Number.isFinite(new Date(value).getTime()))
  || (value instanceof Date && Number.isFinite(value.getTime()))
);

export const subdomainOwnershipResponseIsValid = (value) => {
  const state = value?.ownership;
  const slug = value?.subdomain;
  if (
    !resolveSubdomainOwnershipTerms(value)
    || typeof slug !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(slug)
    || value?.url !== `${slug}.rozare.com`
    || !state
    || typeof state.isPurchased !== 'boolean'
    || typeof state.isOwned !== 'boolean'
    || (state.isOwned && !state.isPurchased)
    || !validDateOrNull(state.purchasedAt)
    || !validDateOrNull(state.expiresAt)
    || !Number.isSafeInteger(state.daysRemaining)
    || state.daysRemaining < 0
    || (state.isOwned && (state.daysRemaining < 1 || !state.expiresAt))
    || (!state.isOwned && state.daysRemaining !== 0)
  ) return false;
  return true;
};
