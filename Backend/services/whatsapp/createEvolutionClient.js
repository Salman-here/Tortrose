// Factory that creates an Evolution API client bound to a specific instance.
// Docs: https://doc.evolution-api.com/v2/
//
// Usage:
//   const client = createEvolutionClient('EVOLUTION_INSTANCE_NAME', 'rozare-main');
//   const sellerClient = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');

const axios = require('axios');
const QRCode = require('qrcode');
const {
    collectAddressHints,
    phoneFromJid,
    isLidJid,
    isPhoneJid,
} = require('./addressing');
const {
    rememberInboundRoute,
    resolveOutboundRecipient,
} = require('./jidRoutingStore');
const {
    isZombieGatewayError,
    isZombieGatewayBody,
    reportZombieSignal,
} = require('./gatewayHealth');

// Shared helpers (not instance-specific)

const baseUrl = () => (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const apiKey = () => process.env.EVOLUTION_API_KEY || '';
const envBool = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return !['false', '0', 'no', 'off'].includes(String(raw).toLowerCase());
};

const lowLatencySettings = () => ({
    rejectCall: envBool('EVOLUTION_REJECT_CALLS', false),
    msgCall: process.env.EVOLUTION_CALL_MESSAGE || '',
    groupsIgnore: envBool('EVOLUTION_IGNORE_GROUPS', true),
    alwaysOnline: envBool('EVOLUTION_ALWAYS_ONLINE', true),
    // Do not let Evolution await read-receipt calls before emitting inbound
    // webhooks. The backend can reply without needing Evolution to pre-mark the
    // chat as read, and this avoids one slow WhatsApp read call blocking the
    // serial Baileys event queue.
    readMessages: envBool('EVOLUTION_READ_MESSAGES', false),
    readStatus: envBool('EVOLUTION_READ_STATUS', false),
    syncFullHistory: envBool('EVOLUTION_SYNC_FULL_HISTORY', false),
});

const makeClient = () => {
    const instance = axios.create({
        baseURL: baseUrl(),
        timeout: 25000,
        headers: { apikey: apiKey(), 'Content-Type': 'application/json' },
    });
    // Surface dead-socket ("Connection Closed") failures to the health monitor
    // so real traffic errors trigger recovery faster than the periodic probe.
    instance.interceptors?.response?.use(
        (response) => response,
        (err) => {
            if (isZombieGatewayError(err)) reportZombieSignal('evolution-request');
            return Promise.reject(err);
        }
    );
    return instance;
};
const recentRouteCache = new Map();
const RECENT_ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Turn a raw QR "code" string into a base64 PNG data URL.
const qrTextToDataUrl = async (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    if (raw.startsWith('data:')) return raw;
    if (/^[A-Za-z0-9+/=]{200,}$/.test(raw)) {
        return `data:image/png;base64,${raw}`;
    }
    try {
        return await QRCode.toDataURL(raw, { errorCorrectionLevel: 'L', margin: 1, width: 320 });
    } catch (err) {
        console.warn('[evolution] qrTextToDataUrl failed:', err.message);
        return '';
    }
};

// Best-effort: extract QR (base64 data URL) and pairing code from any v2 response shape.
const extractQrFromResponse = async (data) => {
    if (!data) return { base64: '', code: '', rawCode: '' };

    const src = data?.instance || data;

    const pairingCode = src?.pairingCode || data?.pairingCode || '';

    const rawCode = (typeof src?.code === 'string' && src.code.length > 20 ? src.code : '') ||
                    (typeof data?.code === 'string' && data.code.length > 20 ? data.code : '');

    const rawBase64 =
        src?.qrcode?.base64 ||
        data?.qrcode?.base64 ||
        src?.base64 ||
        data?.base64 ||
        '';

    let base64 = '';
    if (rawBase64) {
        base64 = rawBase64.startsWith('data:') ? rawBase64 : `data:image/png;base64,${rawBase64}`;
    } else if (rawCode) {
        base64 = await qrTextToDataUrl(rawCode);
    }

    return { base64, code: pairingCode, rawCode };
};

/**
 * Creates an Evolution API client bound to a specific instance name.
 * @param {string} instanceEnvVar - Environment variable name for the instance (e.g. 'EVOLUTION_INSTANCE_NAME')
 * @param {string} defaultName - Default instance name if env var is not set (e.g. 'rozare-main')
 * @returns {object} - All exported functions for this instance
 */
function createEvolutionClient(instanceEnvVar, defaultName) {
    const instanceName = () => process.env[instanceEnvVar] || defaultName;
    const isConfigured = () => Boolean(baseUrl() && apiKey());
    const client = () => makeClient();
    const instanceType = () => (
        instanceEnvVar === 'EVOLUTION_SELLER_INSTANCE_NAME' ||
        instanceName() === (process.env.EVOLUTION_SELLER_INSTANCE_NAME || 'rozare-seller')
            ? 'seller'
            : 'main'
    );

    const routeCacheKey = (phone) => `${instanceName()}:${phoneFromJid(phone)}`;

    const getCachedRecentRoute = (phone) => {
        const key = routeCacheKey(phone);
        const route = recentRouteCache.get(key);
        if (!route) return '';
        if (Date.now() - route.seenAt > RECENT_ROUTE_CACHE_TTL_MS) {
            recentRouteCache.delete(key);
            return '';
        }
        return route.lidJid;
    };

    const cacheRecentRoute = (phone, lidJid) => {
        if (!phone || !isLidJid(lidJid)) return;
        recentRouteCache.set(routeCacheKey(phone), { lidJid, seenAt: Date.now() });
    };

    const findRecentLidForPhone = async (phone) => {
        const digits = phoneFromJid(phone);
        if (!digits) return '';

        const cached = getCachedRecentRoute(digits);
        if (cached) return cached;

        try {
            const { data } = await client().post(`/chat/findMessages/${instanceName()}`, {});
            const records = data?.messages?.records || data?.records || [];
            for (const msg of records.slice(0, 100)) {
                const key = msg?.key || {};
                const hints = collectAddressHints(msg);
                const phoneCandidates = [
                    key.remoteJid,
                    key.remoteJidAlt,
                    key.participant,
                    key.participantAlt,
                    ...hints.phoneJids,
                    ...hints.phoneNumbers,
                ];
                const lidCandidates = [
                    key.remoteJid,
                    key.remoteJidAlt,
                    key.participant,
                    key.participantAlt,
                    ...hints.lidJids,
                ];
                const phoneMatches = phoneCandidates.some(candidate => phoneFromJid(candidate) === digits);
                const lidJid = lidCandidates.find(isLidJid) || '';
                if (phoneMatches && lidJid) {
                    cacheRecentRoute(digits, lidJid);
                    await rememberInboundRoute(
                        { identityPhone: digits, lidJid },
                        {
                            instanceType: instanceType(),
                            instanceName: instanceName(),
                            source: 'evolution-message-store',
                        }
                    ).catch(() => null);
                    return lidJid;
                }
            }
        } catch (err) {
            console.warn(`[evolution:${instanceName()}] recent LID lookup failed:`, err.response?.data || err.message);
        }

        return '';
    };

    const normalizeSendRecipient = async (number) => {
        if (isLidJid(number)) return number;
        if (isPhoneJid(number)) return number;
        const digits = phoneFromJid(number);
        if (!digits) return number;

        const stored = await resolveOutboundRecipient(digits, number, { instanceType: instanceType() });
        if (isLidJid(stored)) return stored;

        const recent = await findRecentLidForPhone(digits);
        if (recent) {
            console.log(`[evolution:${instanceName()}] routed recipient ${digits} to ${recent}`);
            return recent;
        }

        return number;
    };

    const createInstance = async () => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        try {
            const { data } = await client().post('/instance/create', {
                instanceName: instanceName(),
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS',
                ...lowLatencySettings(),
            });
            console.log(`[evolution:${instanceName()}] instance created:`, JSON.stringify(data).slice(0, 300));
            return data;
        } catch (err) {
            const msg = (err.response?.data?.message || err.response?.data?.response?.message || '').toString();
            const status = err.response?.status;
            if (status === 403 || status === 409 || /already|in use|exists/i.test(msg)) {
                console.log(`[evolution:${instanceName()}] instance already exists`);
                return { msg: 'instance_exists' };
            }
            throw err;
        }
    };

    const getQRCode = async () => {
        if (!isConfigured()) throw new Error('Evolution API not configured');

        let connectData = null;
        try {
            const resp = await client().get(`/instance/connect/${instanceName()}`);
            connectData = resp.data;
            console.log(`[evolution:${instanceName()}] /instance/connect response:`, JSON.stringify(connectData).slice(0, 300));
        } catch (err) {
            const status = err.response?.status;
            console.warn(`[evolution:${instanceName()}] /instance/connect failed:`, status, err.message);
            if (status === 404) {
                return { base64: '', code: '', state: 'not_found', raw: err.response?.data || null };
            }
        }

        if (connectData) {
            const { base64, code, rawCode } = await extractQrFromResponse(connectData);
            if (base64 || code) {
                return { base64, code, state: 'connecting', raw: connectData, rawCode };
            }
        }

        try {
            const { data: stateData } = await client().get(`/instance/connectionState/${instanceName()}`);
            const state = stateData?.instance?.state || stateData?.state || '';
            if (state === 'open') {
                return { base64: '', code: '', state: 'open', raw: stateData };
            }
            for (let attempt = 0; attempt < 5; attempt++) {
                await new Promise(r => setTimeout(r, 1200));
                try {
                    const { data: retry } = await client().get(`/instance/connect/${instanceName()}`);
                    const out = await extractQrFromResponse(retry);
                    if (out.base64 || out.code) {
                        return { base64: out.base64, code: out.code, state: 'connecting', raw: retry, rawCode: out.rawCode };
                    }
                } catch { /* try again */ }
            }
            return { base64: '', code: '', state: state || 'close', raw: stateData };
        } catch (err) {
            console.warn(`[evolution:${instanceName()}] /instance/connectionState failed:`, err.message);
            return { base64: '', code: '', state: 'close', raw: null };
        }
    };

    const getStatus = async () => {
        if (!isConfigured()) return { state: 'not_configured' };
        try {
            const { data } = await client().get(`/instance/connectionState/${instanceName()}`);
            return data?.instance || data || {};
        } catch (err) {
            if (err.response?.status === 404) {
                return { state: 'not_found', error: err.response?.data || err.message };
            }
            return { state: 'error', error: err.response?.data || err.message };
        }
    };

    const logout = async () => {
        if (!isConfigured()) return { msg: 'not_configured' };
        try {
            const { data } = await client().delete(`/instance/logout/${instanceName()}`);
            return data;
        } catch (err) {
            if (err.response?.status === 404) {
                return { status: 'SUCCESS', error: false, response: { message: 'Instance already absent' }, notFound: true };
            }
            return { error: err.response?.data || err.message };
        }
    };

    const deleteInstance = async () => {
        if (!isConfigured()) return { msg: 'not_configured' };
        try {
            const { data } = await client().delete(`/instance/delete/${instanceName()}`);
            return data;
        } catch (err) {
            if (err.response?.status === 404) {
                return { status: 'SUCCESS', error: false, response: { message: 'Instance already absent' }, notFound: true };
            }
            return { error: err.response?.data || err.message };
        }
    };

    const restartInstance = async () => {
        if (!isConfigured()) return { msg: 'not_configured' };
        // Evolution builds disagree on the verb: v2 docs say PUT, but some
        // 2.3.x builds only register POST ("Cannot PUT /instance/restart/…").
        // Try PUT first and fall back to POST on 404.
        try {
            const { data } = await client().put(`/instance/restart/${instanceName()}`);
            return data;
        } catch (putErr) {
            if (putErr.response?.status !== 404) {
                return { error: putErr.response?.data || putErr.message };
            }
            try {
                const { data } = await client().post(`/instance/restart/${instanceName()}`);
                return data;
            } catch (postErr) {
                return { error: postErr.response?.data || postErr.message };
            }
        }
    };

    const connectInstance = async () => {
        if (!isConfigured()) return { msg: 'not_configured' };
        try {
            const { data } = await client().get(`/instance/connect/${instanceName()}`);
            return data;
        } catch (err) {
            console.error(`[evolution:${instanceName()}] connectInstance error:`, err.message);
            return { error: err.response?.data || err.message };
        }
    };

    const requestPairingCode = async (phoneNumber) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        const cleanNumber = String(phoneNumber || '').replace(/[^0-9]/g, '');
        if (!cleanNumber) throw new Error('Phone number is required');
        try {
            const { data } = await client().get(`/instance/connect/${instanceName()}`, {
                params: { number: cleanNumber },
            });
            console.log(`[evolution:${instanceName()}] pairing-code response:`, JSON.stringify(data).slice(0, 300));
            return {
                code: data?.pairingCode || '',
                pairingCode: data?.pairingCode || '',
                rawQr: data?.code || '',
                raw: data,
            };
        } catch (err) {
            console.error(`[evolution:${instanceName()}] pairing-code failed:`, err.response?.data || err.message);
            throw err;
        }
    };

    const sendText = async (number, text) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        const recipient = await normalizeSendRecipient(number);
        const { data } = await client().post(`/message/sendText/${instanceName()}`, {
            number: recipient,
            text,
            delay: 0,
        });
        const messageId = data?.key?.id || data?.messageId || data?.id || '';
        return { messageId, raw: data };
    };

    /**
     * Send an image (media) message via WhatsApp.
     * @param {string} number - Recipient phone number
     * @param {string} mediaUrl - Public URL of the image
     * @param {string} caption - Optional caption text
     * @param {string} mediaType - 'image' (default), 'video', 'document'
     */
    const sendMedia = async (number, mediaUrl, caption = '', mediaType = 'image') => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        const recipient = await normalizeSendRecipient(number);
        const { data } = await client().post(`/message/sendMedia/${instanceName()}`, {
            number: recipient,
            mediatype: mediaType,
            media: mediaUrl,
            caption,
            delay: 0,
        });
        const messageId = data?.key?.id || data?.messageId || data?.id || '';
        return { messageId, raw: data };
    };

    const sendPoll = async (number, { name, values, selectableCount = 1 }) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        const recipient = await normalizeSendRecipient(number);
        const { data } = await client().post(`/message/sendPoll/${instanceName()}`, {
            number: recipient,
            name,
            selectableCount,
            values,
            delay: 0,
        });
        const messageId = data?.key?.id || data?.messageId || data?.id || '';
        return { messageId, raw: data };
    };

    const sendList = async (number, { title, description = '', buttonText, footerText = '', sections }) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        if (!Array.isArray(sections) || sections.length === 0) {
            throw new Error('sendList: sections array is required');
        }
        const recipient = await normalizeSendRecipient(number);
        const { data } = await client().post(`/message/sendList/${instanceName()}`, {
            number: recipient,
            title,
            description,
            buttonText,
            footerText,
            sections,
            delay: 0,
        });
        const messageId = data?.key?.id || data?.messageId || data?.id || '';
        return { messageId, raw: data };
    };

    const sendButtons = async (number, { title, description = '', footer = '', buttons }) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        if (!Array.isArray(buttons) || buttons.length === 0) {
            throw new Error('sendButtons: buttons array is required');
        }
        const payload = {
            number: await normalizeSendRecipient(number),
            title,
            description,
            footer,
            buttons: buttons.map((b) => ({
                type: b.type || 'reply',
                displayText: b.displayText,
                id: b.id,
            })),
            delay: 0,
        };
        const { data } = await client().post(`/message/sendButtons/${instanceName()}`, payload);
        const messageId = data?.key?.id || data?.messageId || data?.id || '';
        return { messageId, raw: data };
    };

    const setWebhook = async (url, secret = '') => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        // Field names differ across Evolution builds: v2.3.x reads `base64` /
        // `byEvents`, older builds read `webhookBase64` / `webhookByEvents`.
        // Send BOTH so inbound media base64 inlining survives a re-register on
        // any build (it drives whether voice notes / images / documents can be
        // ingested — inbound messages are not persisted, so re-download fails).
        // Media ingestion is a core product feature. Default to inline media
        // because inbound messages may not remain downloadable after the
        // webhook is acknowledged. Operators can still opt out explicitly.
        const base64Enabled = envBool('EVOLUTION_WEBHOOK_BASE64', true);
        const webhook = {
            enabled: true,
            url,
            byEvents: false,
            webhookByEvents: false,
            base64: base64Enabled,
            webhookBase64: base64Enabled,
            events: [
                'MESSAGES_UPSERT',
                'MESSAGES_UPDATE',
                'CONNECTION_UPDATE',
                'QRCODE_UPDATED',
                'LOGOUT_INSTANCE',
                'REMOVE_INSTANCE',
            ],
            ...(secret ? { headers: { 'x-rozare-webhook-secret': secret } } : {}),
        };
        // Evolution v2.3.x validates /webhook/set with a top-level `webhook`
        // object. Keep the flat fallback for older/self-hosted builds that
        // accepted the legacy shape.
        const payloads = [{ webhook }, webhook];
        let lastError = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            for (const payload of payloads) {
                try {
                    const { data } = await client().post(`/webhook/set/${instanceName()}`, payload);
                    return data;
                } catch (err) {
                    lastError = err;
                    const msg = JSON.stringify(err.response?.data || err.message || '');
                    const wrongShape = err.response?.status === 400 && /webhook/i.test(msg);
                    if (wrongShape && payload.webhook) continue;
                    if (err.response?.status !== 404 || attempt === 3) throw err;
                    break;
                }
            }
            if (lastError?.response?.status === 404) {
                await sleep(750 * (attempt + 1));
            }
        }
        throw lastError;
    };

    const setSettings = async (settings = {}) => {
        if (!isConfigured()) throw new Error('Evolution API not configured');
        const payload = { ...lowLatencySettings(), ...settings };
        const { data } = await client().post(`/settings/set/${instanceName()}`, payload);
        return data;
    };

    // Active liveness probe for the Baileys socket. connectionState can report
    // "open" while the underlying WebSocket is dead (zombie session), so we
    // issue a real socket operation (an onWhatsApp lookup) and classify the
    // failure shape. Returns { ok, zombie, error }.
    const probeSocketHealth = async (number) => {
        if (!isConfigured()) return { ok: false, zombie: false, error: 'not_configured' };
        const clean = String(number || '').replace(/\D/g, '');
        if (!clean) return { ok: false, zombie: false, error: 'no_probe_number' };
        try {
            const { data } = await client().post(`/chat/whatsappNumbers/${instanceName()}`, {
                numbers: [clean],
            });
            if (Array.isArray(data)) return { ok: true, zombie: false };
            // Some builds return the Boom error body with HTTP 200.
            if (isZombieGatewayBody(data)) {
                reportZombieSignal('health-probe');
                return { ok: false, zombie: true, error: 'connection_closed' };
            }
            return { ok: false, zombie: false, error: `unexpected_response:${JSON.stringify(data).slice(0, 120)}` };
        } catch (err) {
            if (isZombieGatewayError(err)) {
                return { ok: false, zombie: true, error: 'connection_closed' };
            }
            return { ok: false, zombie: false, error: err.response?.status ? `http_${err.response.status}` : err.message };
        }
    };

    const checkWhatsAppNumber = async (number) => {
        if (!isConfigured()) return null;
        const clean = String(number || '').replace(/\D/g, '');
        if (!clean) return false;
        try {
            const { data } = await client().post(`/chat/whatsappNumbers/${instanceName()}`, {
                numbers: [clean],
            });
            if (Array.isArray(data) && data.length > 0) {
                return Boolean(data[0]?.exists);
            }
            return null;
        } catch (err) {
            console.warn(`[evolution:${instanceName()}] checkWhatsAppNumber failed:`, err.response?.data || err.message);
            return null;
        }
    };

    return {
        createInstance,
        getQRCode,
        getStatus,
        logout,
        deleteInstance,
        restartInstance,
        connectInstance,
        requestPairingCode,
        sendText,
        sendMedia,
        sendPoll,
        sendList,
        sendButtons,
        setWebhook,
        setSettings,
        checkWhatsAppNumber,
        probeSocketHealth,
        isConfigured,
        instanceName,
    };
}

// Export shared helpers for use by other modules if needed
createEvolutionClient.qrTextToDataUrl = qrTextToDataUrl;
createEvolutionClient.extractQrFromResponse = extractQrFromResponse;

module.exports = createEvolutionClient;
