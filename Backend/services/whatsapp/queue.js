// FIFO queue processor with immediate first send and retry/backoff.
// Persists state in MongoDB so Heroku dyno restarts don't drop pending jobs.

const crypto = require('crypto');
const os = require('os');
const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const evolution = require('./evolutionClient');
const { configKeyFor } = require('./gatewayMode');
const { toPhoneJid } = require('./addressing');
const {
    buildOrderButtonsPayload,
    buildOrderListPayload,
    buildOrderPlacedInfoMessage,
    normalizePhone,
} = require('./messageBuilder');
const Order = require('../../models/Order');
const { orderBuyerPhoneDigits } = require('../orderBuyerContactService');

const MAX_ATTEMPTS = 3;
const HOURLY_CAP = 60;
// Evolution calls time out after 25 seconds. Confirmation delivery can make a
// number check plus two interactive-send attempts, so keep the lease well above
// that bound to avoid two healthy workers sending the same message concurrently.
const QUEUE_LEASE_MS = 5 * 60 * 1000;
const queueWorkerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`.slice(0, 120);
const OPEN_CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const openConversationWindows = new Map();

let timer = null;
let isProcessing = false;

exports.markInboundConversationWindowOpen = (phone) => {
    if (!phone) return;
    openConversationWindows.set(String(phone), Date.now());
};

const hasOpenConversationWindow = (phone) => {
    const lastInboundAt = openConversationWindows.get(String(phone || ''));
    return !!lastInboundAt && Date.now() - lastInboundAt < OPEN_CONVERSATION_WINDOW_MS;
};

const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - OPEN_CONVERSATION_WINDOW_MS;
    for (const [phone, lastInboundAt] of openConversationWindows.entries()) {
        if (lastInboundAt < cutoff) openConversationWindows.delete(phone);
    }
}, 60 * 60 * 1000);
cleanupTimer.unref?.();

// Soft hourly cap tracking
const checkHourlyCap = async () => {
    const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
    if (!cfg) return true;
    const now = new Date();
    if (!cfg.sentWindowStartedAt || now - cfg.sentWindowStartedAt > 60 * 60 * 1000) {
        cfg.sentWindowStartedAt = now;
        cfg.sentInLastHour = 0;
        await cfg.save();
    }
    return cfg.sentInLastHour < HOURLY_CAP;
};

const incrementSentCounter = async () => {
    await WhatsAppConfig.updateOne(
        { singletonKey: configKeyFor('main') },
        { $inc: { sentInLastHour: 1 }, $set: { lastSeen: new Date() } }
    );
};

// Enqueue: caller passes an already-saved Order with confirmation.token set
const frozenInteractiveJson = (provided, fallback, field) => {
    const value = provided || JSON.stringify(fallback());
    if (typeof value !== 'string' || !value || value.length > 20000) {
        throw new Error(`${field} is invalid.`);
    }
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${field} is invalid.`);
    }
    return JSON.stringify(parsed);
};

const parseInteractivePayload = (value, fallback, field) => {
    if (!value) return fallback(); // compatibility for pre-outbox queued rows
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        return parsed;
    } catch (_error) {
        throw new Error(`${field} is corrupt.`);
    }
};

const findOrderConfirmationJob = order => {
    const orderObjectId = order?._id || order;
    if (!orderObjectId) return Promise.resolve(null);
    return WhatsAppPendingMessage.findOne({
        $or: [
            { dedupeKey: `order-confirmation:${orderObjectId}` },
            { order: orderObjectId, messageType: 'confirmation' },
        ],
    });
};

exports.findOrderConfirmationJob = findOrderConfirmationJob;

exports.enqueueOrderConfirmation = async (order, {
    buttonsPayloadJson = '',
    listPayloadJson = '',
} = {}) => {
    const dedupeKey = order?._id ? `order-confirmation:${order._id}` : '';
    try {
        if (!order?.confirmation?.token) return null;
        const phone = orderBuyerPhoneDigits(order);
        if (!phone || phone.length < 8) {
            console.warn('[whatsapp] skip enqueue — invalid phone', order.orderId);
            return null;
        }
        const frozenButtons = frozenInteractiveJson(
            buttonsPayloadJson,
            () => buildOrderButtonsPayload(order),
            'Interactive WhatsApp buttons snapshot',
        );
        const frozenList = frozenInteractiveJson(
            listPayloadJson,
            () => buildOrderListPayload(order),
            'Interactive WhatsApp list snapshot',
        );

        // Avoid duplicate enqueue for the same order
        const existing = await findOrderConfirmationJob(order);
        if (existing) {
            const hasButtonsSnapshot = Boolean(existing.interactiveButtonsPayloadJson);
            const hasListSnapshot = Boolean(existing.interactiveListPayloadJson);
            if (hasButtonsSnapshot !== hasListSnapshot) {
                throw new Error('The existing interactive WhatsApp snapshot is incomplete.');
            }
            // Safely backfill a not-yet-sent legacy queue row. Use the native
            // collection operation because the Mongoose fields are immutable
            // after creation; the conditional prevents overwriting a snapshot.
            if (
                existing.status === 'queued'
                && !hasButtonsSnapshot
                && !hasListSnapshot
            ) {
                await WhatsAppPendingMessage.collection.updateOne({
                    _id: existing._id,
                    status: 'queued',
                    $and: [
                        { $or: [
                            { interactiveButtonsPayloadJson: { $in: ['', null] } },
                            { interactiveButtonsPayloadJson: { $exists: false } },
                        ] },
                        { $or: [
                            { interactiveListPayloadJson: { $in: ['', null] } },
                            { interactiveListPayloadJson: { $exists: false } },
                        ] },
                    ],
                }, {
                    $set: {
                        interactiveButtonsPayloadJson: frozenButtons,
                        interactiveListPayloadJson: frozenList,
                    },
                });
                return WhatsAppPendingMessage.findById(existing._id);
            }
            return existing;
        }

        const pending = await WhatsAppPendingMessage.create({
            order: order._id,
            orderId: order.orderId,
            confirmationToken: order.confirmation.token,
            dedupeKey,
            messageType: 'confirmation',
            interactiveButtonsPayloadJson: frozenButtons,
            interactiveListPayloadJson: frozenList,
            phone,
            buyerName: order.shippingInfo?.fullName || '',
            status: 'queued',
            nextAttemptAt: new Date(),
        });
        setImmediate(() => tick().catch(err => console.error('[whatsapp] immediate queue tick failed:', err.message)));
        return pending;
    } catch (err) {
        if (err?.code === 11000 && dedupeKey) {
            return WhatsAppPendingMessage.findOne({ dedupeKey });
        }
        console.error('[whatsapp] enqueue failed:', err.message);
        return null;
    }
};

// Enqueue an info-only message (post-Stripe payment). No confirm/cancel poll.
exports.enqueueOrderPlacedInfo = async (order) => {
    try {
        const phone = orderBuyerPhoneDigits(order);
        if (!phone || phone.length < 8) {
            console.warn('[whatsapp] skip info enqueue — invalid phone', order.orderId);
            return null;
        }

        // Avoid duplicate info enqueue for the same order
        const existing = await WhatsAppPendingMessage.findOne({
            order: order._id,
            messageType: 'info',
        });
        if (existing) return existing;

        const pending = await WhatsAppPendingMessage.create({
            order: order._id,
            orderId: order.orderId,
            confirmationToken: order.confirmation?.token || 'n/a',
            messageType: 'info',
            phone,
            buyerName: order.shippingInfo?.fullName || '',
            status: 'queued',
            nextAttemptAt: new Date(),
        });
        setImmediate(() => tick().catch(err => console.error('[whatsapp] immediate info queue tick failed:', err.message)));
        return pending;
    } catch (err) {
        console.error('[whatsapp] info enqueue failed:', err.message);
        return null;
    }
};

exports.enqueueTextNotification = async ({ order, phone, message, dedupeKey }) => {
    try {
        if (!order?._id || !dedupeKey || !String(message || '').trim()) return null;
        const normalizedPhone = normalizePhone(phone);
        if (!normalizedPhone || normalizedPhone.length < 8) return null;

        const normalizedDedupeKey = String(dedupeKey).trim().slice(0, 200);
        const messageBody = String(message).trim().slice(0, 4000);
        if (!normalizedDedupeKey || !messageBody) return null;
        const matchesExpected = job => (
            job?.messageType === 'custom_info'
            && String(job.order || '') === String(order._id)
            && String(job.orderId || '') === String(order.orderId || '')
            && job.phone === normalizedPhone
            && job.messageBody === messageBody
        );
        const existing = await WhatsAppPendingMessage.findOne({ dedupeKey: normalizedDedupeKey });
        if (existing) return matchesExpected(existing) ? existing : null;

        const pending = await WhatsAppPendingMessage.create({
            order: order._id,
            orderId: order.orderId,
            confirmationToken: order.confirmation?.token || 'n/a',
            dedupeKey: normalizedDedupeKey,
            messageType: 'custom_info',
            messageBody,
            phone: normalizedPhone,
            buyerName: order.shippingInfo?.fullName || '',
            status: 'queued',
            nextAttemptAt: new Date(),
        });
        setImmediate(() => tick().catch(err => console.error('[whatsapp] immediate text queue tick failed:', err.message)));
        return pending;
    } catch (err) {
        if (err?.code === 11000) {
            const normalizedDedupeKey = String(dedupeKey || '').trim().slice(0, 200);
            const existing = await WhatsAppPendingMessage.findOne({ dedupeKey: normalizedDedupeKey });
            return existing?.messageType === 'custom_info'
                && String(existing.order || '') === String(order?._id || '')
                && String(existing.orderId || '') === String(order?.orderId || '')
                && existing.phone === normalizePhone(phone)
                && existing.messageBody === String(message || '').trim().slice(0, 4000)
                ? existing
                : null;
        }
        console.error('[whatsapp] text notification enqueue failed:', err.message);
        return null;
    }
};

exports.findTextNotificationJob = (dedupeKey) => {
    const normalizedDedupeKey = String(dedupeKey || '').trim().slice(0, 200);
    if (!normalizedDedupeKey) return Promise.resolve(null);
    return WhatsAppPendingMessage.findOne({
        dedupeKey: normalizedDedupeKey,
        messageType: 'custom_info',
    });
};

exports.enqueueGenericTextNotification = async ({ phone, message, dedupeKey, recipientLabel = '' }) => {
    try {
        if (!dedupeKey || !String(message || '').trim()) return null;
        const normalizedPhone = normalizePhone(phone);
        if (!normalizedPhone || normalizedPhone.length < 8) return null;
        const normalizedDedupeKey = String(dedupeKey).trim().slice(0, 200);
        const messageBody = String(message).trim().slice(0, 4000);
        if (!normalizedDedupeKey || !messageBody) return null;
        const matchesExpected = job => (
            job?.messageType === 'generic_info'
            && !job.order
            && !String(job.orderId || '')
            && job.phone === normalizedPhone
            && job.messageBody === messageBody
        );
        const existing = await WhatsAppPendingMessage.findOne({ dedupeKey: normalizedDedupeKey });
        if (existing) return matchesExpected(existing) ? existing : null;
        const pending = await WhatsAppPendingMessage.create({
            order: null,
            orderId: '',
            confirmationToken: 'n/a',
            dedupeKey: normalizedDedupeKey,
            messageType: 'generic_info',
            messageBody,
            phone: normalizedPhone,
            buyerName: String(recipientLabel || '').trim().slice(0, 120),
            status: 'queued',
            nextAttemptAt: new Date(),
        });
        setImmediate(() => tick().catch(err => console.error('[whatsapp] immediate generic queue tick failed:', err.message)));
        return pending;
    } catch (err) {
        if (err?.code === 11000) {
            const normalizedDedupeKey = String(dedupeKey || '').trim().slice(0, 200);
            const existing = await WhatsAppPendingMessage.findOne({ dedupeKey: normalizedDedupeKey });
            return existing?.messageType === 'generic_info'
                && !existing.order
                && !String(existing.orderId || '')
                && existing.phone === normalizePhone(phone)
                && existing.messageBody === String(message || '').trim().slice(0, 4000)
                ? existing
                : null;
        }
        console.error('[whatsapp] generic text notification enqueue failed:', err.message);
        return null;
    }
};

exports.findGenericTextNotificationJob = dedupeKey => {
    const normalizedDedupeKey = String(dedupeKey || '').trim().slice(0, 200);
    if (!normalizedDedupeKey) return Promise.resolve(null);
    return WhatsAppPendingMessage.findOne({
        dedupeKey: normalizedDedupeKey,
        messageType: 'generic_info',
    });
};

const expiredLeaseQuery = (now, leaseMs) => ({
    $or: [
        { leaseExpiresAt: { $lte: now } },
        // Compatibility for rows claimed by the pre-lease queue. Waiting one
        // full lease interval avoids racing an older process during a rolling
        // deployment while still recovering rows after a restart.
        {
            leaseExpiresAt: null,
            updatedAt: { $lte: new Date(now.getTime() - leaseMs) },
        },
    ],
});

const terminalizeExhaustedStaleLeases = async ({
    now = new Date(),
    leaseMs = QUEUE_LEASE_MS,
} = {}) => WhatsAppPendingMessage.updateMany({
    status: 'sending',
    attempts: { $gte: MAX_ATTEMPTS },
    ...expiredLeaseQuery(now, leaseMs),
}, {
    $set: {
        status: 'failed',
        leaseToken: null,
        leaseOwner: '',
        leaseExpiresAt: null,
        lastError: 'The WhatsApp delivery lease expired on the final attempt; provider acceptance is unknown.',
    },
});

const claimNextDueJob = async ({
    now = new Date(),
    leaseMs = QUEUE_LEASE_MS,
    workerId = queueWorkerId,
} = {}) => {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new TypeError('WhatsApp queue claim time is invalid.');
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60 * 1000) {
        throw new RangeError('WhatsApp queue lease must be between 1000 and 900000 milliseconds.');
    }
    const owner = String(workerId || '').trim().slice(0, 120);
    if (!owner) throw new TypeError('WhatsApp queue worker id is required.');

    await terminalizeExhaustedStaleLeases({ now, leaseMs });
    const leaseToken = crypto.randomUUID();
    return WhatsAppPendingMessage.findOneAndUpdate({
        // Legacy rows can predate the attempts field. Treat a missing/null
        // value as zero so a rolling deployment does not strand a due job.
        $expr: { $lt: [{ $ifNull: ['$attempts', 0] }, MAX_ATTEMPTS] },
        $or: [
            { status: 'queued', nextAttemptAt: { $lte: now } },
            { status: 'sending', ...expiredLeaseQuery(now, leaseMs) },
        ],
    }, {
        $set: {
            status: 'sending',
            leaseToken,
            leaseOwner: owner,
            leaseExpiresAt: new Date(now.getTime() + leaseMs),
        },
        // Count the attempt at claim time. A process crash must consume an
        // attempt too, otherwise a poison job can restart forever.
        $inc: { attempts: 1 },
    }, {
        new: true,
        sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 },
    });
};

const finishClaimedJob = (job, fields) => WhatsAppPendingMessage.findOneAndUpdate({
    _id: job._id,
    status: 'sending',
    leaseToken: job.leaseToken,
}, {
    $set: {
        ...fields,
        leaseToken: null,
        leaseOwner: '',
        leaseExpiresAt: null,
    },
}, { new: true });

const processOne = async () => {
    if (!evolution.isConfigured()) return;

    const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
    if (!cfg || cfg.status !== 'connected') return;

    const allowed = await checkHourlyCap();
    if (!allowed) return;

    // Atomically claim a due job or reclaim one whose prior worker died.
    const job = await claimNextDueJob();
    if (!job) return;

    try {
        // Order-owned messages re-read their authority. Generic current-user
        // messages have no Order dependency and are authorized by their parent
        // NotificationOutbox row before this durable child hand-off.
        const genericInfo = job.messageType === 'generic_info';
        const order = genericInfo ? null : await Order.findById(job.order).populate({
            path: 'orderItems.productId',
            select: 'name seller',
        });
        if (!genericInfo && !order) {
            await finishClaimedJob(job, {
                status: 'failed',
                lastError: 'Order not found',
            });
            return;
        }

        // Skip if order was already confirmed/declined via another channel.
        // Info-type messages (post-payment notifications) are an exception —
        // those are SENT precisely because the order was just auto-confirmed
        // by the Stripe webhook, so we never skip them on this guard.
        if (job.messageType === 'confirmation' &&
            (order.confirmation?.confirmedAt || order.confirmation?.declinedAt)) {
            await finishClaimedJob(job, { status: 'expired' });
            return;
        }

        // Verify the number is actually on WhatsApp BEFORE burning 3 send attempts on it.
        const existsOnWhatsApp = await evolution.checkWhatsAppNumber(job.phone);
        if (existsOnWhatsApp === false) {
            const lastError = `Phone ${job.phone} is not a WhatsApp account. Verify the number has country code (e.g. 923001234567 for Pakistan) and that WhatsApp is installed.`;
            const completed = await finishClaimedJob(job, {
                status: 'failed_invalid_number',
                lastError,
            });
            if (!completed) {
                console.warn(`[whatsapp] lease lost while validating the destination for ${order?.orderId || job.dedupeKey}`);
                return;
            }
            // Track WhatsApp failure on the Order
            if (!['custom_info', 'generic_info'].includes(job.messageType)) {
                order.confirmation.whatsappSentAt = new Date();
                order.confirmation.whatsappSentSuccess = false;
                order.confirmation.whatsappError = lastError;
                await order.save();
            }
            console.warn(`[whatsapp] skip ${order?.orderId || job.dedupeKey} — ${job.phone} is not on WhatsApp`);
            return;
        }

        // ── Tiered send strategy ──
        //
        // Priority 1 — TWO INLINE REPLY BUTTONS via sendButtons.
        //   On the Evolution homolog image, sendButtons produces an
        //   interactiveMessage (NOT the old viewOnceMessage wrapper), which
        //   WhatsApp now relays to regular Baileys-linked devices. The buyer
        //   sees "✅ Confirm order" and "❌ Cancel order" buttons directly
        //   below the message — no menu, no extra tap.
        //
        // Priority 2 — LIST message via sendList.
        //   If Meta tightens the rules later or the button send fails, a
        //   list menu (one tap-to-open button → 2-row SINGLE_SELECT menu)
        //   is the next-most-friendly form and still delivers reliably.
        //
        // If both interactive formats fail, mark the job failed. Buyer order
        // confirmation decisions must come from WhatsApp UI payloads only.
        //
        // Rich reply envelopes (button click / list reply) are
        // all handled by webhookHandler.extractDecision, keyed on the
        // confirm_ORD-xxx / cancel_ORD-xxx id scheme.

        const recipient = toPhoneJid(job.phone) || job.phone;
        let sendRes;
        let strategy;

        if (['custom_info', 'generic_info'].includes(job.messageType)) {
            strategy = job.messageType === 'generic_info' ? 'generic-info-text' : 'custom-info-text';
            sendRes = await evolution.sendText(recipient, job.messageBody);
        } else if (job.messageType === 'info') {
            // Online-paid orders: just an info text. Buyer already committed by
            // paying — no confirm/cancel buttons.
            strategy = 'info-text';
            sendRes = await evolution.sendText(recipient, buildOrderPlacedInfoMessage(order));
        } else {
            // COD: tiered confirm/cancel send (buttons → list). No text
            // fallback is allowed for buyer decisions.
            const buttonsPayload = parseInteractivePayload(
                job.interactiveButtonsPayloadJson,
                () => buildOrderButtonsPayload(order),
                'Interactive WhatsApp buttons snapshot',
            );
            strategy = 'buttons';
            try {
                sendRes = await evolution.sendButtons(recipient, buttonsPayload);
            } catch (btnErr) {
                console.warn(
                    `[whatsapp] sendButtons failed for order ${order.orderId}, trying list:`,
                    btnErr.response?.data || btnErr.message
                );
                strategy = 'list';
                try {
                    sendRes = await evolution.sendList(recipient, parseInteractivePayload(
                        job.interactiveListPayloadJson,
                        () => buildOrderListPayload(order),
                        'Interactive WhatsApp list snapshot',
                    ));
                } catch (listErr) {
                    console.warn(
                        `[whatsapp] sendList also failed for order ${order.orderId}; no text fallback will be sent:`,
                        listErr.response?.data || listErr.message
                    );
                    throw listErr;
                }
            }
        }
        const completed = await finishClaimedJob(job, {
            summaryMessageId: sendRes.messageId || '',
            pollMessageId: '', // not used — match by phone in the webhook
            status: 'sent',
            sentAt: new Date(),
            lastError: '',
        });
        if (!completed) {
            // Another worker reclaimed the lease. We cannot safely assert that
            // Evolution did or did not accept this send; the later worker owns
            // the durable result from here.
            console.warn(`[whatsapp] lease lost after provider attempt for ${order?.orderId || job.dedupeKey}`);
            return;
        }
        // Provider acceptance is already durable in the child row. A telemetry
        // counter failure must not put that delivered message back on the queue
        // and cause a duplicate send.
        await incrementSentCounter().catch(error => {
            console.error('[whatsapp] failed to record the sent counter:', error.message);
        });

        // Track WhatsApp send success on the Order
        if (!['custom_info', 'generic_info'].includes(job.messageType)) {
            order.confirmation.whatsappSentAt = new Date();
            order.confirmation.whatsappSentSuccess = true;
            await order.save();
        }

        console.log(`[whatsapp] sent ${order?.orderId || job.dedupeKey} → ${recipient} (${strategy}) id=${completed.summaryMessageId || 'unknown'}`);
    } catch (err) {
        // Attempts are counted atomically when the lease is claimed, including
        // attempts interrupted by a process crash.
        const attempts = job.attempts || 1;
        const status = err.response?.status;
        const errBody = err.response?.data;

        const notOnWhatsApp =
            status === 400 &&
            Array.isArray(errBody?.response?.message) &&
            errBody.response.message.some(m => m?.exists === false);

        const failedFinal = notOnWhatsApp || attempts >= MAX_ATTEMPTS;
        let lastError = errBody ? JSON.stringify(errBody).slice(0, 500) : String(err.message || err).slice(0, 500);

        let completed;
        if (notOnWhatsApp) {
            lastError = `Number ${job.phone} is not registered on WhatsApp. Check country code and try again.`;
            completed = await finishClaimedJob(job, {
                status: 'failed_invalid_number',
                lastError,
            });
        } else if (failedFinal) {
            completed = await finishClaimedJob(job, { status: 'failed', lastError });
        } else {
            const backoff = attempts === 1 ? 30 * 1000 : 2 * 60 * 1000;
            completed = await finishClaimedJob(job, {
                status: 'queued',
                lastError,
                nextAttemptAt: new Date(Date.now() + backoff),
            });
        }
        if (!completed) {
            console.warn(`[whatsapp] lease lost while recording a failed attempt for order ${job.orderId}`);
            return;
        }

        // Track WhatsApp send failure on the Order (only on final failure)
        if (failedFinal && !['custom_info', 'generic_info'].includes(job.messageType)) {
            try {
                const order = await Order.findById(job.order);
                if (order) {
                    order.confirmation.whatsappSentAt = new Date();
                    order.confirmation.whatsappSentSuccess = false;
                    order.confirmation.whatsappError = lastError || 'WhatsApp send failed';
                    await order.save();
                }
            } catch (trackErr) {
                console.error('[whatsapp] Failed to track WA send failure on order:', trackErr.message);
            }
        }

        console.error(`[whatsapp] send failed (attempt ${attempts}, status=${status}):`, lastError);
    }
};

const tick = async () => {
    if (isProcessing) return;
    isProcessing = true;
    try {
        await processOne();
    } catch (err) {
        console.error('[whatsapp] queue tick error:', err.message);
    } finally {
        isProcessing = false;
    }
};

exports.startQueueProcessor = () => {
    if (timer) return;
    timer = setInterval(tick, 1000);
    timer.unref?.();
    console.log('[whatsapp] queue processor started');
};

exports.stopQueueProcessor = () => {
    if (timer) clearInterval(timer);
    timer = null;
};

// Focused exports keep lease recovery directly testable without invoking an
// external WhatsApp provider.
exports._claimNextDueJob = claimNextDueJob;
exports._finishClaimedJob = finishClaimedJob;
exports._terminalizeExhaustedStaleLeases = terminalizeExhaustedStaleLeases;

// ──────────────────────────────────────────────────────────────────────────
// Reply matching — called by webhook handler.
//
// Split into two operations so the handler can CHECK the order-level guard
// BEFORE persisting the vote. This prevents the admin dashboard from
// showing "declined" when the buyer tapped cancel *after* already confirming.
//
// Step 1: findPendingJobByPhone — returns the most recent matching job
//         without modifying it.
// Step 2: applyVote — actually writes the status after the handler decides
//         the vote is allowed.
// ──────────────────────────────────────────────────────────────────────────

// Returns the newest pending/voted job for this phone, or null.
exports.findPendingJobByPhone = async (phone) => {
    return WhatsAppPendingMessage.findOne({
        phone,
        messageType: 'confirmation',
        status: { $in: ['sent', 'sending', 'voted_yes', 'voted_no'] },
    }).sort({ createdAt: -1 });
};

// Returns the pending/voted job for a specific orderId (button click matching).
exports.findPendingJobByOrderId = async (orderId) => {
    return WhatsAppPendingMessage.findOne({
        orderId,
        messageType: 'confirmation',
        status: { $in: ['sent', 'sending', 'voted_yes', 'voted_no'] },
    });
};

// Persist the buyer's decision on the job document.
// Only call this AFTER confirming the order guard allows the vote.
exports.applyVote = async (job, vote) => {
    const status = vote === 'yes' ? 'voted_yes' : 'voted_no';
    if (job.status !== status) {
        job.status = status;
        job.repliedAt = new Date();
        await job.save();
    }
    return job;
};

// Legacy compat — still used by the old markVotedByPhone callers.
// Now delegates to the two-step approach but keeps the same signature.
exports.markVotedByPhone = async (phone, vote) => {
    const job = await exports.findPendingJobByPhone(phone);
    if (!job) return null;
    return exports.applyVote(job, vote);
};

// Legacy — still used by older code paths until fully removed
exports.markVoted = async (pollMessageId, vote) => {
    const status = vote === 'yes' ? 'voted_yes' : 'voted_no';
    const job = await WhatsAppPendingMessage.findOneAndUpdate(
        { pollMessageId, status: { $in: ['sent', 'sending'] } },
        { $set: { status, repliedAt: new Date() } },
        { new: true }
    );
    return job;
};
