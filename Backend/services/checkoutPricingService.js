'use strict';

const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
const ShippingMethod = require('../models/ShippingMethod');
const {
    isSupportedCurrency,
    normalizeCurrency,
    normalizeRates,
    getExchangeRateSnapshot,
    convertAmountWithRates,
} = require('./currencyService');
const {
    allocateConvertedMinorUnitsByRates,
    fromMinorUnits,
    percentageOfMoney,
    roundMoney,
    sumMoney,
    toMinorUnits,
} = require('./moneyMath');
const { couponTermsFingerprint } = require('./couponTermsService');
const {
    getOrderItemLineSubtotal,
    getOrderItemSourceLineSubtotal,
} = require('./orderLinePricingService');
const { parseStrictFiniteNumber } = require('./numericInputService');

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';

const checkoutError = (message, code, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const couponConfigError = coupon => checkoutError(
    `Coupon ${coupon?.code || ''} has invalid stored terms. Ask the seller to correct it.`,
    'COUPON_CONFIG_INVALID',
    409,
);

const requireExactConfiguredMoney = (value, coupon, { allowZero = true } = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value <= 0)) {
        throw couponConfigError(coupon);
    }
    try {
        if (roundMoney(value) !== value) throw couponConfigError(coupon);
    } catch (error) {
        if (error?.code === 'COUPON_CONFIG_INVALID') throw error;
        throw couponConfigError(coupon);
    }
    return value;
};

const assertStoredCouponMoneyTerms = coupon => {
    const discountValue = coupon.discountValue;
    if (
        !['percentage', 'fixed'].includes(coupon?.discountType)
        || typeof discountValue !== 'number'
        || !Number.isFinite(discountValue)
        || discountValue < 0.01
    ) {
        throw couponConfigError(coupon);
    }
    if (coupon.discountType === 'percentage') {
        try {
            if (discountValue > 100 || roundMoney(discountValue, 6) !== discountValue) {
                throw couponConfigError(coupon);
            }
        } catch (error) {
            if (error?.code === 'COUPON_CONFIG_INVALID') throw error;
            throw couponConfigError(coupon);
        }
    } else {
        requireExactConfiguredMoney(discountValue, coupon, { allowZero: false });
    }

    const minOrderAmount = coupon.minOrderAmount ?? 0;
    requireExactConfiguredMoney(minOrderAmount, coupon);
    if (coupon.maxDiscountAmount !== null && coupon.maxDiscountAmount !== undefined) {
        requireExactConfiguredMoney(coupon.maxDiscountAmount, coupon, { allowZero: false });
    }
    requireSupportedCheckoutCurrency(
        coupon.currency,
        null,
        'COUPON_CURRENCY_NOT_SUPPORTED',
        { requireCanonical: true, statusCode: 409 },
    );
};

// Normal writes are model/controller validated, but checkout is the final
// persistence boundary before money is charged. A raw or legacy corrupt row
// must never be reinterpreted (for example an unknown type as a fixed coupon).
const assertStoredCouponTerms = coupon => {
    assertStoredCouponMoneyTerms(coupon);
    if (
        !['all', 'selected'].includes(coupon?.applicableTo)
        || typeof coupon?.isActive !== 'boolean'
        || !Array.isArray(coupon?.applicableProducts)
        || !Array.isArray(coupon?.usedBy)
    ) {
        throw couponConfigError(coupon);
    }

    const startAt = coupon.startDate instanceof Date ? coupon.startDate : new Date(coupon.startDate);
    const expiryAt = coupon.expiryDate instanceof Date ? coupon.expiryDate : new Date(coupon.expiryDate);
    if (
        !Number.isFinite(startAt.getTime())
        || !Number.isFinite(expiryAt.getTime())
        || expiryAt <= startAt
        || (coupon.applicableTo === 'selected' && coupon.applicableProducts.length === 0)
    ) {
        throw couponConfigError(coupon);
    }

    const integerTerms = [
        [coupon.usedCount ?? 0, 0],
        [coupon.maxUsesPerUser ?? 1, 1],
    ];
    if (coupon.maxUses !== null && coupon.maxUses !== undefined) {
        integerTerms.push([coupon.maxUses, 1]);
    }
    if (integerTerms.some(([value, minimum]) => !Number.isSafeInteger(value) || value < minimum)) {
        throw couponConfigError(coupon);
    }
    if (coupon.usedBy.some(entry => (
        !toId(entry?.user) || !Number.isSafeInteger(entry?.count) || entry.count < 1
    ))) {
        throw couponConfigError(coupon);
    }
};

const requireSupportedCheckoutCurrency = (
    value,
    fallback = 'USD',
    code = 'UNSUPPORTED_CURRENCY',
    { requireCanonical = false, statusCode = 400 } = {},
) => {
    // Missing legacy metadata may use its documented fallback. A present blank
    // value is malformed input/data and must not be relabelled as USD.
    const raw = value === null || value === undefined
        ? fallback
        : value;
    const canonical = typeof raw === 'string' ? raw.trim().toUpperCase() : null;
    if (
        typeof raw !== 'string'
        || !raw.trim()
        || !isSupportedCurrency(raw)
        || (requireCanonical && raw !== canonical)
    ) {
        throw checkoutError(
            'Checkout money uses an unsupported currency.',
            code,
            statusCode,
        );
    }
    return canonical;
};

const lineSubtotal = item => getOrderItemLineSubtotal(item);

const convertCheckoutAmount = async (
    amount,
    fromCurrency,
    toCurrency,
    exchangeRates = null,
    exchangeRatesFallback = false,
) => {
    const from = requireSupportedCheckoutCurrency(fromCurrency);
    const to = requireSupportedCheckoutCurrency(toCurrency);
    if (from === to) return roundMoney(amount);
    if (exchangeRatesFallback && from !== to) {
        throw checkoutError(
            'Live exchange rates are temporarily unavailable. Please retry checkout shortly.',
            'EXCHANGE_RATES_UNAVAILABLE',
            503,
        );
    }
    let rateTable = normalizeRates(exchangeRates);
    let fallback = exchangeRatesFallback;
    if (!rateTable) {
        const snapshot = await getExchangeRateSnapshot();
        rateTable = normalizeRates(snapshot?.rates);
        fallback = snapshot?.fallback === true;
    }
    if (fallback || !rateTable) {
        throw checkoutError(
            'Live exchange rates are temporarily unavailable. Please retry checkout shortly.',
            'EXCHANGE_RATES_UNAVAILABLE',
            503,
        );
    }
    return convertAmountWithRates(amount, from, to, rateTable);
};

// Preserve target-native amounts exactly. Combine every foreign source as exact
// rational target value, round that foreign total once, then allocate its cents
// back to owners. This prevents both same-source and cross-source rounding drift.
const allocateCheckoutAmountsBySource = async ({
    entries = [],
    orderCurrency,
    exchangeRates = null,
    exchangeRatesFallback = false,
}) => {
    const currency = requireSupportedCheckoutCurrency(
        orderCurrency,
        'USD',
        'ORDER_CURRENCY_NOT_SUPPORTED',
    );
    const normalizedEntries = [];
    const seenKeys = new Set();

    for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
        const key = String(entry?.key ?? index);
        const rawAmount = parseStrictFiniteNumber(entry?.sourceAmount);
        const hasMaximumTargetAmount = entry?.maximumTargetAmount !== null
            && entry?.maximumTargetAmount !== undefined;
        const rawMaximumTargetAmount = hasMaximumTargetAmount
            ? parseStrictFiniteNumber(entry.maximumTargetAmount)
            : null;
        const hasMaximumAllocatedTargetAmount = entry?.maximumAllocatedTargetAmount !== null
            && entry?.maximumAllocatedTargetAmount !== undefined;
        const rawMaximumAllocatedTargetAmount = hasMaximumAllocatedTargetAmount
            ? parseStrictFiniteNumber(entry.maximumAllocatedTargetAmount)
            : null;
        if (seenKeys.has(key)) {
            throw checkoutError('Money allocation entries must have unique owners.', 'MONEY_ALLOCATION_SCOPE_INVALID');
        }
        if (rawAmount === null || rawAmount < 0) {
            throw checkoutError('A configured money amount is invalid.', 'CHECKOUT_MONEY_INVALID');
        }
        if (hasMaximumTargetAmount && (rawMaximumTargetAmount === null || rawMaximumTargetAmount < 0)) {
            throw checkoutError('A configured money cap is invalid.', 'CHECKOUT_MONEY_INVALID');
        }
        if (
            hasMaximumAllocatedTargetAmount
            && (rawMaximumAllocatedTargetAmount === null || rawMaximumAllocatedTargetAmount < 0)
        ) {
            throw checkoutError('A configured allocation cap is invalid.', 'CHECKOUT_MONEY_INVALID');
        }
        seenKeys.add(key);
        normalizedEntries.push({
            ...entry,
            key,
            sourceAmount: roundMoney(rawAmount),
            sourceCurrency: requireSupportedCheckoutCurrency(
                entry?.sourceCurrency,
                currency,
                'CHECKOUT_SOURCE_CURRENCY_NOT_SUPPORTED',
            ),
            maximumTargetAmount: rawMaximumTargetAmount === null
                ? null
                : roundMoney(rawMaximumTargetAmount),
            maximumAllocatedTargetAmount: rawMaximumAllocatedTargetAmount === null
                ? null
                : roundMoney(rawMaximumAllocatedTargetAmount),
            targetAmount: 0,
            __allocationIndex: index,
        });
    }

    const foreignEntries = [];
    for (const entry of normalizedEntries) {
        if (entry.sourceCurrency === currency) {
            entry.targetAmount = Math.min(
                entry.sourceAmount,
                entry.maximumTargetAmount ?? entry.sourceAmount,
                entry.maximumAllocatedTargetAmount ?? entry.sourceAmount,
            );
        }
        else foreignEntries.push(entry);
    }

    if (foreignEntries.length) {
        let rateTable = normalizeRates(exchangeRates);
        let fallback = exchangeRatesFallback;
        if (!rateTable) {
            const snapshot = await getExchangeRateSnapshot();
            rateTable = normalizeRates(snapshot?.rates);
            fallback = snapshot?.fallback === true;
        }
        if (fallback || !rateTable) {
            throw checkoutError(
                'Live exchange rates are temporarily unavailable. Please retry checkout shortly.',
                'EXCHANGE_RATES_UNAVAILABLE',
                503,
            );
        }
        const { allocations } = allocateConvertedMinorUnitsByRates(
            foreignEntries.map(entry => ({
                key: entry.key,
                amount: entry.sourceAmount,
                sourceRate: rateTable[entry.sourceCurrency],
                maximumExactMinorUnits: entry.maximumTargetAmount === null
                    ? null
                    : toMinorUnits(entry.maximumTargetAmount),
                maximumAllocationMinorUnits: entry.maximumAllocatedTargetAmount === null
                    ? null
                    : toMinorUnits(entry.maximumAllocatedTargetAmount),
            })),
            rateTable[currency],
        );
        foreignEntries.forEach((entry) => {
            entry.targetAmount = fromMinorUnits(allocations.get(entry.key) || 0);
        });
    }

    return normalizedEntries
        .sort((left, right) => left.__allocationIndex - right.__allocationIndex)
        .map(({ __allocationIndex, ...entry }) => entry);
};

const validateAndPriceCoupons = async ({
    requestedCoupons = [],
    orderItems = [],
    userId,
    orderCurrency,
    exchangeRates = null,
    exchangeRatesFallback = false,
    at = new Date(),
    session = null,
}) => {
    if (!Array.isArray(requestedCoupons) || requestedCoupons.length === 0) {
        return { appliedCoupons: [], couponDiscount: 0 };
    }
    if (!userId) {
        throw checkoutError('Log in before applying a coupon.', 'COUPON_LOGIN_REQUIRED');
    }

    const currency = requireSupportedCheckoutCurrency(
        orderCurrency,
        'USD',
        'ORDER_CURRENCY_NOT_SUPPORTED',
    );
    const requestedById = new Map();
    for (const requested of requestedCoupons) {
        const couponId = toId(requested?.couponId || requested?._id);
        if (!mongoose.isValidObjectId(couponId) || requestedById.has(couponId)) {
            throw checkoutError('Each coupon can be applied only once.', 'DUPLICATE_OR_INVALID_COUPON');
        }
        requestedById.set(couponId, requested);
    }

    const couponQuery = Coupon.find({ _id: { $in: [...requestedById.keys()] } });
    if (session && typeof couponQuery.session === 'function') couponQuery.session(session);
    const coupons = await couponQuery.lean();
    if (coupons.length !== requestedById.size) {
        throw checkoutError('One or more coupons are no longer available.', 'COUPON_NOT_FOUND');
    }

    const orderItemsByProduct = new Map();
    for (const item of orderItems) {
        const productId = toId(item.productId);
        if (!productId) continue;
        if (!orderItemsByProduct.has(productId)) orderItemsByProduct.set(productId, []);
        orderItemsByProduct.get(productId).push(item);
    }

    const claimedProductIds = new Set();
    const stagedCoupons = [];

    coupons.sort((left, right) => toId(left._id).localeCompare(toId(right._id)));
    for (const coupon of coupons) {
        assertStoredCouponTerms(coupon);
        const couponId = toId(coupon._id);
        const requested = requestedById.get(couponId);
        const now = new Date(at);
        if (
            coupon.isActive !== true ||
            now < new Date(coupon.startDate) ||
            now > new Date(coupon.expiryDate)
        ) {
            throw checkoutError(`Coupon ${coupon.code} is no longer active.`, 'COUPON_NOT_ACTIVE');
        }
        if (coupon.maxUses !== null && coupon.maxUses !== undefined && Number(coupon.usedCount || 0) >= Number(coupon.maxUses)) {
            throw checkoutError(`Coupon ${coupon.code} has reached its usage limit.`, 'COUPON_USAGE_LIMIT');
        }
        const userUsageCount = (coupon.usedBy || [])
            .filter(entry => toId(entry.user) === toId(userId))
            .reduce((sum, entry) => sum + Math.max(0, Number(entry.count || 0)), 0);
        if (userUsageCount >= Number(coupon.maxUsesPerUser || 1)) {
            throw checkoutError(`Coupon ${coupon.code} has already been used the maximum number of times.`, 'COUPON_USER_LIMIT');
        }

        const sellerId = toId(coupon.seller);
        const sellerProductIds = new Set(orderItems
            .filter(item => toId(item.seller) === sellerId)
            .map(item => toId(item.productId))
            .filter(Boolean));
        const configuredProductIds = new Set((coupon.applicableProducts || []).map(toId).filter(Boolean));
        const allowedProductIds = new Set([...sellerProductIds].filter(productId => (
            coupon.applicableTo === 'all' || configuredProductIds.has(productId)
        )));

        const requestedScope = [...new Set((requested?.applicableProductIds || []).map(toId).filter(Boolean))];
        const applicableProductIds = requestedScope.length ? requestedScope : [...allowedProductIds];
        if (!applicableProductIds.length || applicableProductIds.some(productId => !allowedProductIds.has(productId))) {
            throw checkoutError(`Coupon ${coupon.code} does not apply to the selected products.`, 'COUPON_SCOPE_INVALID');
        }
        if (applicableProductIds.some(productId => claimedProductIds.has(productId))) {
            throw checkoutError('Two coupons cannot discount the same product in one order.', 'OVERLAPPING_COUPONS');
        }

        const applicableSubtotal = sumMoney(applicableProductIds.flatMap(productId => (
            (orderItemsByProduct.get(productId) || []).map(lineSubtotal)
        )));
        const couponCurrency = requireSupportedCheckoutCurrency(
            coupon.currency,
            null,
            'COUPON_CURRENCY_NOT_SUPPORTED',
            { requireCanonical: true, statusCode: 409 },
        );
        const sourceEligibleLines = applicableProductIds.flatMap(productId => (
            (orderItemsByProduct.get(productId) || []).map((item, index) => {
                const sourceAmount = getOrderItemSourceLineSubtotal(item) ?? lineSubtotal(item);
                const sourceCurrency = requireSupportedCheckoutCurrency(
                    item?.sourceCurrency ?? item?.priceCurrency ?? currency,
                    currency,
                    'ORDER_LINE_CURRENCY_NOT_SUPPORTED',
                    { requireCanonical: true, statusCode: 409 },
                );
                return {
                    key: `${productId}:${index}`,
                    sourceAmount,
                    sourceCurrency,
                };
            })
        ));
        const sourceApplicableSubtotal = sumMoney((await allocateCheckoutAmountsBySource({
            entries: sourceEligibleLines,
            orderCurrency: couponCurrency,
            exchangeRates,
            exchangeRatesFallback,
        })).map(entry => entry.targetAmount));
        const minimumAmount = coupon.minOrderAmount > 0
            ? roundMoney(await convertCheckoutAmount(coupon.minOrderAmount, couponCurrency, currency, exchangeRates, exchangeRatesFallback))
            : 0;
        if (toMinorUnits(applicableSubtotal) < toMinorUnits(minimumAmount)) {
            throw checkoutError(`Coupon ${coupon.code} requires a higher eligible subtotal.`, 'COUPON_MINIMUM_NOT_MET');
        }

        const rawDiscountValue = parseStrictFiniteNumber(coupon.discountValue);
        if (rawDiscountValue === null || rawDiscountValue <= 0) {
            throw checkoutError(`Coupon ${coupon.code} has an invalid discount.`, 'COUPON_DISCOUNT_INVALID');
        }
        const rawMaximumDiscount = parseStrictFiniteNumber(coupon.maxDiscountAmount);
        const hasMaximumDiscount = rawMaximumDiscount !== null && rawMaximumDiscount > 0;
        let directTargetAmount = null;
        let foreignAllocation = null;
        let storedDiscountValue;
        let sourceAppliedDiscountAmount;
        if (coupon.discountType === 'percentage') {
            if (rawDiscountValue > 100) {
                throw checkoutError(`Coupon ${coupon.code} has an invalid percentage.`, 'COUPON_DISCOUNT_INVALID');
            }
            storedDiscountValue = rawDiscountValue;
            sourceAppliedDiscountAmount = percentageOfMoney(sourceApplicableSubtotal, storedDiscountValue);
            if (hasMaximumDiscount) {
                sourceAppliedDiscountAmount = Math.min(
                    sourceAppliedDiscountAmount,
                    roundMoney(rawMaximumDiscount),
                );
            }
            const percentageAmount = percentageOfMoney(applicableSubtotal, storedDiscountValue);
            if (percentageAmount <= 0) {
                throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
            }
            if (!hasMaximumDiscount) {
                directTargetAmount = percentageAmount;
            } else {
                const roundedMaximum = roundMoney(await convertCheckoutAmount(
                    rawMaximumDiscount,
                    couponCurrency,
                    currency,
                    exchangeRates,
                    exchangeRatesFallback,
                ));
                const hardMaximum = Math.min(applicableSubtotal, percentageAmount, roundedMaximum);
                if (hardMaximum <= 0) {
                    throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
                }
                if (couponCurrency === currency) {
                    directTargetAmount = hardMaximum;
                } else {
                    foreignAllocation = {
                        key: couponId,
                        sourceAmount: rawMaximumDiscount,
                        sourceCurrency: couponCurrency,
                        maximumTargetAmount: percentageAmount,
                        maximumAllocatedTargetAmount: hardMaximum,
                    };
                }
            }
        } else {
            const sourceFaceValue = roundMoney(rawDiscountValue);
            const sourceMaximum = hasMaximumDiscount ? roundMoney(rawMaximumDiscount) : null;
            const effectiveSourceValue = sourceMaximum === null
                ? sourceFaceValue
                : Math.min(sourceFaceValue, sourceMaximum);
            sourceAppliedDiscountAmount = Math.min(sourceApplicableSubtotal, effectiveSourceValue);
            storedDiscountValue = roundMoney(await convertCheckoutAmount(
                sourceFaceValue,
                couponCurrency,
                currency,
                exchangeRates,
                exchangeRatesFallback,
            ));
            if (effectiveSourceValue <= 0) {
                throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
            }
            if (couponCurrency === currency) {
                directTargetAmount = Math.min(applicableSubtotal, effectiveSourceValue);
            } else {
                let hardMaximum = applicableSubtotal;
                if (hasMaximumDiscount) {
                    const roundedMaximum = roundMoney(await convertCheckoutAmount(
                        rawMaximumDiscount,
                        couponCurrency,
                        currency,
                        exchangeRates,
                        exchangeRatesFallback,
                    ));
                    hardMaximum = Math.min(hardMaximum, roundedMaximum);
                }
                if (hardMaximum <= 0) {
                    throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
                }
                foreignAllocation = {
                    key: couponId,
                    sourceAmount: effectiveSourceValue,
                    sourceCurrency: couponCurrency,
                    maximumTargetAmount: applicableSubtotal,
                    maximumAllocatedTargetAmount: hardMaximum,
                };
            }
        }
        if (directTargetAmount !== null && directTargetAmount <= 0) {
            throw checkoutError(`Coupon ${coupon.code} does not provide a valid discount for this order.`, 'COUPON_DISCOUNT_INVALID');
        }

        applicableProductIds.forEach(productId => claimedProductIds.add(productId));
        stagedCoupons.push({
            coupon,
            couponId,
            couponCurrency,
            applicableProductIds,
            storedDiscountValue,
            sourceDiscountValue: rawDiscountValue,
            sourceAppliedDiscountAmount: roundMoney(sourceAppliedDiscountAmount),
            directTargetAmount,
            foreignAllocation,
        });
    }

    const foreignStages = stagedCoupons.filter(stage => stage.foreignAllocation);
    const foreignAmounts = new Map();
    if (foreignStages.length) {
        const allocated = await allocateCheckoutAmountsBySource({
            entries: foreignStages.map(stage => stage.foreignAllocation),
            orderCurrency: currency,
            exchangeRates,
            exchangeRatesFallback,
        });
        allocated.forEach(entry => foreignAmounts.set(entry.key, entry.targetAmount));
        const zeroAllocation = foreignStages.find(stage => (
            (foreignAmounts.get(stage.couponId) || 0) <= 0
        ));
        if (zeroAllocation) {
            throw checkoutError(
                `Coupon ${zeroAllocation.coupon.code} is too small to discount this order in ${currency}.`,
                'COUPON_DISCOUNT_INVALID',
            );
        }
    }

    const appliedCoupons = stagedCoupons.map(stage => {
        const appliedDiscountAmount = stage.directTargetAmount === null
            ? (foreignAmounts.get(stage.couponId) || 0)
            : roundMoney(stage.directTargetAmount);
        return {
            couponId: stage.coupon._id,
            seller: stage.coupon.seller,
            code: stage.coupon.code,
            discountType: stage.coupon.discountType,
            discountValue: stage.storedDiscountValue,
            appliedDiscountAmount,
            currency,
            sourceAppliedDiscountAmount: stage.sourceAppliedDiscountAmount,
            sourceDiscountValue: stage.sourceDiscountValue,
            sourceCurrency: stage.couponCurrency,
            applicableProductIds: stage.applicableProductIds,
            couponTermsFingerprint: couponTermsFingerprint(stage.coupon),
        };
    });
    const subtotal = sumMoney(orderItems.map(lineSubtotal));
    const couponDiscount = sumMoney(appliedCoupons.map(coupon => coupon.appliedDiscountAmount));
    if (toMinorUnits(couponDiscount) > toMinorUnits(subtotal)) {
        throw checkoutError(
            'Coupon allocation exceeded the eligible order subtotal.',
            'COUPON_DISCOUNT_INVARIANT_VIOLATION',
            500,
        );
    }
    return {
        appliedCoupons,
        couponDiscount,
    };
};

const validateAndPriceShipping = async ({
    requestedSellerShipping = [],
    fallbackShippingMethod = null,
    sellerIds = [],
    sellerCurrencies = {},
    orderCurrency,
    exchangeRates = null,
    exchangeRatesFallback = false,
}) => {
    const currency = requireSupportedCheckoutCurrency(
        orderCurrency,
        'USD',
        'ORDER_CURRENCY_NOT_SUPPORTED',
    );
    const canonicalSellerIds = [...new Set(sellerIds.map(toId).filter(Boolean))];
    if (!canonicalSellerIds.length) {
        throw checkoutError('This order does not contain a valid seller.', 'ORDER_SELLER_MISSING');
    }

    const requestedBySeller = new Map();
    for (const entry of Array.isArray(requestedSellerShipping) ? requestedSellerShipping : []) {
        const sellerId = toId(entry?.seller);
        if (!sellerId || !canonicalSellerIds.includes(sellerId) || requestedBySeller.has(sellerId)) {
            throw checkoutError('Shipping selections do not match the sellers in this cart.', 'SHIPPING_SCOPE_INVALID');
        }
        requestedBySeller.set(sellerId, entry.shippingMethod || {});
    }
    if (requestedBySeller.size === 0 && canonicalSellerIds.length === 1 && fallbackShippingMethod) {
        requestedBySeller.set(canonicalSellerIds[0], fallbackShippingMethod);
    }

    const shippingDocuments = await ShippingMethod.find({ seller: { $in: canonicalSellerIds } }).lean();
    const shippingBySeller = new Map(shippingDocuments.map(document => [toId(document.seller), document]));
    const selectedShipping = [];

    for (const sellerId of canonicalSellerIds) {
        const requested = requestedBySeller.get(sellerId);
        if (!requested) {
            throw checkoutError('Select one shipping method for every seller.', 'SHIPPING_METHOD_REQUIRED');
        }
        const requestedType = String(requested.name || requested.type || '').trim().toLowerCase();
        const configured = shippingBySeller.get(sellerId);
        let method;
        if (configured) {
            method = (configured.methods || []).find(entry => entry.isActive !== false && entry.type === requestedType);
        } else if (requestedType === 'free') {
            method = { type: 'free', cost: 0, currency, deliveryDays: 5, isActive: true };
        }
        if (!method) {
            throw checkoutError('A selected shipping method is no longer available. Refresh checkout and choose again.', 'SHIPPING_METHOD_NOT_AVAILABLE');
        }

        // Currency-less rows predate native shipping metadata and were stored
        // canonically in USD. Seller/store currency applies only to newly
        // configured rows that persist explicit metadata.
        const storedShippingCurrencies = [method.currency, method.costCurrency]
            // Null/undefined are the historical schema sentinel for metadata
            // that was never stored. Blank or malformed present values are not
            // legacy and must fail closed rather than becoming USD.
            .filter(value => value !== null && value !== undefined);
        if (storedShippingCurrencies.some(value => (
            typeof value !== 'string'
            || !value.trim()
            || !isSupportedCurrency(value)
            || value !== value.trim().toUpperCase()
        ))) {
            throw checkoutError(
                'A selected shipping method has invalid stored currency metadata.',
                'SHIPPING_CURRENCY_NOT_SUPPORTED',
                409,
            );
        }
        const normalizedShippingCurrencies = [
            ...new Set(storedShippingCurrencies.map(normalizeCurrency)),
        ];
        if (normalizedShippingCurrencies.length > 1) {
            throw checkoutError(
                'A selected shipping method has conflicting stored currency metadata.',
                'SHIPPING_CURRENCY_METADATA_INVALID',
                409,
            );
        }
        const sourceCurrency = normalizedShippingCurrencies[0] || 'USD';
        const rawSourceCost = method.cost;
        const rawInputAmount = method.costInputAmount;
        const hasInputAmount = rawInputAmount !== null && rawInputAmount !== undefined;
        let sourceCost = null;
        let normalizedInputAmount = null;
        try {
            if (typeof rawSourceCost === 'number' && Number.isFinite(rawSourceCost)) {
                sourceCost = roundMoney(rawSourceCost);
            }
            if (hasInputAmount && typeof rawInputAmount === 'number' && Number.isFinite(rawInputAmount)) {
                normalizedInputAmount = roundMoney(rawInputAmount);
            }
        } catch (_) {
            sourceCost = null;
            normalizedInputAmount = null;
        }
        if (
            !['free', 'standard', 'fast'].includes(method.type)
            || sourceCost === null
            || sourceCost !== rawSourceCost
            || (method.type === 'free' ? sourceCost !== 0 : sourceCost <= 0)
            || (hasInputAmount && (
                normalizedInputAmount === null
                || normalizedInputAmount !== rawInputAmount
                || (method.type === 'free' ? normalizedInputAmount !== 0 : normalizedInputAmount <= 0)
            ))
        ) {
            throw checkoutError(
                'A selected shipping method has an invalid configured cost.',
                'SHIPPING_COST_INVALID',
                409,
            );
        }
        if (!Number.isSafeInteger(method.deliveryDays) || method.deliveryDays < 1) {
            throw checkoutError(
                'A selected shipping method has an invalid delivery estimate.',
                'SHIPPING_DATA_INVALID',
                409,
            );
        }
        const estimatedDays = method.deliveryDays;
        selectedShipping.push({
            key: sellerId,
            seller: sellerId,
            name: method.type,
            estimatedDays,
            sourceAmount: sourceCost,
            sourceCurrency,
        });
    }

    const allocatedShipping = await allocateCheckoutAmountsBySource({
        entries: selectedShipping,
        orderCurrency: currency,
        exchangeRates,
        exchangeRatesFallback,
    });
    const sellerShipping = allocatedShipping.map(entry => ({
        seller: entry.seller,
        shippingMethod: {
            name: entry.name,
            price: entry.targetAmount,
            estimatedDays: entry.estimatedDays,
            sourceCost: entry.sourceAmount,
            sourceCurrency: entry.sourceCurrency,
        },
    }));

    return {
        sellerShipping,
        primaryShipping: sellerShipping[0],
        shippingCost: sumMoney(sellerShipping.map(entry => entry.shippingMethod.price)),
    };
};

module.exports = {
    checkoutError,
    assertStoredCouponMoneyTerms,
    assertStoredCouponTerms,
    requireSupportedCheckoutCurrency,
    lineSubtotal,
    allocateCheckoutAmountsBySource,
    validateAndPriceCoupons,
    validateAndPriceShipping,
};
