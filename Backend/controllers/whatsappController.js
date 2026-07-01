const WhatsAppConfig = require('../models/WhatsAppConfig');
const WhatsAppPendingMessage = require('../models/WhatsAppPendingMessage');
const evolution = require('../services/whatsapp/evolutionClient');
const {
    configKeyFor,
    useUnifiedWhatsAppInstance,
} = require('../services/whatsapp/gatewayMode');

const ensureSingleton = async () => {
    const singletonKey = configKeyFor('main');
    let cfg = await WhatsAppConfig.findOne({ singletonKey });
    if (!cfg) cfg = await WhatsAppConfig.create({ singletonKey });
    return cfg;
};

const normalizeGatewayState = (payload) => {
    const raw = payload?.state || payload?.status || payload?.connectionState || payload?.connectionStatus || payload?.instance?.state || '';
    const normalized = String(raw || '').trim().toLowerCase();

    if (['open', 'connected', 'online'].includes(normalized)) return 'open';
    if (['connecting', 'pairing', 'qr', 'pending_qr', 'pending'].includes(normalized)) return 'connecting';
    if (['close', 'closed', 'disconnected', 'logout', 'offline', 'not_found', 'missing', 'deleted'].includes(normalized)) return 'close';
    return normalized;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getLiveGatewayState = async (client) => {
    try {
        return normalizeGatewayState(await client.getStatus());
    } catch {
        return '';
    }
};

const clearConfigAfterDisconnect = async (singletonKey, instanceName = '') => {
    await WhatsAppConfig.updateOne(
        { singletonKey },
        {
            $set: {
                status: 'disconnected',
                instanceName,
                linkedNumber: '',
                linkedAt: null,
                lastQrBase64: '',
                lastQrFetchedAt: null,
                lastError: '',
                lastSeen: new Date(),
            },
        },
        { upsert: true }
    );
};

const mirrorUnifiedDisconnectState = async (primaryKey, instanceName = '') => {
    if (!useUnifiedWhatsAppInstance()) return;
    const mirrorKey = primaryKey === 'seller' ? 'main' : 'seller';
    await clearConfigAfterDisconnect(mirrorKey, instanceName).catch(() => null);
};

const forceDisconnectGateway = async (client, singletonKey) => {
    if (!client.isConfigured()) {
        await clearConfigAfterDisconnect(singletonKey, client.instanceName?.() || '');
        await mirrorUnifiedDisconnectState(singletonKey, client.instanceName?.() || '');
        return { disconnected: true, liveState: 'not_configured' };
    }

    const instanceName = client.instanceName?.() || '';
    const logoutResult = await client.logout().catch((err) => ({ error: err.response?.data || err.message }));
    await sleep(1200);

    let liveState = await getLiveGatewayState(client);
    let deleteResult = null;

    if (['open', 'connecting'].includes(liveState)) {
        deleteResult = await client.deleteInstance().catch((err) => ({ error: err.response?.data || err.message }));
        await sleep(1500);
        liveState = await getLiveGatewayState(client);
    }

    const disconnected = ['close', 'not_configured', ''].includes(liveState);
    if (!disconnected) {
        await WhatsAppConfig.updateOne(
            { singletonKey },
            {
                $set: {
                    status: liveState === 'open' ? 'connected' : 'error',
                    instanceName,
                    lastError: `Disconnect did not complete. Evolution still reports state: ${liveState}`,
                    lastSeen: new Date(),
                },
            },
            { upsert: true }
        );
        return { disconnected: false, liveState, logoutResult, deleteResult };
    }

    await clearConfigAfterDisconnect(singletonKey, instanceName);
    await mirrorUnifiedDisconnectState(singletonKey, instanceName);
    return { disconnected: true, liveState: liveState || 'close', logoutResult, deleteResult };
};

const toDataUrl = (value = '') => {
    if (!value || typeof value !== 'string') return '';
    return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
};

const pickQrPayload = (payload) => {
    if (!payload) return null;
    if (Array.isArray(payload)) return pickQrPayload(payload[0]);
    if (Array.isArray(payload?.data)) return pickQrPayload(payload.data[0]);
    if (Array.isArray(payload?.instances)) return pickQrPayload(payload.instances[0]);
    return payload?.instance || payload;
};

const extractInlineQr = (payload) => {
    const src = pickQrPayload(payload) || payload || {};
    const qrCodeStr = typeof src?.qrcode?.code === 'string' && src.qrcode.code.startsWith('data:')
        ? src.qrcode.code
        : '';
    const qrOrCodeStr = typeof src?.qrOrCode === 'string' ? src.qrOrCode : '';
    const qrOrCodeIsDataUrl = qrOrCodeStr.startsWith('data:');

    const base64 =
        src?.qrcode?.base64 ||
        src?.base64 ||
        (qrOrCodeIsDataUrl ? qrOrCodeStr : '') ||
        src?.qr ||
        src?.qrCode ||
        src?.codeBase64 ||
        qrCodeStr ||
        (typeof src?.qrcode === 'string' ? src.qrcode : '') ||
        '';

    const code =
        src?.qrcode?.code ||
        src?.pairingCode ||
        (!qrOrCodeIsDataUrl ? qrOrCodeStr : '') ||
        src?.code ||
        '';

    return { dataUrl: toDataUrl(base64), code: typeof code === 'string' ? code : '' };
};

const describeGatewayQrState = (payload) => {
    const src = pickQrPayload(payload) || payload || {};
    const count = Number(src?.count ?? src?.qrcode?.count ?? -1);
    const state = normalizeGatewayState(src);
    if (count === 0 && state === 'connecting') {
        return 'Gateway is connected to the instance but is returning count: 0, so the QR is not being generated upstream yet.';
    }
    if (count === 0) {
        return 'Gateway responded without a QR image yet (count: 0).';
    }
    return '';
};

const getGatewayErrorMessage = (err) => {
    const data = err?.response?.data;
    return data?.message || data?.msg || data?.error || err?.message || 'Unknown gateway error';
};

const QR_STUCK_THRESHOLD_MS = 45000;

const isStuckConnectingWithoutQr = (cfg, liveState) => {
    const hasConnectingSignal = liveState === 'connecting' || ['connecting', 'pending_qr'].includes(cfg?.status);
    if (!hasConnectingSignal) return false;
    if (cfg?.lastQrBase64) return false;

    const referenceAt = cfg?.lastQrFetchedAt || cfg?.lastSeen || cfg?.updatedAt || null;
    const lastAttemptAt = referenceAt ? new Date(referenceAt).getTime() : 0;
    if (!lastAttemptAt) return false;

    return (Date.now() - lastAttemptAt) > QR_STUCK_THRESHOLD_MS;
};

const recreateGatewayInstance = async () => {
    await evolution.logout().catch(() => null);
    await evolution.deleteInstance().catch(() => null);
    await new Promise(r => setTimeout(r, 1000)); // Wait 1s after delete
    const created = await evolution.createInstance().catch((e) => ({
        __error: getGatewayErrorMessage(e),
        __status: e.response?.status || 0,
    }));
    await new Promise(r => setTimeout(r, 2000)); // Wait 2s for instance to initialize
    await registerWebhookIfPossible();
    return created;
};

// Resolve the public-facing URL the Evolution API should POST webhooks to.
// Uses BACKEND_PUBLIC_URL if set, otherwise derives from the incoming request
// (works on Heroku thanks to x-forwarded-proto / host headers).
const resolveWebhookUrl = (req) => {
    if (process.env.BACKEND_PUBLIC_URL) {
        return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '') + '/api/whatsapp/webhook';
    }
    if (!req) return '';
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) return '';
    return `${proto}://${host}/api/whatsapp/webhook`;
};

// Best-effort webhook registration — safe to call multiple times.
// Called after createInstance so Evolution knows where to POST events.
const registerWebhookIfPossible = async (req = null) => {
    try {
        if (!evolution.isConfigured()) return;
        const url = resolveWebhookUrl(req);
        if (!url) {
            console.warn('[whatsapp] webhook URL could not be resolved (set BACKEND_PUBLIC_URL)');
            return;
        }
        const secret = process.env.EVOLUTION_WEBHOOK_SECRET || '';
        await evolution.setWebhook(url, secret);
        console.log('[whatsapp] webhook registered with Evolution:', url);
    } catch (err) {
        // Non-fatal — the admin panel still works, webhooks just won't flow
        console.warn('[whatsapp] setWebhook failed (non-fatal):', err.response?.data || err.message);
    }
};

const requestGatewayQr = async (startingState = '', req = null) => {
    // Evolution API v2.x: Create instance (QR is auto-generated)
    const created = await evolution.createInstance().catch((e) => {
        console.warn('whatsapp.createInstance warn:', e.response?.data || e.message);
        return { __error: getGatewayErrorMessage(e), __status: e.response?.status || 0 };
    });

    // Register webhook immediately after instance exists (idempotent — safe to call repeatedly)
    // This ensures poll votes flow back to the backend the moment WhatsApp is linked.
    await sleep(1500);
    await registerWebhookIfPossible(req);

    const createdQr = extractInlineQr(created);
    let dataUrl = createdQr.dataUrl;
    let code = createdQr.code;
    let qrState = normalizeGatewayState(pickQrPayload(created) || created) || startingState;
    let recoverableGatewayFailure = Number(created?.__status) >= 500;
    let gatewayDiagnostic = describeGatewayQrState(created);

    // Evolution API v2.x: Fetch QR code from instance data
    const qr = await evolution.getQRCode().catch((e) => ({
        base64: '',
        code: '',
        state: '',
        raw: e.response?.data || null,
        __error: getGatewayErrorMessage(e),
        __status: e.response?.status || 0,
    }));

    dataUrl = toDataUrl(qr.base64) || dataUrl;
    code = qr.code || code;
    qrState = normalizeGatewayState(qr.raw) || normalizeGatewayState({ state: qr.state }) || qrState;
    recoverableGatewayFailure = recoverableGatewayFailure || Number(qr.__status) >= 500;
    gatewayDiagnostic = describeGatewayQrState(qr.raw) || gatewayDiagnostic;

    if (!dataUrl && !code) {
        console.warn('whatsapp.connect: empty QR raw =', JSON.stringify(qr.raw)?.slice(0, 500));
    }

    return { dataUrl, code, qrState, recoverableGatewayFailure, gatewayDiagnostic };
};

// GET /api/whatsapp/status — admin
exports.getStatus = async (req, res) => {
    try {
        const cfg = await ensureSingleton();

        let liveState = null;
        if (evolution.isConfigured()) {
            try { liveState = await evolution.getStatus(); } catch { liveState = null; }
        }

        // Reconcile DB with live Evolution status
        // BUT skip reconciliation if status was explicitly changed in the last 5s
        // (prevents getStatus from immediately overriding a fresh disconnect/connect)
        const recentlyUpdated = cfg.updatedAt && (Date.now() - new Date(cfg.updatedAt).getTime() < 5000);
        const normalizedLiveState = normalizeGatewayState(liveState);
        if (!recentlyUpdated) {
            if (normalizedLiveState === 'open' && cfg.status !== 'connected') {
                cfg.status = 'connected';
                cfg.linkedAt = cfg.linkedAt || new Date();
                cfg.lastSeen = new Date();
                cfg.lastError = '';
                await cfg.save();
            } else if (normalizedLiveState === 'close' && ['connected', 'connecting', 'pending_qr', 'error'].includes(cfg.status)) {
                cfg.status = 'disconnected';
                cfg.lastQrBase64 = '';
                cfg.lastError = '';
                await cfg.save();
            }
        }

        res.json({
            configured: evolution.isConfigured(),
            status: cfg.status,
            linkedNumber: cfg.linkedNumber,
            linkedAt: cfg.linkedAt,
            lastSeen: cfg.lastSeen,
            instanceName: cfg.instanceName || evolution.instanceName(),
            sentInLastHour: cfg.sentInLastHour,
            lastError: cfg.lastError,
            qrBase64: cfg.lastQrBase64 || '',
            liveState: normalizedLiveState || liveState?.state || null,
        });
    } catch (err) {
        console.error('whatsapp.getStatus:', err.message);
        res.status(500).json({ msg: 'Failed to fetch WhatsApp status' });
    }
};

// POST /api/whatsapp/connect — admin: ensure instance + return QR
exports.connect = async (req, res) => {
    let cfg = null;
    try {
        if (!evolution.isConfigured()) {
            return res.status(400).json({
                msg: 'WhatsApp gateway is not configured. Add EVOLUTION_API_URL and EVOLUTION_API_KEY in backend secrets, then redeploy.',
            });
        }
        cfg = await ensureSingleton();
        cfg.instanceName = evolution.instanceName();

        let liveState = '';
        try {
            liveState = normalizeGatewayState(await evolution.getStatus());
        } catch {
            liveState = '';
        }

        if (liveState === 'open') {
            cfg.status = 'connected';
            cfg.linkedAt = cfg.linkedAt || new Date();
            cfg.lastSeen = new Date();
            cfg.lastError = '';
            await cfg.save();
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                msg: 'WhatsApp is already linked.',
                alreadyLinked: true,
            });
        }

        let autoRecovered = false;
        let recoveryMessage = '';
        let { dataUrl, code, qrState, recoverableGatewayFailure, gatewayDiagnostic } = await requestGatewayQr(liveState, req);

        // Disable auto-recreation to prevent spam when Evolution API has network issues
        // User can manually click "Reset instance" button if needed
        /*
        if (!dataUrl && !code && isStuckConnectingWithoutQr(cfg, qrState || liveState)) {
            console.warn('whatsapp.connect: instance stuck in connecting without QR, recreating gateway instance');
            await recreateGatewayInstance();
            ({ dataUrl, code, qrState, recoverableGatewayFailure, gatewayDiagnostic } = await requestGatewayQr(''));
            autoRecovered = true;
            recoveryMessage = 'The previous link session was stuck, so a fresh WhatsApp session was started automatically.';
        }
        */

        cfg.status = qrState === 'open' ? 'connected' : (qrState === 'connecting' ? 'connecting' : 'pending_qr');
        cfg.lastQrBase64 = dataUrl || cfg.lastQrBase64 || '';
        cfg.lastQrFetchedAt = new Date();
        cfg.lastSeen = new Date();
        cfg.lastError = (!dataUrl && !code && gatewayDiagnostic) ? gatewayDiagnostic.slice(0, 500) : '';
        await cfg.save();

        if (cfg.status === 'connected') {
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                msg: 'WhatsApp linked successfully.',
                alreadyLinked: true,
            });
        }

        if (!dataUrl && !code && cfg.lastQrBase64) {
            return res.json({
                status: cfg.status,
                qrBase64: cfg.lastQrBase64,
                code: '',
                cached: true,
                fallback: true,
                retryable: true,
                msg: 'Showing the last available QR while the gateway refreshes a new one.',
            });
        }

        if (!dataUrl && !code) {
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                fallback: true,
                retryable: true,
                recovered: autoRecovered,
                gatewayState: qrState || 'unknown',
                gatewayDiagnostic,
                msg: autoRecovered
                    ? `${recoveryMessage} If the QR still does not appear within a few seconds, the gateway itself is not producing one yet.`
                    : (recoverableGatewayFailure
                        ? 'WhatsApp gateway is still preparing the QR. Keep this window open and retry in a few seconds.'
                        : 'QR is not ready yet. Keep this window open and retry in a few seconds.'),
            });
        }

        res.json({ status: cfg.status, qrBase64: dataUrl, code, fallback: false, recovered: autoRecovered, msg: recoveryMessage });
    } catch (err) {
        const msg = getGatewayErrorMessage(err);
        const gatewayStatus = Number(err?.response?.status || 0);
        const fallback = gatewayStatus >= 500;

        if (cfg) {
            cfg.status = fallback ? 'pending_qr' : 'error';
            cfg.lastError = fallback ? '' : String(msg).slice(0, 500);
            cfg.lastSeen = new Date();
            await cfg.save().catch(() => null);
        } else {
            await WhatsAppConfig.updateOne(
                { singletonKey: configKeyFor('main') },
                { $set: { status: fallback ? 'pending_qr' : 'error', lastError: fallback ? '' : String(msg).slice(0, 500) } }
            ).catch(() => null);
        }

        console.error('whatsapp.connect:', msg);

        if (fallback) {
            return res.json({
                status: 'pending_qr',
                qrBase64: '',
                code: '',
                fallback: true,
                retryable: true,
                msg: 'WhatsApp gateway is temporarily unavailable, but the link session is still active. Retry in a few seconds.',
            });
        }

        res.status(500).json({ msg: 'Failed to start WhatsApp connection: ' + msg });
    }
};

// POST /api/whatsapp/disconnect — admin
exports.disconnect = async (req, res) => {
    try {
        const result = await forceDisconnectGateway(evolution, configKeyFor('main'));
        if (!result.disconnected) {
            return res.status(502).json({
                msg: `Evolution still reports WhatsApp as ${result.liveState}. Try again in a few seconds or delete the instance from Evolution Manager.`,
                liveState: result.liveState,
            });
        }
        res.json({ msg: 'Disconnected', ...result });
    } catch (err) {
        console.error('whatsapp.disconnect:', err.message);
        res.status(500).json({ msg: 'Failed to disconnect' });
    }
};

// POST /api/whatsapp/pairing-code — admin: request pairing code with phone number
exports.requestPairingCode = async (req, res) => {
    try {
        if (!evolution.isConfigured()) {
            return res.status(400).json({ msg: 'WhatsApp gateway is not configured.' });
        }

        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ msg: 'Phone number is required' });
        }

        // Phone number should be digits only (e.g., 923001234567)
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10) {
            return res.status(400).json({ msg: 'Invalid phone number format. Use country code + number (e.g., 923001234567)' });
        }

        const cfg = await ensureSingleton();

        // Create instance if not exists
        await evolution.createInstance().catch(() => null);

        // Make sure the webhook is registered so the voted events flow back when the user links.
        await registerWebhookIfPossible(req);

        // Request pairing code
        const result = await evolution.requestPairingCode(cleanNumber).catch((e) => {
            console.error('Pairing code request failed:', e.response?.data || e.message);
            return { error: e.response?.data || e.message };
        });

        if (result.error) {
            return res.status(500).json({ 
                msg: 'Failed to request pairing code', 
                error: result.error 
            });
        }

        // Extract pairing code from response
        const code = result.code || result.pairingCode || result.data?.code || result.data?.pairingCode || '';

        cfg.status = 'connecting';
        cfg.lastSeen = new Date();
        await cfg.save();

        res.json({ 
            code, 
            msg: code ? 'Pairing code generated' : 'Pairing code requested - check instance status',
            raw: result 
        });
    } catch (err) {
        console.error('whatsapp.requestPairingCode:', err.message);
        res.status(500).json({ msg: 'Failed to request pairing code: ' + err.message });
    }
};

// POST /api/whatsapp/reset — admin: hard-reset the gateway instance.
// Only allowed when not currently linked, to avoid blowing away a healthy session.
exports.reset = async (req, res) => {
    try {
        if (!evolution.isConfigured()) {
            return res.status(400).json({ msg: 'WhatsApp gateway is not configured.' });
        }

        const cfg = await ensureSingleton();

        // Refuse if currently connected — caller should use Disconnect instead.
        let liveState = '';
        try { liveState = normalizeGatewayState(await evolution.getStatus()); } catch { liveState = ''; }
        if (liveState === 'open' || cfg.status === 'connected') {
            return res.status(409).json({
                msg: 'WhatsApp is currently linked. Disconnect first before resetting the instance.',
            });
        }

        // Best-effort: log out any half-open session, then delete the instance.
        await evolution.logout().catch(() => null);
        await sleep(1200);
        const deleted = await evolution.deleteInstance().catch((e) => ({ error: e.message }));
        await sleep(1500);

        // Reset the singleton so the next connect starts from a clean slate.
        cfg.status = 'disconnected';
        cfg.linkedNumber = '';
        cfg.linkedAt = null;
        cfg.lastQrBase64 = '';
        cfg.lastQrFetchedAt = null;
        cfg.lastError = '';
        cfg.lastSeen = new Date();
        await cfg.save();
        await mirrorUnifiedDisconnectState(configKeyFor('main'), evolution.instanceName?.() || '');

        // Recreate immediately so the next "Link WhatsApp" can return a fresh QR.
        const created = await evolution.createInstance().catch((e) => ({ error: e.message }));

        // Re-register webhook so poll votes flow back once the user scans the fresh QR.
        await sleep(1500);
        await registerWebhookIfPossible(req);

        return res.json({
            msg: 'WhatsApp instance reset. Click "Link WhatsApp" to scan a new QR.',
            deleted,
            created,
        });
    } catch (err) {
        console.error('whatsapp.reset:', err.message);
        return res.status(500).json({ msg: 'Failed to reset WhatsApp instance: ' + err.message });
    }
};

// GET /api/whatsapp/queue — admin: recent activity (supports filter & pagination)
exports.getQueue = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
        const filter = req.query.filter || 'all';
        const skip = (page - 1) * limit;

        // Build status filter
        let statusFilter = {};
        if (filter === 'sent') statusFilter = { status: { $in: ['sent', 'voted_yes', 'voted_no'] } };
        else if (filter === 'queued') statusFilter = { status: 'queued' };
        else if (filter === 'failed') statusFilter = { status: { $in: ['failed', 'failed_invalid_number'] } };
        else if (filter === 'cancelled') statusFilter = { status: 'voted_no' };
        else if (filter === 'confirmed') statusFilter = { status: 'voted_yes' };
        else if (filter === 'expired') statusFilter = { status: 'expired' };
        // 'all' = no filter

        const [items, totalCount] = await Promise.all([
            WhatsAppPendingMessage.find(statusFilter)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('orderId phone status attempts lastError sentAt repliedAt createdAt updatedAt order'),
            WhatsAppPendingMessage.countDocuments(statusFilter),
        ]);

        // Mask middle digits of phone and include current order status
        const Order = require('../models/Order');
        const orderIds = items.map(it => it.order).filter(Boolean);
        const orders = await Order.find({ _id: { $in: orderIds } }).select('orderStatus confirmation.cancelledFromDashboardAt').lean();
        const orderMap = {};
        orders.forEach(o => { orderMap[o._id.toString()] = o; });

        const masked = items.map(it => {
            const obj = it.toObject();
            const p = obj.phone || '';
            obj.phone = p.length > 6 ? `${p.slice(0, 3)}••••${p.slice(-3)}` : p;
            const linkedOrder = obj.order ? orderMap[obj.order.toString()] : null;
            obj.currentOrderStatus = linkedOrder?.orderStatus || null;
            obj.cancelledAfterConfirm = !!(linkedOrder?.confirmation?.cancelledFromDashboardAt);
            delete obj.order;
            return obj;
        });
        res.json({ items: masked, total: totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) });
    } catch (err) {
        console.error('whatsapp.getQueue:', err.message);
        res.status(500).json({ msg: 'Failed to fetch queue' });
    }
};

// POST /api/whatsapp/queue/:id/retry — admin: retry a failed message.
// Re-normalises the phone from the linked order (so fixing shippingInfo.phone
// in the admin UI before retrying works), resets attempts, and re-queues.
exports.retryQueueItem = async (req, res) => {
    try {
        const Order = require('../models/Order');
        const { normalizePhone } = require('../services/whatsapp/messageBuilder');

        const job = await WhatsAppPendingMessage.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Queue item not found' });

        const order = await Order.findById(job.order);
        if (!order) return res.status(404).json({ msg: 'Linked order not found' });

        const freshPhone = normalizePhone(order.shippingInfo?.phone);
        if (!freshPhone || freshPhone.length < 8) {
            return res.status(400).json({
                msg: `Order phone "${order.shippingInfo?.phone}" is still invalid after normalisation. Update the shipping phone first.`,
            });
        }

        job.phone = freshPhone;
        job.status = 'queued';
        job.attempts = 0;
        job.lastError = '';
        job.nextAttemptAt = new Date(Date.now() + 2000); // retry in 2s
        await job.save();

        res.json({
            msg: 'Queued for retry',
            phone: `${freshPhone.slice(0, 3)}••••${freshPhone.slice(-3)}`,
            orderId: job.orderId,
        });
    } catch (err) {
        console.error('whatsapp.retryQueueItem:', err.message);
        res.status(500).json({ msg: 'Failed to retry: ' + err.message });
    }
};

// GET /api/whatsapp/stats — admin: aggregate analytics
exports.getStats = async (req, res) => {
    try {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const Order = require('../models/Order');

        const [byStatus, last24h, last7d, total, recentSeries, avgResponse, neverQueued] = await Promise.all([
            WhatsAppPendingMessage.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } },
            ]),
            WhatsAppPendingMessage.countDocuments({ createdAt: { $gte: dayAgo } }),
            WhatsAppPendingMessage.countDocuments({ createdAt: { $gte: weekAgo } }),
            WhatsAppPendingMessage.countDocuments({}),
            WhatsAppPendingMessage.aggregate([
                { $match: { createdAt: { $gte: weekAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        sent: { $sum: { $cond: [{ $in: ['$status', ['sent', 'voted_yes', 'voted_no']] }, 1, 0] } },
                        confirmed: { $sum: { $cond: [{ $eq: ['$status', 'voted_yes'] }, 1, 0] } },
                        declined: { $sum: { $cond: [{ $eq: ['$status', 'voted_no'] }, 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            WhatsAppPendingMessage.aggregate([
                { $match: { repliedAt: { $ne: null }, sentAt: { $ne: null } } },
                {
                    $project: {
                        responseMs: { $subtract: ['$repliedAt', '$sentAt'] },
                    },
                },
                { $group: { _id: null, avg: { $avg: '$responseMs' } } },
            ]),
            // Count orders where WhatsApp failed at enqueue stage (never queued)
            Order.countDocuments({
                'confirmation.whatsappSentSuccess': false,
                'confirmation.whatsappError': { $ne: '' },
                createdAt: { $gte: weekAgo },
            }),
        ]);

        const counts = byStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {});
        const sent = (counts.sent || 0) + (counts.voted_yes || 0) + (counts.voted_no || 0);
        const confirmed = counts.voted_yes || 0;
        const declined = counts.voted_no || 0;
        const failedSend = counts.failed || 0;
        const invalidNumber = counts.failed_invalid_number || 0;
        const failed = failedSend + invalidNumber;
        const queued = counts.queued || 0;
        const expired = counts.expired || 0;
        const replied = confirmed + declined;
        const responseRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
        const confirmationRate = replied > 0 ? Math.round((confirmed / replied) * 100) : 0;
        const avgResponseMinutes = avgResponse[0]?.avg ? Math.round(avgResponse[0].avg / 60000) : null;

        // Fill in missing days so timeline always has exactly 7 entries
        const seriesMap = {};
        recentSeries.forEach(d => { seriesMap[d._id] = d; });
        const timeline = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10);
            const entry = seriesMap[key];
            timeline.push({
                date: key,
                sent: entry?.sent || 0,
                confirmed: entry?.confirmed || 0,
                declined: entry?.declined || 0,
            });
        }

        res.json({
            total,
            last24h,
            last7d,
            sent,
            confirmed,
            declined,
            failed,
            failedSend,
            invalidNumber,
            neverQueued,
            queued,
            expired,
            responseRate,
            confirmationRate,
            avgResponseMinutes,
            timeline,
        });
    } catch (err) {
        console.error('whatsapp.getStats:', err.message);
        res.status(500).json({ msg: 'Failed to fetch WhatsApp stats' });
    }
};

// Public webhook receiver (signed via header)
exports.webhook = require('../services/whatsapp/webhookHandler').handleEvolutionWebhook;

// ── Seller-instance management (admin only) ──────────────────────────────────
// These mirror the main instance endpoints but target the seller-notification instance.

const sellerEvolution = require('../services/whatsapp/sellerEvolutionClient');

const ensureSellerSingleton = async () => {
    const singletonKey = configKeyFor('seller');
    let cfg = await WhatsAppConfig.findOne({ singletonKey });
    if (!cfg) cfg = await WhatsAppConfig.create({ singletonKey });
    return cfg;
};

// Best-effort seller webhook registration — so we get CONNECTION_UPDATE events.
const registerSellerWebhookIfPossible = async (req = null) => {
    try {
        if (!sellerEvolution.isConfigured()) return;
        const url = resolveWebhookUrl(req);
        if (!url) {
            console.warn('[whatsapp:seller] webhook URL could not be resolved (set BACKEND_PUBLIC_URL)');
            return;
        }
        const secret = process.env.EVOLUTION_WEBHOOK_SECRET || '';
        await sellerEvolution.setWebhook(url, secret);
        console.log('[whatsapp:seller] webhook registered with Evolution:', url);
    } catch (err) {
        console.warn('[whatsapp:seller] setWebhook failed (non-fatal):', err.response?.data || err.message);
    }
};

// GET /api/whatsapp/seller/status — admin
exports.getSellerStatus = async (req, res) => {
    try {
        const cfg = await ensureSellerSingleton();

        let liveState = null;
        if (sellerEvolution.isConfigured()) {
            try { liveState = await sellerEvolution.getStatus(); } catch { liveState = null; }
        }

        // Reconcile DB with live Evolution status
        // Skip reconciliation if status was explicitly changed in the last 5s
        const recentlyUpdated = cfg.updatedAt && (Date.now() - new Date(cfg.updatedAt).getTime() < 5000);
        const normalizedLiveState = normalizeGatewayState(liveState);
        if (!recentlyUpdated) {
            if (normalizedLiveState === 'open' && cfg.status !== 'connected') {
                cfg.status = 'connected';
                cfg.linkedAt = cfg.linkedAt || new Date();
                cfg.lastSeen = new Date();
                cfg.lastError = '';
                await cfg.save();
            } else if (normalizedLiveState === 'close' && ['connected', 'connecting', 'pending_qr', 'error'].includes(cfg.status)) {
                cfg.status = 'disconnected';
                cfg.lastQrBase64 = '';
                cfg.lastError = '';
                await cfg.save();
            }
        }

        res.json({
            configured: sellerEvolution.isConfigured(),
            status: cfg.status,
            linkedNumber: cfg.linkedNumber,
            linkedAt: cfg.linkedAt,
            lastSeen: cfg.lastSeen,
            instanceName: cfg.instanceName || sellerEvolution.instanceName(),
            sentInLastHour: cfg.sentInLastHour,
            lastError: cfg.lastError,
            qrBase64: cfg.lastQrBase64 || '',
            liveState: normalizedLiveState || liveState?.state || null,
        });
    } catch (err) {
        console.error('whatsapp.getSellerStatus:', err.message);
        res.status(500).json({ msg: 'Failed to fetch seller WhatsApp status' });
    }
};

// POST /api/whatsapp/seller/connect — admin: ensure seller instance + return QR
exports.sellerConnect = async (req, res) => {
    let cfg = null;
    try {
        if (!sellerEvolution.isConfigured()) {
            return res.status(400).json({
                msg: 'WhatsApp gateway is not configured. Add EVOLUTION_API_URL and EVOLUTION_API_KEY in backend secrets, then redeploy.',
            });
        }
        cfg = await ensureSellerSingleton();
        cfg.instanceName = sellerEvolution.instanceName();

        let liveState = '';
        try {
            liveState = normalizeGatewayState(await sellerEvolution.getStatus());
        } catch {
            liveState = '';
        }

        if (liveState === 'open') {
            cfg.status = 'connected';
            cfg.linkedAt = cfg.linkedAt || new Date();
            cfg.lastSeen = new Date();
            cfg.lastError = '';
            await cfg.save();
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                msg: 'Seller WhatsApp is already linked.',
                alreadyLinked: true,
            });
        }

        // Create instance + get QR
        const created = await sellerEvolution.createInstance().catch((e) => {
            console.warn('whatsapp.seller.createInstance warn:', e.response?.data || e.message);
            return { __error: getGatewayErrorMessage(e), __status: e.response?.status || 0 };
        });

        await sleep(1500);
        await registerSellerWebhookIfPossible(req);

        const createdQr = extractInlineQr(created);
        let dataUrl = createdQr.dataUrl;
        let code = createdQr.code;
        let qrState = normalizeGatewayState(pickQrPayload(created) || created) || liveState;
        let gatewayDiagnostic = describeGatewayQrState(created);

        // Fetch QR code
        const qr = await sellerEvolution.getQRCode().catch((e) => ({
            base64: '',
            code: '',
            state: '',
            raw: e.response?.data || null,
            __error: getGatewayErrorMessage(e),
            __status: e.response?.status || 0,
        }));

        dataUrl = toDataUrl(qr.base64) || dataUrl;
        code = qr.code || code;
        qrState = normalizeGatewayState(qr.raw) || normalizeGatewayState({ state: qr.state }) || qrState;
        gatewayDiagnostic = describeGatewayQrState(qr.raw) || gatewayDiagnostic;

        if (!dataUrl && !code) {
            console.warn('whatsapp.seller.connect: empty QR raw =', JSON.stringify(qr.raw)?.slice(0, 500));
        }

        cfg.status = qrState === 'open' ? 'connected' : (qrState === 'connecting' ? 'connecting' : 'pending_qr');
        cfg.lastQrBase64 = dataUrl || cfg.lastQrBase64 || '';
        cfg.lastQrFetchedAt = new Date();
        cfg.lastSeen = new Date();
        cfg.lastError = (!dataUrl && !code && gatewayDiagnostic) ? gatewayDiagnostic.slice(0, 500) : '';
        await cfg.save();

        if (cfg.status === 'connected') {
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                msg: 'Seller WhatsApp linked successfully.',
                alreadyLinked: true,
            });
        }

        if (!dataUrl && !code && cfg.lastQrBase64) {
            return res.json({
                status: cfg.status,
                qrBase64: cfg.lastQrBase64,
                code: '',
                cached: true,
                fallback: true,
                retryable: true,
                msg: 'Showing the last available QR while the gateway refreshes a new one.',
            });
        }

        if (!dataUrl && !code) {
            return res.json({
                status: cfg.status,
                qrBase64: '',
                code: '',
                fallback: true,
                retryable: true,
                gatewayState: qrState || 'unknown',
                gatewayDiagnostic,
                msg: 'QR is not ready yet. Keep this window open and retry in a few seconds.',
            });
        }

        res.json({ status: cfg.status, qrBase64: dataUrl, code, fallback: false });
    } catch (err) {
        const msg = getGatewayErrorMessage(err);
        const gatewayStatus = Number(err?.response?.status || 0);
        const fallback = gatewayStatus >= 500;

        if (cfg) {
            cfg.status = fallback ? 'pending_qr' : 'error';
            cfg.lastError = fallback ? '' : String(msg).slice(0, 500);
            cfg.lastSeen = new Date();
            await cfg.save().catch(() => null);
        } else {
            await WhatsAppConfig.updateOne(
                { singletonKey: configKeyFor('seller') },
                { $set: { status: fallback ? 'pending_qr' : 'error', lastError: fallback ? '' : String(msg).slice(0, 500) } }
            ).catch(() => null);
        }

        console.error('whatsapp.sellerConnect:', msg);

        if (fallback) {
            return res.json({
                status: 'pending_qr',
                qrBase64: '',
                code: '',
                fallback: true,
                retryable: true,
                msg: 'WhatsApp gateway is temporarily unavailable. Retry in a few seconds.',
            });
        }

        res.status(500).json({ msg: 'Failed to start seller WhatsApp connection: ' + msg });
    }
};

// POST /api/whatsapp/seller/disconnect — admin
exports.sellerDisconnect = async (req, res) => {
    try {
        const result = await forceDisconnectGateway(sellerEvolution, configKeyFor('seller'));
        if (!result.disconnected) {
            return res.status(502).json({
                msg: `Evolution still reports WhatsApp as ${result.liveState}. Try again in a few seconds or delete the instance from Evolution Manager.`,
                liveState: result.liveState,
            });
        }
        res.json({ msg: 'Seller WhatsApp disconnected', ...result });
    } catch (err) {
        console.error('whatsapp.sellerDisconnect:', err.message);
        res.status(500).json({ msg: 'Failed to disconnect seller WhatsApp' });
    }
};

// POST /api/whatsapp/seller/reset — admin: hard-reset the seller gateway instance.
exports.sellerReset = async (req, res) => {
    try {
        if (!sellerEvolution.isConfigured()) {
            return res.status(400).json({ msg: 'WhatsApp gateway is not configured.' });
        }

        const cfg = await ensureSellerSingleton();

        // Refuse if currently connected
        let liveState = '';
        try { liveState = normalizeGatewayState(await sellerEvolution.getStatus()); } catch { liveState = ''; }
        if (liveState === 'open' || cfg.status === 'connected') {
            return res.status(409).json({
                msg: 'Seller WhatsApp is currently linked. Disconnect first before resetting the instance.',
            });
        }

        // Log out + delete
        await sellerEvolution.logout().catch(() => null);
        await sleep(1200);
        const deleted = await sellerEvolution.deleteInstance().catch((e) => ({ error: e.message }));
        await sleep(1500);

        // Reset DB config
        cfg.status = 'disconnected';
        cfg.linkedNumber = '';
        cfg.linkedAt = null;
        cfg.lastQrBase64 = '';
        cfg.lastQrFetchedAt = null;
        cfg.lastError = '';
        cfg.lastSeen = new Date();
        await cfg.save();
        await mirrorUnifiedDisconnectState(configKeyFor('seller'), sellerEvolution.instanceName?.() || '');

        // Recreate immediately
        const created = await sellerEvolution.createInstance().catch((e) => ({ error: e.message }));
        await sleep(1500);
        await registerSellerWebhookIfPossible(req);

        return res.json({
            msg: 'Seller WhatsApp instance reset. Click "Link WhatsApp" to scan a new QR.',
            deleted,
            created,
        });
    } catch (err) {
        console.error('whatsapp.sellerReset:', err.message);
        return res.status(500).json({ msg: 'Failed to reset seller WhatsApp instance: ' + err.message });
    }
};

// POST /api/whatsapp/seller/pairing-code — admin: request pairing code for seller instance
exports.sellerRequestPairingCode = async (req, res) => {
    try {
        if (!sellerEvolution.isConfigured()) {
            return res.status(400).json({ msg: 'WhatsApp gateway is not configured.' });
        }

        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ msg: 'Phone number is required' });
        }

        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10) {
            return res.status(400).json({ msg: 'Invalid phone number format. Use country code + number (e.g., 923001234567)' });
        }

        const cfg = await ensureSellerSingleton();

        // Create instance if not exists
        await sellerEvolution.createInstance().catch(() => null);
        await registerSellerWebhookIfPossible(req);

        // Request pairing code
        const result = await sellerEvolution.requestPairingCode(cleanNumber).catch((e) => {
            console.error('Seller pairing code request failed:', e.response?.data || e.message);
            return { error: e.response?.data || e.message };
        });

        if (result.error) {
            return res.status(500).json({
                msg: 'Failed to request seller pairing code',
                error: result.error,
            });
        }

        const code = result.code || result.pairingCode || result.data?.code || result.data?.pairingCode || '';

        cfg.status = 'connecting';
        cfg.lastSeen = new Date();
        await cfg.save();

        res.json({
            code,
            msg: code ? 'Seller pairing code generated' : 'Pairing code requested - check instance status',
            raw: result,
        });
    } catch (err) {
        console.error('whatsapp.sellerRequestPairingCode:', err.message);
        res.status(500).json({ msg: 'Failed to request seller pairing code: ' + err.message });
    }
};

// ── Seller Notification Activity & Stats (admin only) ────────────────────────

const SellerNotificationLog = require('../models/SellerNotificationLog');

// GET /api/whatsapp/seller/queue — admin: seller notification activity (filter + pagination)
exports.getSellerQueue = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 15));
        const filter = req.query.filter || 'all';
        const skip = (page - 1) * limit;

        let statusFilter = {};
        if (filter === 'sent') statusFilter = { status: 'sent' };
        else if (filter === 'failed') statusFilter = { status: 'failed' };
        else if (filter === 'skipped') statusFilter = { status: 'skipped' };

        const [items, totalCount] = await Promise.all([
            SellerNotificationLog.find(statusFilter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('seller sellerName phone category message status reason error createdAt')
                .lean(),
            SellerNotificationLog.countDocuments(statusFilter),
        ]);

        res.json({ items, total: totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) });
    } catch (err) {
        console.error('whatsapp.getSellerQueue:', err.message);
        res.status(500).json({ msg: 'Failed to fetch seller notification log' });
    }
};

// GET /api/whatsapp/seller/stats — admin: seller notification analytics
exports.getSellerStats = async (req, res) => {
    try {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [byStatus, last24h, last7d, total, recentSeries] = await Promise.all([
            SellerNotificationLog.aggregate([
                { $group: { _id: '$status', count: { $sum: 1 } } },
            ]),
            SellerNotificationLog.countDocuments({ createdAt: { $gte: dayAgo } }),
            SellerNotificationLog.countDocuments({ createdAt: { $gte: weekAgo } }),
            SellerNotificationLog.countDocuments({}),
            SellerNotificationLog.aggregate([
                { $match: { createdAt: { $gte: weekAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
                        skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
        ]);

        const counts = byStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {});
        const sent = counts.sent || 0;
        const failed = counts.failed || 0;
        const skipped = counts.skipped || 0;
        const deliveryRate = (sent + failed) > 0 ? Math.round((sent / (sent + failed)) * 100) : 0;

        // By category breakdown
        const byCategory = await SellerNotificationLog.aggregate([
            { $match: { status: 'sent', createdAt: { $gte: weekAgo } } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        // Fill in missing days for timeline
        const seriesMap = {};
        recentSeries.forEach(d => { seriesMap[d._id] = d; });
        const timeline = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const key = d.toISOString().slice(0, 10);
            const entry = seriesMap[key];
            timeline.push({
                date: key,
                sent: entry?.sent || 0,
                failed: entry?.failed || 0,
                skipped: entry?.skipped || 0,
            });
        }

        res.json({
            total,
            last24h,
            last7d,
            sent,
            failed,
            skipped,
            deliveryRate,
            byCategory,
            timeline,
        });
    } catch (err) {
        console.error('whatsapp.getSellerStats:', err.message);
        res.status(500).json({ msg: 'Failed to fetch seller notification stats' });
    }
};
