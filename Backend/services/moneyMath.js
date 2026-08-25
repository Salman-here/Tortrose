'use strict';

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

// A safe integer minor-unit value is not automatically safe to expose as a
// JavaScript Number in major units. At sufficiently large magnitudes the IEEE
// 754 spacing becomes wider than one decimal unit (for example, adjacent cents
// can collapse to the same Number). These inclusive limits are the last power-
// of-two boundary at which every smaller unit remains distinguishable for the
// supported scale. Scale zero can use the full safe-integer range.
const MAX_REVERSIBLE_MINOR_UNITS_BY_SCALE = Object.freeze([
  9007199254740991n,
  5629499534213120n,
  7036874417766400n,
  8796093022208000n,
  5497558138880000n,
  6871947673600000n,
  8589934592000000n,
]);

const requireMoneyScale = scale => {
  const parsedScale = Number(scale);
  if (
    typeof scale !== 'number'
    || !Number.isInteger(parsedScale)
    || parsedScale < 0
    || parsedScale > 6
  ) {
    throw new RangeError('Money scale must be an integer between 0 and 6.');
  }
  return parsedScale;
};

const assertReversibleMinorUnits = (minor, scale) => {
  const absoluteMinor = minor < 0n ? -minor : minor;
  if (absoluteMinor > MAX_REVERSIBLE_MINOR_UNITS_BY_SCALE[scale]) {
    const error = new RangeError(
      'Money amount is too large to preserve every minor unit in decimal storage.'
    );
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
};

const invalidMoneyInput = (message = 'Money calculation input is invalid.') => {
  const error = new TypeError(message);
  error.code = 'MONEY_AMOUNT_INVALID';
  return error;
};

const parseDecimal = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > 256) return null;
  const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if (!match || !Number.isFinite(Number(text))) return null;
  const exponent = Number(match[5] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  return {
    negative: match[1] === '-',
    integer: match[2] || '0',
    fraction: match[3] !== undefined ? match[3] : (match[4] || ''),
    exponent,
  };
};

const decimalToFraction = (value) => {
  const parsed = parseDecimal(value);
  if (!parsed) return null;
  const unsignedDigits = BigInt(`${parsed.integer}${parsed.fraction}` || '0');
  const signedDigits = parsed.negative ? -unsignedDigits : unsignedDigits;
  const decimalScale = parsed.fraction.length - parsed.exponent;
  return decimalScale >= 0
    ? { numerator: signedDigits, denominator: 10n ** BigInt(decimalScale) }
    : { numerator: signedDigits * (10n ** BigInt(-decimalScale)), denominator: 1n };
};

const divideAndRound = (numerator, denominator) => {
  if (denominator === 0n) throw new RangeError('Cannot divide money by a zero rate.');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  let quotient = absoluteNumerator / absoluteDenominator;
  const remainder = absoluteNumerator % absoluteDenominator;
  if (remainder * 2n >= absoluteDenominator) quotient += 1n;
  return negative ? -quotient : quotient;
};

const greatestCommonDivisor = (left, right) => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

const addFractions = (left, right) => {
  const common = greatestCommonDivisor(left.denominator, right.denominator);
  const leftMultiplier = right.denominator / common;
  const rightMultiplier = left.denominator / common;
  const numerator = (left.numerator * leftMultiplier) + (right.numerator * rightMultiplier);
  const denominator = left.denominator * leftMultiplier;
  const divisor = greatestCommonDivisor(numerator, denominator) || 1n;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};

// Convert a decimal value to an integer without multiplying a binary float by
// 100. That avoids classic money errors such as Math.round(1.005 * 100) === 100.
// Values exactly halfway between minor units round away from zero.
const toMinorUnits = (value, scale = 2) => {
  const parsedScale = requireMoneyScale(scale);

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw invalidMoneyInput('Money amount must be a finite decimal value.');
  }

  const parsed = parseDecimal(value);
  if (!parsed) throw invalidMoneyInput('Money amount must be a valid decimal value.');

  const digits = `${parsed.integer}${parsed.fraction}`;
  const decimalPosition = parsed.integer.length + parsed.exponent;
  const scaledPosition = decimalPosition + parsedScale;
  let wholeDigits;
  let discardedDigits;

  if (scaledPosition <= 0) {
    wholeDigits = '0';
    discardedDigits = `${'0'.repeat(-scaledPosition)}${digits}`;
  } else if (scaledPosition >= digits.length) {
    wholeDigits = `${digits}${'0'.repeat(scaledPosition - digits.length)}`;
    discardedDigits = '';
  } else {
    wholeDigits = digits.slice(0, scaledPosition);
    discardedDigits = digits.slice(scaledPosition);
  }

  let minor = BigInt(wholeDigits || '0');
  if (discardedDigits && discardedDigits[0] >= '5') minor += 1n;
  if (parsed.negative) minor = -minor;

  assertReversibleMinorUnits(minor, parsedScale);
  return Number(minor);
};

const fromMinorUnits = (minorUnits, scale = 2) => {
  const parsedScale = requireMoneyScale(scale);
  if (typeof minorUnits !== 'number' || !Number.isSafeInteger(minorUnits)) {
    const error = new RangeError('Money minor-unit amount is not a safe integer.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  assertReversibleMinorUnits(BigInt(minorUnits), parsedScale);
  return minorUnits / (10 ** parsedScale);
};

const roundMoney = (value, scale = 2) => fromMinorUnits(toMinorUnits(value, scale), scale);

// Validate a stored decimal (for example, a provider-compatible percentage)
// through the same reversible integer boundary as money without coercing
// strings, booleans, or other scalar lookalikes. This is intentionally a
// predicate so persistence and notification validators can fail closed.
const isExactDecimalAtScale = (value, {
  scale = 2,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
} = {}) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || typeof min !== 'number'
    || !Number.isFinite(min)
    || typeof max !== 'number'
    || !Number.isFinite(max)
    || min > max
    || value < min
    || value > max
  ) return false;
  try {
    return roundMoney(value, scale) === value;
  } catch (_) {
    return false;
  }
};

// Sum decimal inputs before applying the requested minor-unit boundary. This
// preserves small remainders across large aggregates (three 0.004 entries are
// 0.012, not three independently rounded zeroes).
const sumMoney = (values = [], scale = 2) => {
  const parsedScale = requireMoneyScale(scale);
  if (!Array.isArray(values)) throw invalidMoneyInput('Money sum values must be an array.');
  const fractions = values.map(value => {
    const fraction = decimalToFraction(value);
    if (!fraction) throw invalidMoneyInput('Money sum contains an invalid decimal amount.');
    return fraction;
  });
  if (!fractions.length) return 0;

  let numerator = 0n;
  let denominator = 1n;
  for (const fraction of fractions) {
    const common = greatestCommonDivisor(denominator, fraction.denominator);
    const leftMultiplier = fraction.denominator / common;
    const rightMultiplier = denominator / common;
    numerator = (numerator * leftMultiplier) + (fraction.numerator * rightMultiplier);
    denominator *= leftMultiplier;
  }

  const minor = divideAndRound(numerator * (10n ** BigInt(parsedScale)), denominator);
  const absoluteMinor = minor < 0n ? -minor : minor;
  if (absoluteMinor > MAX_SAFE_MINOR_UNITS) {
    const error = new RangeError('Money amount is too large to calculate safely.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  return fromMinorUnits(Number(minor), parsedScale);
};

const multiplyMoney = (unitAmount, quantity, scale = 2) => {
  const multiplier = Number(quantity);
  if (
    typeof quantity !== 'number'
    || !Number.isSafeInteger(multiplier)
    || multiplier < 0
    || !decimalToFraction(unitAmount)
  ) {
    throw invalidMoneyInput('Money multiplication requires a valid amount and non-negative safe integer quantity.');
  }

  const result = BigInt(toMinorUnits(unitAmount, scale)) * BigInt(multiplier);
  const absoluteResult = result < 0n ? -result : result;
  if (absoluteResult > MAX_SAFE_MINOR_UNITS) {
    const error = new RangeError('Money amount is too large to calculate safely.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  return fromMinorUnits(Number(result), scale);
};

// Convert through a common-base rate table using decimal fractions throughout.
// This avoids binary division/multiplication changing which side of a half-cent
// boundary the result lands on.
const convertMoneyByRates = (amount, fromRate, toRate, scale = 2) => {
  const parsedScale = requireMoneyScale(scale);
  const amountFraction = decimalToFraction(amount);
  const fromFraction = decimalToFraction(fromRate);
  const toFraction = decimalToFraction(toRate);
  if (
    !amountFraction
    || !fromFraction
    || !toFraction
    || fromFraction.numerator <= 0n
    || toFraction.numerator <= 0n
  ) throw invalidMoneyInput('Currency conversion requires a valid amount and positive decimal rates.');

  const scaleFactor = 10n ** BigInt(parsedScale);
  const numerator = amountFraction.numerator
    * fromFraction.denominator
    * toFraction.numerator
    * scaleFactor;
  const denominator = amountFraction.denominator
    * fromFraction.numerator
    * toFraction.denominator;
  const minor = divideAndRound(numerator, denominator);
  const absoluteMinor = minor < 0n ? -minor : minor;
  if (absoluteMinor > MAX_SAFE_MINOR_UNITS) {
    const error = new RangeError('Money amount is too large to calculate safely.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  return fromMinorUnits(Number(minor), parsedScale);
};

const percentageOfMoney = (amount, percentage, scale = 2) => {
  const parsedScale = requireMoneyScale(scale);
  const amountFraction = decimalToFraction(amount);
  const percentageFraction = decimalToFraction(percentage);
  if (!amountFraction || !percentageFraction) {
    throw invalidMoneyInput('Percentage calculation requires valid decimal operands.');
  }

  const scaleFactor = 10n ** BigInt(parsedScale);
  const numerator = amountFraction.numerator * percentageFraction.numerator * scaleFactor;
  const denominator = amountFraction.denominator * percentageFraction.denominator * 100n;
  const minor = divideAndRound(numerator, denominator);
  const absoluteMinor = minor < 0n ? -minor : minor;
  if (absoluteMinor > MAX_SAFE_MINOR_UNITS) {
    const error = new RangeError('Money amount is too large to calculate safely.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  return fromMinorUnits(Number(minor), parsedScale);
};

const allocateMinorUnitsByFractionWeights = (
  totalMinorUnits,
  normalizedEntries,
  { fallbackToEqual = false } = {},
) => {
  const numericTotal = Number(totalMinorUnits);
  if (
    typeof totalMinorUnits !== 'number'
    || !Number.isSafeInteger(numericTotal)
    || numericTotal < 0
  ) {
    const error = new RangeError('Money minor-unit amount is not a safe integer.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  assertReversibleMinorUnits(BigInt(numericTotal), 2);
  const totalMinor = BigInt(numericTotal);
  const normalized = normalizedEntries || [];
  const allocations = new Map(normalized.map(entry => [entry.key, 0]));
  if (!normalized.length || totalMinor === 0n) return allocations;

  let weighted = normalized.filter(entry => entry.weight.numerator > 0n);
  if (!weighted.length) {
    if (!fallbackToEqual) return allocations;
    weighted = normalized.map(entry => ({
      ...entry,
      weight: { numerator: 1n, denominator: 1n },
    }));
  }

  const totalWeight = weighted.reduce(
    (sum, entry) => addFractions(sum, entry.weight),
    { numerator: 0n, denominator: 1n },
  );
  const ranked = weighted.map(entry => {
    const numerator = totalMinor * entry.weight.numerator * totalWeight.denominator;
    const denominator = entry.weight.denominator * totalWeight.numerator;
    return {
      ...entry,
      baseMinor: numerator / denominator,
      remainderNumerator: numerator % denominator,
      remainderDenominator: denominator,
    };
  });
  let remaining = totalMinor - ranked.reduce((sum, entry) => sum + entry.baseMinor, 0n);
  ranked.sort((left, right) => {
    const leftCross = left.remainderNumerator * right.remainderDenominator;
    const rightCross = right.remainderNumerator * left.remainderDenominator;
    if (leftCross === rightCross) return left.index - right.index;
    return leftCross > rightCross ? -1 : 1;
  });
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    ranked[index % ranked.length].baseMinor += 1n;
  }
  ranked.forEach(entry => allocations.set(entry.key, Number(entry.baseMinor)));
  return allocations;
};

// Largest-remainder allocation using exact decimal fractions. The previous
// `total * weight / totalWeight` float calculation conserved the final cent
// count but could mis-rank remainders for very large or uneven weights.
const allocateMinorUnitsByWeights = (
  totalMinorUnits,
  entries = [],
  { fallbackToEqual = false } = {},
) => {
  const grouped = new Map();
  entries.forEach((entry, index) => {
    if (!grouped.has(entry.key)) {
      grouped.set(entry.key, {
        key: entry.key,
        index,
        weight: { numerator: 0n, denominator: 1n },
      });
    }
    const fraction = decimalToFraction(entry.weight);
    if (!fraction || fraction.numerator < 0n) {
      throw invalidMoneyInput('Money allocation weights must be valid non-negative decimal values.');
    }
    if (fraction.numerator === 0n) return;
    const current = grouped.get(entry.key);
    current.weight = addFractions(current.weight, fraction);
  });

  const normalized = [...grouped.values()];
  return allocateMinorUnitsByFractionWeights(
    totalMinorUnits,
    normalized,
    { fallbackToEqual },
  );
};

// Sum foreign-currency amounts as exact rational target values, round the
// combined total once, and allocate those target minor units back by exact
// converted weights. This closes the cross-source drift caused by rounding
// PKR, EUR, GBP, etc. buckets independently before summing them.
const allocateConvertedMinorUnitsByRates = (
  entries = [],
  targetRate,
  scale = 2,
) => {
  const parsedScale = requireMoneyScale(scale);
  const targetFraction = decimalToFraction(targetRate);
  if (!targetFraction || targetFraction.numerator <= 0n) {
    throw new RangeError('Target exchange rate must be positive and finite.');
  }
  const scaleFactor = 10n ** BigInt(parsedScale);

  const normalized = [];
  const seenKeys = new Set();
  (entries || []).forEach((entry, index) => {
    if (seenKeys.has(entry.key)) {
      throw new RangeError('Converted money allocation keys must be unique.');
    }
    seenKeys.add(entry.key);
    const amountFraction = decimalToFraction(entry.amount);
    const sourceRateFraction = decimalToFraction(entry.sourceRate);
    if (
      !amountFraction
      || amountFraction.numerator < 0n
      || !sourceRateFraction
      || sourceRateFraction.numerator <= 0n
    ) {
      throw new RangeError('Converted money entries require non-negative amounts and positive rates.');
    }
    let rawNumerator = amountFraction.numerator
      * sourceRateFraction.denominator
      * targetFraction.numerator;
    let rawDenominator = amountFraction.denominator
      * sourceRateFraction.numerator
      * targetFraction.denominator;
    if (entry.maximumExactMinorUnits !== null && entry.maximumExactMinorUnits !== undefined) {
      const maximumExactMinorUnits = Number(entry.maximumExactMinorUnits);
      if (!Number.isSafeInteger(maximumExactMinorUnits) || maximumExactMinorUnits < 0) {
        throw new RangeError('Converted money exact caps must be non-negative safe minor units.');
      }
      assertReversibleMinorUnits(BigInt(maximumExactMinorUnits), parsedScale);
      const capNumerator = BigInt(maximumExactMinorUnits);
      const capDenominator = scaleFactor;
      if (rawNumerator * capDenominator > capNumerator * rawDenominator) {
        rawNumerator = capNumerator;
        rawDenominator = capDenominator;
      }
    }
    let maximumAllocationMinorUnits = null;
    if (entry.maximumAllocationMinorUnits !== null && entry.maximumAllocationMinorUnits !== undefined) {
      maximumAllocationMinorUnits = Number(entry.maximumAllocationMinorUnits);
      if (!Number.isSafeInteger(maximumAllocationMinorUnits) || maximumAllocationMinorUnits < 0) {
        throw new RangeError('Converted money allocation caps must be non-negative safe minor units.');
      }
      assertReversibleMinorUnits(BigInt(maximumAllocationMinorUnits), parsedScale);
    }
    const divisor = greatestCommonDivisor(rawNumerator, rawDenominator) || 1n;
    normalized.push({
      key: entry.key,
      index,
      weight: {
        numerator: rawNumerator / divisor,
        denominator: rawDenominator / divisor,
      },
      maximumAllocationMinorUnits,
    });
  });

  const totalWeight = normalized.reduce(
    (sum, entry) => addFractions(sum, entry.weight),
    { numerator: 0n, denominator: 1n },
  );
  let totalMinorBigInt = divideAndRound(
    totalWeight.numerator * (10n ** BigInt(parsedScale)),
    totalWeight.denominator,
  );
  if (totalMinorBigInt < 0n || totalMinorBigInt > MAX_SAFE_MINOR_UNITS) {
    const error = new RangeError('Money amount is too large to calculate safely.');
    error.code = 'MONEY_AMOUNT_OUT_OF_RANGE';
    throw error;
  }
  assertReversibleMinorUnits(totalMinorBigInt, parsedScale);
  const ranked = normalized.map(entry => {
    const exactMinorNumerator = entry.weight.numerator * scaleFactor;
    const floorMinor = exactMinorNumerator / entry.weight.denominator;
    const hasFraction = exactMinorNumerator % entry.weight.denominator > 0n;
    const naturalCeiling = floorMinor + (hasFraction ? 1n : 0n);
    const hardCap = entry.maximumAllocationMinorUnits === null
      ? naturalCeiling
      : (BigInt(entry.maximumAllocationMinorUnits) < naturalCeiling
        ? BigInt(entry.maximumAllocationMinorUnits)
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
  if (totalMinorBigInt > maximumAchievable) totalMinorBigInt = maximumAchievable;
  assertReversibleMinorUnits(totalMinorBigInt, parsedScale);
  let remaining = totalMinorBigInt - ranked.reduce((sum, entry) => sum + entry.baseMinor, 0n);
  ranked.sort((left, right) => {
    const leftCross = left.remainderNumerator * right.remainderDenominator;
    const rightCross = right.remainderNumerator * left.remainderDenominator;
    if (leftCross === rightCross) return left.index - right.index;
    return leftCross > rightCross ? -1 : 1;
  });
  const eligible = ranked.filter(entry => entry.baseMinor < entry.hardCap);
  for (let index = 0; remaining > 0n && eligible.length; index += 1, remaining -= 1n) {
    eligible[index % eligible.length].baseMinor += 1n;
  }
  const allocations = new Map(normalized.map(entry => [entry.key, 0]));
  ranked.forEach(entry => allocations.set(entry.key, Number(entry.baseMinor)));
  return {
    totalMinorUnits: Number(totalMinorBigInt),
    allocations,
  };
};

// Deterministic highest-averages (D'Hondt) apportionment for cumulative money
// targets. Unlike largest remainder, this method is house-monotone: increasing
// `totalMinorUnits` can never take a previously allocated cent from any key.
// Each integer weight also acts as that key's hard cap, so allocating the full
// weight sum returns every key's exact entitlement.
const allocateHouseMonotoneMinorUnits = (totalMinorUnits, entries = []) => {
  if (
    typeof totalMinorUnits !== 'number'
    || !Number.isSafeInteger(totalMinorUnits)
    || totalMinorUnits < 0
  ) {
    throw new RangeError('Money allocation total must be non-negative safe minor units.');
  }
  assertReversibleMinorUnits(BigInt(totalMinorUnits), 2);
  const requestedTotal = totalMinorUnits;
  const seenKeys = new Set();
  const normalized = (entries || []).map((entry, index) => {
    if (seenKeys.has(entry.key)) {
      throw new RangeError('Money allocation keys must be unique.');
    }
    seenKeys.add(entry.key);
    if (
      typeof entry.weight !== 'number'
      || !Number.isSafeInteger(entry.weight)
      || entry.weight < 0
    ) {
      throw new RangeError('House-monotone money weights must be non-negative safe minor units.');
    }
    assertReversibleMinorUnits(BigInt(entry.weight), 2);
    const weight = entry.weight;
    return { key: entry.key, index, weight, allocation: 0 };
  });
  const capacityBigInt = normalized.reduce((sum, entry) => sum + BigInt(entry.weight), 0n);
  assertReversibleMinorUnits(capacityBigInt, 2);
  const capacity = Number(capacityBigInt);
  if (requestedTotal > capacity) {
    throw new RangeError('Money allocation exceeds its safe entitlement capacity.');
  }
  if (requestedTotal === 0 || normalized.length === 0) {
    return new Map(normalized.map(entry => [entry.key, 0]));
  }
  if (requestedTotal === capacity) {
    return new Map(normalized.map(entry => [entry.key, entry.weight]));
  }

  const maximumWeight = normalized.reduce((maximum, entry) => Math.max(maximum, entry.weight), 0);
  let low = 0;
  let high = maximumWeight;
  // Locate the cutoff priority. The exact final adjustment below uses BigInt
  // comparisons, so floating point here is only an acceleration hint.
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const divisor = (low + high) / 2;
    const seats = normalized.reduce((sum, entry) => (
      sum + Math.min(entry.weight, Math.floor(entry.weight / divisor))
    ), 0);
    if (seats >= requestedTotal) low = divisor;
    else high = divisor;
  }
  const divisor = high || low || 1;
  normalized.forEach(entry => {
    entry.allocation = Math.min(entry.weight, Math.max(0, Math.floor(entry.weight / divisor)));
  });
  let allocated = normalized.reduce((sum, entry) => sum + entry.allocation, 0);

  const betterNext = (candidate, current) => {
    if (!current) return true;
    const left = BigInt(candidate.weight) * BigInt(current.allocation + 1);
    const right = BigInt(current.weight) * BigInt(candidate.allocation + 1);
    return left > right || (left === right && candidate.index < current.index);
  };
  const worseLast = (candidate, current) => {
    if (!current) return true;
    const left = BigInt(candidate.weight) * BigInt(current.allocation);
    const right = BigInt(current.weight) * BigInt(candidate.allocation);
    return left < right || (left === right && candidate.index > current.index);
  };
  const nextOutranksLast = (next, last) => {
    const left = BigInt(next.weight) * BigInt(last.allocation);
    const right = BigInt(last.weight) * BigInt(next.allocation + 1);
    return left > right || (left === right && next.index < last.index);
  };
  let corrections = 0;
  const maximumCorrections = normalized.length * 16 + 256;
  while (allocated < requestedTotal) {
    let selected = null;
    for (const entry of normalized) {
      if (entry.allocation >= entry.weight) continue;
      if (betterNext(entry, selected)) selected = entry;
    }
    if (!selected || corrections++ > maximumCorrections) {
      throw new RangeError('House-monotone money allocation did not converge safely.');
    }
    selected.allocation += 1;
    allocated += 1;
  }
  while (allocated > requestedTotal) {
    let selected = null;
    for (const entry of normalized) {
      if (entry.allocation <= 0) continue;
      if (worseLast(entry, selected)) selected = entry;
    }
    if (!selected || corrections++ > maximumCorrections) {
      throw new RangeError('House-monotone money allocation did not converge safely.');
    }
    selected.allocation -= 1;
    allocated -= 1;
  }

  // A floating-point divisor can land on the correct seat count while still
  // choosing the wrong owner at an exact rational boundary. Canonicalize the
  // boundary with exact BigInt comparisons: exchange the weakest selected
  // seat for the strongest unselected seat until the chosen set is exactly
  // the same as sequential D'Hondt with stable input-order tie-breaking.
  // Without this pass, two adjacent cumulative refund targets could move a
  // cent backwards even though the underlying apportionment method is
  // house-monotone.
  while (true) {
    let bestNext = null;
    let worstLast = null;
    for (const entry of normalized) {
      if (entry.allocation < entry.weight && betterNext(entry, bestNext)) bestNext = entry;
      if (entry.allocation > 0 && worseLast(entry, worstLast)) worstLast = entry;
    }
    if (!bestNext || !worstLast || !nextOutranksLast(bestNext, worstLast)) break;
    if (corrections++ > maximumCorrections) {
      throw new RangeError('House-monotone money allocation did not converge safely.');
    }
    worstLast.allocation -= 1;
    bestNext.allocation += 1;
  }
  return new Map(normalized.map(entry => [entry.key, entry.allocation]));
};

module.exports = {
  toMinorUnits,
  fromMinorUnits,
  roundMoney,
  isExactDecimalAtScale,
  sumMoney,
  multiplyMoney,
  convertMoneyByRates,
  percentageOfMoney,
  allocateMinorUnitsByWeights,
  allocateConvertedMinorUnitsByRates,
  allocateHouseMonotoneMinorUnits,
};
