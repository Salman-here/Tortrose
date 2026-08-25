export const normalizeCurrencyCode = (currency, fallback = 'USD') => {
  return String(currency || fallback).trim().toUpperCase();
};

export const SUPPORTED_CURRENCY_CODES = Object.freeze(['USD', 'PKR', 'EUR', 'GBP']);
const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCY_CODES);

export const EXCHANGE_RATE_LIVE_MAX_AGE_MS = 15 * 60 * 1000;
export const EXCHANGE_RATE_RETRY_MS = 60 * 1000;

export const normalizeCompleteExchangeRates = (rates) => {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return null;
  const normalized = {};
  for (const code of SUPPORTED_CURRENCY_CODES) {
    const raw = rates[code];
    if (
      raw === null
      || raw === undefined
      || typeof raw === 'boolean'
      || (typeof raw === 'string' && !raw.trim())
      || (typeof raw === 'object')
    ) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    normalized[code] = value;
  }
  // Every table in this application is quoted against USD. Accepting another
  // base here would make all cross-currency amounts look valid but be wrong.
  if (normalized.USD !== 1) return null;
  return normalized;
};

export const shouldRefreshExchangeRates = ({
  now = Date.now(),
  lastAttemptAt = 0,
  lastLiveAt = 0,
  maxLiveAgeMs = EXCHANGE_RATE_LIVE_MAX_AGE_MS,
  retryMs = EXCHANGE_RATE_RETRY_MS,
} = {}) => {
  const nowMs = Number(now);
  const attemptedAt = Number(lastAttemptAt);
  const liveAt = Number(lastLiveAt);
  if (!Number.isFinite(nowMs)) return false;
  const hasFreshLiveTable = Number.isFinite(liveAt)
    && liveAt > 0
    && liveAt <= nowMs
    && nowMs - liveAt < maxLiveAgeMs;
  if (hasFreshLiveTable) return false;
  return !Number.isFinite(attemptedAt)
    || attemptedAt <= 0
    || attemptedAt > nowMs
    || nowMs - attemptedAt >= retryMs;
};

export const currencyCodeIsSupported = (currency) => (
  SUPPORTED_CURRENCY_SET.has(normalizeCurrencyCode(currency, ''))
);

export const responseCurrencyMatchesRequest = (responseCurrency, requestedCurrency) => {
  const response = normalizeCurrencyCode(responseCurrency, '');
  const requested = normalizeCurrencyCode(requestedCurrency, '');
  return currencyCodeIsSupported(response)
    && currencyCodeIsSupported(requested)
    && response === requested;
};

export const checkoutHasUnsupportedCurrency = (sourceCurrencies) => (
  (sourceCurrencies || []).filter(Boolean).some((currency) => !currencyCodeIsSupported(currency))
);

export const currencyConversionRequiresRates = (sourceCurrency, targetCurrency) => (
  normalizeCurrencyCode(sourceCurrency) !== normalizeCurrencyCode(targetCurrency)
);

export const canSafelyConvertCurrency = (
  sourceCurrency,
  targetCurrency,
  { ratesFallback = true, ratesLoading = false } = {}
) => (
  !currencyConversionRequiresRates(sourceCurrency, targetCurrency)
  || (!ratesFallback && !ratesLoading)
);

export const assertSafeCurrencyConversion = (
  sourceCurrency,
  targetCurrency,
  { ratesFallback = true, ratesLoading = false } = {}
) => {
  if (!currencyCodeIsSupported(sourceCurrency) || !currencyCodeIsSupported(targetCurrency)) {
    throw new Error('Unsupported currency conversion.');
  }
  if (!canSafelyConvertCurrency(sourceCurrency, targetCurrency, { ratesFallback, ratesLoading })) {
    throw new Error('Live exchange rates are unavailable for this conversion.');
  }
};

export const checkoutRequiresCurrencyConversion = (sourceCurrencies, targetCurrency) => (
  (sourceCurrencies || [])
    .filter(Boolean)
    .some((sourceCurrency) => currencyConversionRequiresRates(sourceCurrency, targetCurrency))
);

export const checkoutRequiresTrustedRates = (sourceCurrencies, targetCurrency) => (
  normalizeCurrencyCode(targetCurrency) !== 'USD'
  || checkoutRequiresCurrencyConversion(sourceCurrencies, targetCurrency)
);

const MAX_DECIMAL_EXPONENT = 100;

// Number.MAX_SAFE_INTEGER minor units is not enough to guarantee that turning
// the value back into a JavaScript major-unit Number preserves every decimal
// unit. These are the inclusive round-trip-safe limits used by the backend.
const MAX_REVERSIBLE_MINOR_UNITS_BY_SCALE = Object.freeze([
  9007199254740991n,
  5629499534213120n,
  7036874417766400n,
  8796093022208000n,
  5497558138880000n,
  6871947673600000n,
  8589934592000000n,
]);

const validCurrencyScale = (decimals) => (
  typeof decimals === 'number'
  && Number.isInteger(decimals)
  && decimals >= 0
  && decimals <= 6
);

const reversibleMinorUnits = (minorUnits, decimals = 2) => {
  if (!validCurrencyScale(decimals)) return false;
  let value;
  if (typeof minorUnits === 'bigint') {
    value = minorUnits;
  } else if (typeof minorUnits === 'number' && Number.isSafeInteger(minorUnits)) {
    value = BigInt(minorUnits);
  } else {
    return false;
  }
  const magnitude = value < 0n ? -value : value;
  return magnitude <= MAX_REVERSIBLE_MINOR_UNITS_BY_SCALE[decimals];
};

const fromCurrencyMinorUnits = (minorUnits, decimals = 2) => {
  if (!reversibleMinorUnits(minorUnits, decimals)) return 0;
  return Number(minorUnits) / (10 ** decimals);
};

const tenTo = (exponent) => {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_DECIMAL_EXPONENT) {
    throw new RangeError('Currency precision is outside the supported range.');
  }
  return 10n ** BigInt(exponent);
};

const decimalParts = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (!text || text.length > 256 || !Number.isFinite(Number(text))) return null;

  // Parse the supplied decimal text directly. Converting a valid input string
  // to Number first can silently change a cent near the safe-integer boundary
  // before BigInt ever gets a chance to preserve it.
  const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if (!match) return null;

  const integer = match[2] || '0';
  const fraction = match[3] !== undefined ? match[3] : (match[4] || '');
  const exponent = Number(match[5] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) return null;

  return {
    sign: match[1] === '-' ? -1n : 1n,
    digits: BigInt(`${integer}${fraction}` || '0'),
    decimalPlaces: fraction.length - exponent,
  };
};

const decimalRational = (value) => {
  const parsed = decimalParts(value);
  if (!parsed) return null;
  if (parsed.decimalPlaces >= 0) {
    return { numerator: parsed.sign * parsed.digits, denominator: tenTo(parsed.decimalPlaces) };
  }
  return {
    numerator: parsed.sign * parsed.digits * tenTo(-parsed.decimalPlaces),
    denominator: 1n,
  };
};

const greatestCommonDivisor = (left, right) => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

const reduceRational = (numerator, denominator) => {
  if (denominator === 0n) return null;
  const normalizedNumerator = denominator < 0n ? -numerator : numerator;
  const normalizedDenominator = denominator < 0n ? -denominator : denominator;
  const divisor = greatestCommonDivisor(normalizedNumerator, normalizedDenominator) || 1n;
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
};

const addRationals = (left, right) => {
  const common = greatestCommonDivisor(left.denominator, right.denominator);
  const leftMultiplier = right.denominator / common;
  const rightMultiplier = left.denominator / common;
  return reduceRational(
    (left.numerator * leftMultiplier) + (right.numerator * rightMultiplier),
    left.denominator * leftMultiplier
  );
};

const rationalToMinorUnits = (numerator, denominator, decimals = 2) => {
  if (denominator === 0n || !validCurrencyScale(decimals)) return 0;
  const sign = numerator < 0n !== denominator < 0n ? -1n : 1n;
  const scaledNumerator = (numerator < 0n ? -numerator : numerator) * tenTo(decimals);
  const positiveDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = scaledNumerator / positiveDenominator;
  const remainder = scaledNumerator % positiveDenominator;
  const rounded = sign * (quotient + (remainder * 2n >= positiveDenominator ? 1n : 0n));
  const asNumber = Number(rounded);
  return reversibleMinorUnits(rounded, decimals) && Number.isSafeInteger(asNumber) ? asNumber : 0;
};

export const toCurrencyMinorUnits = (value, decimals = 2) => {
  if (!validCurrencyScale(decimals)) return 0;
  const parsed = decimalParts(value);
  if (!parsed) return 0;

  const shift = decimals - parsed.decimalPlaces;
  if (Math.abs(shift) > MAX_DECIMAL_EXPONENT) return 0;
  let magnitude;
  if (shift >= 0) {
    magnitude = parsed.digits * tenTo(shift);
  } else {
    const divisor = tenTo(-shift);
    const quotient = parsed.digits / divisor;
    const remainder = parsed.digits % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  const signed = parsed.sign * magnitude;
  const asNumber = Number(signed);
  return reversibleMinorUnits(signed, decimals) && Number.isSafeInteger(asNumber) ? asNumber : 0;
};

export const hasCurrencyAmount = (value) => toCurrencyMinorUnits(value) !== 0;

export const isFiniteJsonNumber = (value) => (
  typeof value === 'number' && Number.isFinite(value)
);

export const getProductSourceAmount = (product, field = 'price') => {
  const currentValue = product?.[field];
  if (typeof currentValue === 'number' && Number.isFinite(currentValue) && currentValue >= 0) {
    return currentValue;
  }
  const legacyField = field === 'discountedPrice' ? 'discountedPriceOriginal' : 'priceOriginal';
  const legacyValue = product?.[legacyField];
  return typeof legacyValue === 'number' && Number.isFinite(legacyValue) && legacyValue >= 0
    ? legacyValue
    : 0;
};

export const getEffectiveProductSourcePrice = (product) => {
  const price = getProductSourceAmount(product, 'price');
  const discountedPrice = getProductSourceAmount(product, 'discountedPrice');
  return discountedPrice > 0 && discountedPrice < price ? discountedPrice : price;
};

export const couponHasCurrencyAmount = (coupon = {}) => (
  (coupon.discountType === 'fixed' && hasCurrencyAmount(coupon.discountValue))
  || hasCurrencyAmount(coupon.minOrderAmount)
  || hasCurrencyAmount(coupon.maxDiscountAmount)
);

export const sellerAnalyticsMoneyIsValid = (analytics, targetCurrency) => {
  const responseCurrency = normalizeCurrencyCode(analytics?.currency, '');
  const requestedCurrency = normalizeCurrencyCode(targetCurrency, '');
  const moneyIsValid = (value) => (
    isFiniteJsonNumber(value)
    && value >= 0
    && roundCurrencyAmount(value) === value
  );
  const countIsValid = (value) => Number.isSafeInteger(value) && value >= 0;
  return currencyCodeIsSupported(responseCurrency)
    && currencyCodeIsSupported(requestedCurrency)
    && responseCurrency === requestedCurrency
    && moneyIsValid(analytics?.summary?.totalRevenue)
    && moneyIsValid(analytics?.summary?.avgOrderValue)
    && countIsValid(analytics?.summary?.paidOrders)
    && countIsValid(analytics?.summary?.totalUnitsSold)
    && Array.isArray(analytics?.revenueByDay)
    && analytics.revenueByDay.every((row) => moneyIsValid(row?.revenue) && countIsValid(row?.orders))
    && Array.isArray(analytics?.topProducts)
    && analytics.topProducts.every((row) => moneyIsValid(row?.revenue) && countIsValid(row?.sold))
    && Array.isArray(analytics?.categoryBreakdown)
    && analytics.categoryBreakdown.every((row) => countIsValid(row?.count))
    && Array.isArray(analytics?.statusBreakdown)
    && analytics.statusBreakdown.every((row) => countIsValid(row?.value));
};

export const selectAuthoritativeSellerMetrics = (metrics, targetCurrency = 'USD') => {
  const responseCurrency = normalizeCurrencyCode(metrics?.currency, '');
  const requestedCurrency = normalizeCurrencyCode(targetCurrency, '');
  const totalSales = metrics?.totalSales;
  const totalOrders = metrics?.totalOrders;
  const valid = currencyCodeIsSupported(responseCurrency)
    && currencyCodeIsSupported(requestedCurrency)
    && responseCurrency === requestedCurrency
    && typeof totalSales === 'number'
    && Number.isFinite(totalSales)
    && totalSales >= 0
    && roundCurrencyAmount(totalSales) === totalSales
    && Number.isSafeInteger(totalOrders)
    && totalOrders >= 0
    && (totalOrders > 0 || totalSales === 0);
  return valid ? { totalSales, totalOrders } : null;
};

export const selectAuthoritativeSellerRevenue = (metrics, targetCurrency = 'USD') => (
  selectAuthoritativeSellerMetrics(metrics, targetCurrency)?.totalSales ?? null
);

export const roundCurrencyAmount = (value, decimals = 2) => (
  fromCurrencyMinorUnits(toCurrencyMinorUnits(value, decimals), decimals)
);

export const addCurrencyAmounts = (...values) => (
  fromCurrencyMinorUnits(
    values.reduce((total, value) => total + BigInt(toCurrencyMinorUnits(value)), 0n)
  )
);

export const multiplyCurrencyAmount = (unitAmount, quantity) => {
  if (
    quantity === null
    || quantity === undefined
    || typeof quantity === 'boolean'
    || (typeof quantity === 'string' && quantity.trim() === '')
  ) return 0;
  const normalizedQuantity = Number(quantity);
  if (!Number.isSafeInteger(normalizedQuantity) || normalizedQuantity < 0) return 0;
  const minorUnits = BigInt(toCurrencyMinorUnits(unitAmount));
  const total = minorUnits * BigInt(normalizedQuantity);
  return fromCurrencyMinorUnits(total);
};

export const percentageCurrencyAmount = (amount, percentage) => {
  const amountRatio = decimalRational(amount);
  const percentageRatio = decimalRational(percentage);
  if (!amountRatio || !percentageRatio) return 0;
  return fromCurrencyMinorUnits(rationalToMinorUnits(
    amountRatio.numerator * percentageRatio.numerator,
    amountRatio.denominator * percentageRatio.denominator * 100n
  ));
};

export const convertCurrencyAmount = (amount, sourceCurrency, targetCurrency, rates = {}) => {
  const from = normalizeCurrencyCode(sourceCurrency);
  const to = normalizeCurrencyCode(targetCurrency);
  if (from === to) return roundCurrencyAmount(amount);

  const amountRatio = decimalRational(amount);
  const fromRate = decimalRational(rates?.[from]);
  const toRate = decimalRational(rates?.[to]);
  if (!amountRatio || !fromRate || !toRate || fromRate.numerator <= 0n || toRate.numerator <= 0n) return 0;

  return fromCurrencyMinorUnits(rationalToMinorUnits(
    amountRatio.numerator * toRate.numerator * fromRate.denominator,
    amountRatio.denominator * toRate.denominator * fromRate.numerator
  ));
};

// Convert the complete native-currency line, not an already rounded converted
// unit price. Cheap foreign-currency units can legitimately be below one cent
// in the target currency while their full quantity still has material value.
export const convertCurrencyLineAmount = (
  unitAmount,
  quantity,
  sourceCurrency,
  targetCurrency,
  rates = {}
) => convertCurrencyAmount(
  multiplyCurrencyAmount(unitAmount, quantity),
  sourceCurrency,
  targetCurrency,
  rates
);

export const allocateCurrencyAmount = (amount, weights = []) => {
  const totalMinor = Math.max(0, toCurrencyMinorUnits(amount));
  const normalizedWeights = (weights || []).map((weight) => BigInt(Math.max(0, toCurrencyMinorUnits(weight))));
  const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0n);
  if (!normalizedWeights.length || totalMinor === 0 || weightTotal <= 0n) {
    return normalizedWeights.map(() => 0);
  }

  const shares = normalizedWeights.map((weight, index) => {
    const weightedMinor = BigInt(totalMinor) * weight;
    return {
      index,
      floorMinor: weightedMinor / weightTotal,
      remainder: weightedMinor % weightTotal,
    };
  });
  let remaining = BigInt(totalMinor) - shares.reduce((sum, share) => sum + share.floorMinor, 0n);
  const rankedShares = [...shares].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const share of rankedShares) {
    if (remaining <= 0n) break;
    share.floorMinor += 1n;
    remaining -= 1n;
  }

  return shares
    .sort((a, b) => a.index - b.index)
    .map((share) => fromCurrencyMinorUnits(share.floorMinor));
};

// Mirrors Backend/services/checkoutPricingService.js and
// allocateConvertedMinorUnitsByRates. Target-native entries keep their exact
// cents. All foreign entries share one exact-rational conversion bucket, whose
// rounded target cents are then allocated with the same cap and tie-breaking
// rules as settlement. This is required for capped coupons as well as any
// checkout charge whose separately rounded values can drift by a cent.
export const allocateConvertedCurrencyAmounts = (
  entries = [],
  targetCurrency,
  rates = {}
) => {
  const target = normalizeCurrencyCode(targetCurrency);
  const normalized = (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const sourceAmount = Math.max(0, roundCurrencyAmount(entry?.sourceAmount));
    const maximumTargetAmount = entry?.maximumTargetAmount === null
      || entry?.maximumTargetAmount === undefined
      ? null
      : Math.max(0, roundCurrencyAmount(entry.maximumTargetAmount));
    const maximumAllocatedTargetAmount = entry?.maximumAllocatedTargetAmount === null
      || entry?.maximumAllocatedTargetAmount === undefined
      ? null
      : Math.max(0, roundCurrencyAmount(entry.maximumAllocatedTargetAmount));
    return {
      index,
      sourceAmount,
      sourceCurrency: normalizeCurrencyCode(entry?.sourceCurrency || target),
      maximumTargetAmount,
      maximumAllocatedTargetAmount,
    };
  });
  const allocations = normalized.map(() => 0);
  const targetRate = decimalRational(rates?.[target]);
  const foreign = [];

  normalized.forEach((entry) => {
    if (entry.sourceCurrency === target) {
      allocations[entry.index] = Math.min(
        entry.sourceAmount,
        entry.maximumTargetAmount ?? entry.sourceAmount,
        entry.maximumAllocatedTargetAmount ?? entry.sourceAmount
      );
      return;
    }

    const amount = decimalRational(entry.sourceAmount);
    const sourceRate = decimalRational(rates?.[entry.sourceCurrency]);
    if (
      !amount
      || amount.numerator < 0n
      || !sourceRate
      || sourceRate.numerator <= 0n
      || !targetRate
      || targetRate.numerator <= 0n
    ) return;

    let weight = reduceRational(
      amount.numerator * sourceRate.denominator * targetRate.numerator,
      amount.denominator * sourceRate.numerator * targetRate.denominator
    );
    const maximumExactMinor = entry.maximumTargetAmount === null
      ? null
      : Math.max(0, toCurrencyMinorUnits(entry.maximumTargetAmount));
    if (maximumExactMinor !== null) {
      const cap = { numerator: BigInt(maximumExactMinor), denominator: 100n };
      if (weight.numerator * cap.denominator > cap.numerator * weight.denominator) {
        weight = cap;
      }
    }
    foreign.push({
      ...entry,
      weight: reduceRational(weight.numerator, weight.denominator),
      maximumAllocationMinor: entry.maximumAllocatedTargetAmount === null
        ? null
        : Math.max(0, toCurrencyMinorUnits(entry.maximumAllocatedTargetAmount)),
    });
  });

  if (!foreign.length) return allocations;
  const totalWeight = foreign.reduce(
    (sum, entry) => addRationals(sum, entry.weight),
    { numerator: 0n, denominator: 1n }
  );
  let totalMinor = rationalToMinorUnits(totalWeight.numerator, totalWeight.denominator);
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) return allocations;

  const ranked = foreign.map((entry) => {
    const exactMinorNumerator = entry.weight.numerator * 100n;
    const floorMinor = exactMinorNumerator / entry.weight.denominator;
    const hasFraction = exactMinorNumerator % entry.weight.denominator > 0n;
    const naturalCeiling = floorMinor + (hasFraction ? 1n : 0n);
    const hardCap = entry.maximumAllocationMinor === null
      ? naturalCeiling
      : (BigInt(entry.maximumAllocationMinor) < naturalCeiling
        ? BigInt(entry.maximumAllocationMinor)
        : naturalCeiling);
    return {
      ...entry,
      baseMinor: floorMinor < hardCap ? floorMinor : hardCap,
      hardCap,
      remainderNumerator: exactMinorNumerator % entry.weight.denominator,
      remainderDenominator: entry.weight.denominator,
    };
  });
  const maximumAchievable = ranked.reduce((sum, entry) => sum + entry.hardCap, 0n);
  if (BigInt(totalMinor) > maximumAchievable) totalMinor = Number(maximumAchievable);
  let remaining = BigInt(totalMinor) - ranked.reduce((sum, entry) => sum + entry.baseMinor, 0n);
  ranked.sort((left, right) => {
    const leftCross = left.remainderNumerator * right.remainderDenominator;
    const rightCross = right.remainderNumerator * left.remainderDenominator;
    if (leftCross === rightCross) return left.index - right.index;
    return leftCross > rightCross ? -1 : 1;
  });
  const eligible = ranked.filter((entry) => entry.baseMinor < entry.hardCap);
  for (let index = 0; remaining > 0n && eligible.length; index += 1, remaining -= 1n) {
    eligible[index % eligible.length].baseMinor += 1n;
  }
  ranked.forEach((entry) => {
    allocations[entry.index] = fromCurrencyMinorUnits(entry.baseMinor);
  });
  return allocations;
};

// Match checkout settlement exactly. Target-native lines keep their already
// exact cents. Every foreign line is converted as a decimal rational, all
// foreign values are rounded globally once, and those target cents are then
// allocated by exact converted weights with original-order tie breaking.
export const convertCurrencyLineAmounts = (lines = [], targetCurrency, rates = {}) => {
  const target = normalizeCurrencyCode(targetCurrency);
  const targetRate = decimalRational(rates?.[target]);
  const normalizedLines = (Array.isArray(lines) ? lines : []).map((line, index) => ({
    index,
    sourceCurrency: normalizeCurrencyCode(line?.sourceCurrency),
    sourceLineSubtotal: Math.max(0, multiplyCurrencyAmount(line?.unitAmount, line?.quantity)),
  }));
  const converted = normalizedLines.map(() => 0);
  const foreignWeights = [];

  normalizedLines.forEach((line) => {
    if (line.sourceCurrency === target) {
      converted[line.index] = line.sourceLineSubtotal;
      return;
    }
    const amount = decimalRational(line.sourceLineSubtotal);
    const sourceRate = decimalRational(rates?.[line.sourceCurrency]);
    if (
      !amount
      || amount.numerator <= 0n
      || !sourceRate
      || sourceRate.numerator <= 0n
      || !targetRate
      || targetRate.numerator <= 0n
    ) return;
    const weight = reduceRational(
      amount.numerator * sourceRate.denominator * targetRate.numerator,
      amount.denominator * sourceRate.numerator * targetRate.denominator
    );
    if (weight?.numerator > 0n) foreignWeights.push({ ...line, weight });
  });

  if (!foreignWeights.length) return converted;
  const totalWeight = foreignWeights.reduce(
    (sum, line) => addRationals(sum, line.weight),
    { numerator: 0n, denominator: 1n }
  );
  const totalMinor = rationalToMinorUnits(totalWeight.numerator, totalWeight.denominator);
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return converted;

  const ranked = foreignWeights.map((line) => {
    const exactMinorNumerator = line.weight.numerator * 100n;
    return {
      ...line,
      baseMinor: exactMinorNumerator / line.weight.denominator,
      remainderNumerator: exactMinorNumerator % line.weight.denominator,
      remainderDenominator: line.weight.denominator,
    };
  });
  let remaining = BigInt(totalMinor) - ranked.reduce((sum, line) => sum + line.baseMinor, 0n);
  ranked.sort((left, right) => {
    const leftCross = left.remainderNumerator * right.remainderDenominator;
    const rightCross = right.remainderNumerator * left.remainderDenominator;
    if (leftCross === rightCross) return left.index - right.index;
    return leftCross > rightCross ? -1 : 1;
  });
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    ranked[index % ranked.length].baseMinor += 1n;
  }
  ranked.forEach((line) => {
    converted[line.index] = fromCurrencyMinorUnits(line.baseMinor);
  });

  return converted;
};

export const shouldRetainIdempotencyKey = (status) => {
  if (status === undefined || status === null || status === '') return true;
  const code = Number(status);
  return !Number.isFinite(code) || code === 408 || code === 409 || code === 429 || code >= 500;
};
