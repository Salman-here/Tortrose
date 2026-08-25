const crypto = require('crypto');

const TIKTOK_EVENTS_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const DEFAULT_PIXEL_ID = 'D85EEDJC77U42GL90IK0';
const DEFAULT_CURRENCY = 'USD';
const { isSupportedCurrency } = require('./currencyService');
const { roundMoney } = require('./moneyMath');

const normalizeForHash = (value) => String(value || '').trim().toLowerCase();

const sha256 = (value) => {
    const normalized = normalizeForHash(value);
    if (!normalized) return undefined;
    return crypto.createHash('sha256').update(normalized).digest('hex');
};

const parseCookies = (cookieHeader = '') => {
    return cookieHeader.split(';').reduce((cookies, part) => {
        const [rawKey, ...rawValue] = part.trim().split('=');
        if (!rawKey) return cookies;
        const value = rawValue.join('=') || '';
        try {
            cookies[rawKey] = decodeURIComponent(value);
        } catch {
            cookies[rawKey] = value;
        }
        return cookies;
    }, {});
};

const getClientIp = (req) => {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req?.ip || req?.socket?.remoteAddress || undefined;
};

const toNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const cleanObject = (input = {}) => {
    return Object.entries(input).reduce((cleaned, [key, value]) => {
        if (value === undefined || value === null || value === '') return cleaned;
        if (Array.isArray(value) && value.length === 0) return cleaned;
        cleaned[key] = value;
        return cleaned;
    }, {});
};

const resolveOrderEventCurrency = (rawCurrency, currencyPresent = rawCurrency !== undefined) => {
    if (!currencyPresent || rawCurrency === null) {
        return { currency: DEFAULT_CURRENCY, defaultedLegacyCurrency: true };
    }
    if (typeof rawCurrency !== 'string' || !isSupportedCurrency(rawCurrency)) return null;
    return {
        currency: String(rawCurrency).trim().toUpperCase(),
        defaultedLegacyCurrency: false,
    };
};

const strictNonNegativeMoney = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return value;
};

const strictExactNonNegativeMoney = (value) => {
    const amount = strictNonNegativeMoney(value);
    if (amount === null) return null;
    try {
        return roundMoney(amount) === amount ? amount : null;
    } catch {
        return null;
    }
};

const orderItemEventPrice = (item, quantity, currencyResolution) => {
    if (!Number.isSafeInteger(quantity) || quantity < 1) return undefined;

    // New orders persist this exact allocation in the order currency. It is
    // the only safe source for a foreign line whose rounded unit price may not
    // reproduce the allocated line total.
    const lineSubtotalPresent = Object.prototype.hasOwnProperty.call(item || {}, 'lineSubtotal')
        && item?.lineSubtotal !== null;
    if (lineSubtotalPresent) {
        const lineSubtotal = strictExactNonNegativeMoney(item.lineSubtotal);
        return lineSubtotal === null ? undefined : lineSubtotal / quantity;
    }

    const sourceCurrencyPresent = Object.prototype.hasOwnProperty.call(item || {}, 'sourceCurrency');
    const rawSourceCurrency = item?.sourceCurrency;
    const sourceCurrencyMissing = !sourceCurrencyPresent || rawSourceCurrency === null;
    if (!sourceCurrencyMissing) {
        if (typeof rawSourceCurrency !== 'string' || !isSupportedCurrency(rawSourceCurrency)) return undefined;
        if (String(rawSourceCurrency).trim().toUpperCase() !== currencyResolution.currency) {
            // A legacy/malformed mixed-currency line has no authoritative
            // order-currency allocation. Never relabel its native price.
            return undefined;
        }
    } else if (!currencyResolution.defaultedLegacyCurrency) {
        // With an explicit order currency but no line/source currency, the
        // historical price denomination cannot be proven.
        return undefined;
    }

    const price = strictExactNonNegativeMoney(item?.price);
    return price === null ? undefined : price;
};

const buildContentsFromOrder = (
    order,
    currencyResolution = resolveOrderEventCurrency(
        order?.currency,
        Object.prototype.hasOwnProperty.call(order || {}, 'currency')
    )
) => {
    if (!currencyResolution) return [];
    return (order?.orderItems || []).map((item) => {
      const rawQuantity = item?.quantity;
      if (!Number.isSafeInteger(rawQuantity) || rawQuantity < 1) return null;
      return cleanObject({
        content_id: item.productId?.toString?.() || item.productId,
        content_type: 'product',
        content_name: item.name,
        price: orderItemEventPrice(item, rawQuantity, currencyResolution),
        quantity: rawQuantity,
      });
    }).filter((content) => content?.content_id);
};

const buildUserPayload = ({ req, user, email, phone, externalId, tracking = {} } = {}) => {
    const cookies = parseCookies(req?.headers?.cookie || '');
    return cleanObject({
        email: sha256(user?.email || email),
        phone: sha256(phone),
        external_id: sha256(externalId || user?._id || user?.id || email),
        ip: getClientIp(req),
        user_agent: req?.headers?.['user-agent'],
        ttclid: tracking.ttclid || req?.body?.ttclid || cookies.ttclid,
        ttp: tracking.ttp || req?.body?.ttp || cookies._ttp,
    });
};

const createEventId = (prefix, stableId) => {
    if (stableId) return `${prefix}_${stableId}`;
    return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
};

const isEnabled = () => Boolean(process.env.TIKTOK_EVENTS_API_TOKEN);

const sendTikTokEvent = async ({
    event,
    eventId,
    req,
    user,
    email,
    phone,
    externalId,
    properties = {},
    tracking = {},
} = {}) => {
    const accessToken = process.env.TIKTOK_EVENTS_API_TOKEN;
    const pixelId = process.env.TIKTOK_PIXEL_ID || DEFAULT_PIXEL_ID;

    if (!accessToken || !pixelId || !event) {
        return { skipped: true, reason: 'TikTok Events API is not configured' };
    }

    const eventPayload = cleanObject({
        event,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || createEventId(event.toLowerCase(), externalId),
        user: buildUserPayload({ req, user, email, phone, externalId, tracking }),
        page: cleanObject({
            url: tracking.pageUrl || req?.body?.pageUrl || req?.headers?.referer,
            referrer: tracking.referrer || req?.body?.referrer,
        }),
        properties: cleanObject(properties),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const requestBody = cleanObject({
            event_source: 'web',
            event_source_id: pixelId,
            test_event_code: process.env.TIKTOK_TEST_EVENT_CODE,
            data: [eventPayload],
        });

        const response = await fetch(TIKTOK_EVENTS_ENDPOINT, {
            method: 'POST',
            headers: {
                'Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.code) {
            console.warn('[tiktok] Events API rejected event:', {
                event,
                status: response.status,
                code: body?.code,
                message: body?.message,
            });
            return { ok: false, status: response.status, body };
        }

        return { ok: true, body };
    } catch (error) {
        console.warn('[tiktok] Events API failed:', error.message);
        return { ok: false, error: error.message };
    } finally {
        clearTimeout(timeout);
    }
};

const trackCompleteRegistration = ({ req, user, storeName, phone, eventId, tracking = {} } = {}) => {
    const userId = user?._id?.toString?.() || user?.id;
    return sendTikTokEvent({
        event: 'CompleteRegistration',
        eventId: eventId || createEventId('seller_registration', userId),
        req,
        user,
        email: user?.email,
        phone,
        externalId: userId,
        tracking,
        properties: {
            contents: [{
                content_id: userId || 'new_seller',
                content_type: 'product',
                content_name: storeName || 'New Seller Store',
                content_category: 'Seller Signup',
                price: 1,
                quantity: 1,
            }],
            content_type: 'product',
            content_ids: [userId || 'new_seller'],
            content_name: storeName || 'New Seller Store',
            content_category: 'Seller Signup',
            value: 1,
            currency: DEFAULT_CURRENCY,
        },
    });
};

const trackOrderEvent = ({ event, req, order, user, eventId, tracking = {} } = {}) => {
    const currencyResolution = resolveOrderEventCurrency(
        order?.currency,
        Object.prototype.hasOwnProperty.call(order || {}, 'currency')
    );
    if (!currencyResolution) {
        return Promise.resolve({
            skipped: true,
            reason: 'Order currency is invalid for TikTok event money',
        });
    }
    const contents = buildContentsFromOrder(order, currencyResolution);
    const value = strictExactNonNegativeMoney(order?.orderSummary?.totalAmount);
    if (value === null) {
        return Promise.resolve({
            skipped: true,
            reason: 'Order total is invalid for TikTok event money',
        });
    }
    return sendTikTokEvent({
        event,
        eventId: eventId || createEventId(event.toLowerCase(), order?.orderId),
        req,
        user,
        email: order?.shippingInfo?.email,
        phone: order?.shippingInfo?.phone,
        externalId: user?._id || order?.user || order?.shippingInfo?.email,
        tracking,
        properties: {
            contents,
            content_type: contents.length ? 'product' : undefined,
            content_ids: contents.map((content) => content.content_id),
            order_id: order?.orderId,
            value,
            currency: currencyResolution.currency,
        },
    });
};

module.exports = {
    DEFAULT_PIXEL_ID,
    buildContentsFromOrder,
    createEventId,
    isEnabled,
    sendTikTokEvent,
    sha256,
    trackCompleteRegistration,
    trackOrderEvent,
};
