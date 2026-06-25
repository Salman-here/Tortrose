const crypto = require('crypto');

const DEFAULT_GRAPH_API_VERSION = 'v25.0';
const DEFAULT_LEAD_EVENT_SOURCE = 'Rozare';
const DEFAULT_SELLER_LEAD_EVENT_NAME = 'Lead';
const DEFAULT_VERIFICATION_EVENT_NAME = 'QualifiedLead';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const normalizeGeneric = (value) => String(value || '').trim().toLowerCase();

const sha256 = (value, normalizer = normalizeGeneric) => {
    const normalized = normalizer(value);
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

const cleanObject = (input = {}) => {
    return Object.entries(input).reduce((cleaned, [key, value]) => {
        if (value === undefined || value === null || value === '') return cleaned;
        if (Array.isArray(value) && value.length === 0) return cleaned;
        cleaned[key] = value;
        return cleaned;
    }, {});
};

const arrayValue = (value) => (value ? [value] : undefined);

const getClientIp = (req) => {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return forwarded.split(',')[0].trim();
    }
    return req?.headers?.['x-real-ip'] || req?.ip || req?.socket?.remoteAddress || undefined;
};

const createFbcFromFbclid = (fbclid, timestampMs = Date.now()) => {
    const cleanFbclid = String(fbclid || '').trim();
    if (!cleanFbclid) return undefined;
    return `fb.1.${timestampMs}.${cleanFbclid}`;
};

const pickTrackingValue = (tracking = {}, cookies = {}, req, keys = []) => {
    for (const key of keys) {
        if (tracking[key]) return tracking[key];
        if (req?.body?.[key]) return req.body[key];
        if (cookies[key]) return cookies[key];
    }
    return undefined;
};

const buildUserData = ({ req, user, email, phone, externalId, tracking = {} } = {}) => {
    const cookies = parseCookies(req?.headers?.cookie || '');
    const fbclid = pickTrackingValue(tracking, cookies, req, ['fbclid']);
    const fbc = pickTrackingValue(tracking, cookies, req, ['fbc', '_fbc']) || createFbcFromFbclid(fbclid);
    const fbp = pickTrackingValue(tracking, cookies, req, ['fbp', '_fbp']);
    const leadId = pickTrackingValue(tracking, cookies, req, ['lead_id', 'leadId', 'facebookLeadId']);

    return cleanObject({
        em: arrayValue(sha256(user?.email || email, normalizeEmail)),
        ph: arrayValue(sha256(phone || user?.sellerInfo?.phoneNumber || user?.sellerInfo?.whatsappNumber, normalizePhone)),
        external_id: arrayValue(sha256(externalId || user?._id || user?.id || user?.email || email)),
        lead_id: leadId,
        fbc,
        fbp,
        client_ip_address: getClientIp(req),
        client_user_agent: req?.headers?.['user-agent'],
    });
};

const createEventId = (prefix, stableId) => {
    if (stableId) return `${prefix}_${stableId}`;
    return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
};

const getDatasetId = () =>
    process.env.META_CAPI_DATASET_ID ||
    process.env.META_DATASET_ID ||
    process.env.META_PIXEL_ID ||
    process.env.FACEBOOK_PIXEL_ID;

const getGraphApiVersion = () =>
    process.env.META_CAPI_API_VERSION ||
    process.env.META_GRAPH_API_VERSION ||
    DEFAULT_GRAPH_API_VERSION;

const isEnabled = () => Boolean(process.env.META_CAPI_ACCESS_TOKEN && getDatasetId());

const sendMetaLeadEvent = async ({
    eventName,
    eventId,
    eventTime,
    leadEventSource,
    req,
    user,
    email,
    phone,
    externalId,
    tracking = {},
} = {}) => {
    const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
    const datasetId = getDatasetId();
    const resolvedEventName = eventName || DEFAULT_SELLER_LEAD_EVENT_NAME;

    if (!accessToken || !datasetId || !resolvedEventName) {
        return { skipped: true, reason: 'Meta Conversions API is not configured' };
    }

    const userData = buildUserData({ req, user, email, phone, externalId, tracking });
    if (Object.keys(userData).length === 0) {
        return { skipped: true, reason: 'No Meta customer match data available' };
    }

    const eventPayload = cleanObject({
        event_name: resolvedEventName,
        event_time: eventTime || Math.floor(Date.now() / 1000),
        event_id: eventId || createEventId(resolvedEventName.toLowerCase(), externalId || user?._id || user?.id),
        action_source: 'system_generated',
        custom_data: cleanObject({
            event_source: 'crm',
            lead_event_source: leadEventSource || process.env.META_CAPI_LEAD_EVENT_SOURCE || DEFAULT_LEAD_EVENT_SOURCE,
        }),
        user_data: userData,
    });

    const requestBody = cleanObject({
        data: [eventPayload],
        test_event_code: process.env.META_CAPI_TEST_EVENT_CODE,
    });

    const params = new URLSearchParams({ access_token: accessToken });
    const endpoint = `https://graph.facebook.com/${getGraphApiVersion()}/${datasetId}/events?${params.toString()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.error) {
            console.warn('[meta] Conversions API rejected CRM event:', {
                eventName: resolvedEventName,
                status: response.status,
                message: body?.error?.message,
                code: body?.error?.code,
            });
            return { ok: false, status: response.status, body };
        }

        return { ok: true, body };
    } catch (error) {
        console.warn('[meta] Conversions API failed:', error.message);
        return { ok: false, error: error.message };
    } finally {
        clearTimeout(timeout);
    }
};

const trackSellerLead = ({ req, user, storeName, phone, eventId, tracking = {} } = {}) => {
    const userId = user?._id?.toString?.() || user?.id;
    return sendMetaLeadEvent({
        eventName: process.env.META_CAPI_SELLER_LEAD_EVENT_NAME || DEFAULT_SELLER_LEAD_EVENT_NAME,
        eventId: eventId || tracking.metaLeadEventId || createEventId('seller_lead', userId),
        req,
        user,
        email: user?.email,
        phone,
        externalId: userId,
        tracking,
        leadEventSource: storeName
            ? `${process.env.META_CAPI_LEAD_EVENT_SOURCE || DEFAULT_LEAD_EVENT_SOURCE} Seller Signup`
            : process.env.META_CAPI_LEAD_EVENT_SOURCE || DEFAULT_LEAD_EVENT_SOURCE,
    });
};

const trackStoreVerificationLead = ({ req, store, user, email, phone, tracking = {} } = {}) => {
    const storeId = store?._id?.toString?.() || store?.id;
    const userId = user?._id?.toString?.() || user?.id || store?.seller?.toString?.();
    return sendMetaLeadEvent({
        eventName: process.env.META_CAPI_STORE_VERIFICATION_EVENT_NAME || DEFAULT_VERIFICATION_EVENT_NAME,
        eventId: createEventId('store_verification', storeId || userId),
        req,
        user,
        email: email || user?.email,
        phone,
        externalId: userId || storeId || email,
        tracking,
        leadEventSource: `${process.env.META_CAPI_LEAD_EVENT_SOURCE || DEFAULT_LEAD_EVENT_SOURCE} Store Verification`,
    });
};

module.exports = {
    DEFAULT_GRAPH_API_VERSION,
    buildUserData,
    createEventId,
    createFbcFromFbclid,
    isEnabled,
    sendMetaLeadEvent,
    sha256,
    trackSellerLead,
    trackStoreVerificationLead,
};
