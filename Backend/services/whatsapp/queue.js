// FIFO queue processor with immediate first send and retry/backoff.
// Persists state in MongoDB so Heroku dyno restarts don't drop pending jobs.

const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const evolution = require('./evolutionClient');
const { resolveOutboundRecipient } = require('./jidRoutingStore');
const { configKeyFor, routingScopeFor } = require('./gatewayMode');
const {
    buildOrderButtonsPayload,
    buildOrderListPayload,
    buildOrderConfirmationMessage,
    buildOrderPlacedInfoMessage,
    normalizePhone,
} = require('./messageBuilder');
const Order = require('../../models/Order');

const MAX_ATTEMPTS = 3;
const HOURLY_CAP = 60;
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
exports.enqueueOrderConfirmation = async (order) => {
    try {
        if (!order?.confirmation?.token) return null;
        const phone = normalizePhone(order.shippingInfo?.phone);
        if (!phone || phone.length < 8) {
            console.warn('[whatsapp] skip enqueue — invalid phone', order.orderId);
            return null;
        }

        // Avoid duplicate enqueue for the same order
        const existing = await WhatsAppPendingMessage.findOne({ order: order._id });
        if (existing) return existing;

        const pending = await WhatsAppPendingMessage.create({
            order: order._id,
            orderId: order.orderId,
            confirmationToken: order.confirmation.token,
            phone,
            buyerName: order.shippingInfo?.fullName || '',
            status: 'queued',
            nextAttemptAt: new Date(),
        });
        setImmediate(() => tick().catch(err => console.error('[whatsapp] immediate queue tick failed:', err.message)));
        return pending;
    } catch (err) {
        console.error('[whatsapp] enqueue failed:', err.message);
        return null;
    }
};

// Enqueue an info-only message (post-Stripe payment). No confirm/cancel poll.
exports.enqueueOrderPlacedInfo = async (order) => {
    try {
        const phone = normalizePhone(order.shippingInfo?.phone);
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

const processOne = async () => {
    if (!evolution.isConfigured()) return;

    const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') });
    if (!cfg || cfg.status !== 'connected') return;

    const allowed = await checkHourlyCap();
    if (!allowed) return;

    // Atomically claim the next due job
    const now = new Date();
    const job = await WhatsAppPendingMessage.findOneAndUpdate(
        {
            status: 'queued',
            nextAttemptAt: { $lte: now },
        },
        { $set: { status: 'sending' } },
        { new: true, sort: { nextAttemptAt: 1 } }
    );
    if (!job) return;

    try {
        // Re-read order for fresh data
        const order = await Order.findById(job.order).populate({
            path: 'orderItems.productId',
            select: 'name seller',
        });
        if (!order) {
            job.status = 'failed';
            job.lastError = 'Order not found';
            await job.save();
            return;
        }

        // Skip if order was already confirmed/declined via another channel.
        // Info-type messages (post-payment notifications) are an exception —
        // those are SENT precisely because the order was just auto-confirmed
        // by the Stripe webhook, so we never skip them on this guard.
        if (job.messageType !== 'info' &&
            (order.confirmation?.confirmedAt || order.confirmation?.declinedAt)) {
            job.status = 'expired';
            await job.save();
            return;
        }

        // Verify the number is actually on WhatsApp BEFORE burning 3 send attempts on it.
        const existsOnWhatsApp = await evolution.checkWhatsAppNumber(job.phone);
        if (existsOnWhatsApp === false) {
            job.status = 'failed_invalid_number';
            job.lastError = `Phone ${job.phone} is not a WhatsApp account. Verify the number has country code (e.g. 923001234567 for Pakistan) and that WhatsApp is installed.`;
            job.attempts = (job.attempts || 0) + 1;
            await job.save();
            // Track WhatsApp failure on the Order
            order.confirmation.whatsappSentAt = new Date();
            order.confirmation.whatsappSentSuccess = false;
            order.confirmation.whatsappError = job.lastError;
            await order.save();
            console.warn(`[whatsapp] skip order ${order.orderId} — ${job.phone} is not on WhatsApp`);
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
        // Priority 3 — PLAIN TEXT YES/NO.
        //   Last-resort so the buyer is never stuck.
        //
        // Rich reply envelopes (button click / list reply / plain text) are
        // all handled by webhookHandler.extractDecision, keyed on the
        // confirm_ORD-xxx / cancel_ORD-xxx id scheme.

        const recipient = await resolveOutboundRecipient(job.phone, job.phone, { instanceType: routingScopeFor('main') });
        let sendRes;
        let strategy;

        if (job.messageType === 'info') {
            // Online-paid orders: just an info text. Buyer already committed by
            // paying — no confirm/cancel buttons.
            strategy = 'info-text';
            sendRes = await evolution.sendText(recipient, buildOrderPlacedInfoMessage(order));
        } else {
            // COD: tiered confirm/cancel send (buttons → list → text fallback).
            const buttonsPayload = buildOrderButtonsPayload(order);
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
                    sendRes = await evolution.sendList(recipient, buildOrderListPayload(order));
                } catch (listErr) {
                    console.warn(
                        `[whatsapp] sendList also failed for order ${order.orderId}, falling back to text:`,
                        listErr.response?.data || listErr.message
                    );
                    strategy = 'text';
                    sendRes = await evolution.sendText(recipient, buildOrderConfirmationMessage(order));
                }
            }
        }
        await incrementSentCounter();

        job.summaryMessageId = sendRes.messageId || '';
        job.pollMessageId = ''; // not used — match by phone in the webhook
        job.status = 'sent';
        job.sentAt = new Date();
        job.attempts = (job.attempts || 0) + 1;
        await job.save();

        // Track WhatsApp send success on the Order
        order.confirmation.whatsappSentAt = new Date();
        order.confirmation.whatsappSentSuccess = true;
        await order.save();

        console.log(`[whatsapp] sent order ${order.orderId} → ${job.phone} (${strategy})`);
    } catch (err) {
        const attempts = (job.attempts || 0) + 1;
        const status = err.response?.status;
        const errBody = err.response?.data;

        const notOnWhatsApp =
            status === 400 &&
            Array.isArray(errBody?.response?.message) &&
            errBody.response.message.some(m => m?.exists === false);

        const failedFinal = notOnWhatsApp || attempts >= MAX_ATTEMPTS;
        job.attempts = attempts;
        job.lastError = errBody ? JSON.stringify(errBody).slice(0, 500) : err.message;

        if (notOnWhatsApp) {
            job.status = 'failed_invalid_number';
            job.lastError = `Number ${job.phone} is not registered on WhatsApp. Check country code and try again.`;
        } else if (failedFinal) {
            job.status = 'failed';
        } else {
            job.status = 'queued';
            const backoff = attempts === 1 ? 30 * 1000 : 2 * 60 * 1000;
            job.nextAttemptAt = new Date(Date.now() + backoff);
        }
        await job.save();

        // Track WhatsApp send failure on the Order (only on final failure)
        if (failedFinal) {
            try {
                const order = await Order.findById(job.order);
                if (order) {
                    order.confirmation.whatsappSentAt = new Date();
                    order.confirmation.whatsappSentSuccess = false;
                    order.confirmation.whatsappError = job.lastError || 'WhatsApp send failed';
                    await order.save();
                }
            } catch (trackErr) {
                console.error('[whatsapp] Failed to track WA send failure on order:', trackErr.message);
            }
        }

        console.error(`[whatsapp] send failed (attempt ${attempts}, status=${status}):`, job.lastError);
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

// ──────────────────────────────────────────────────────────────────────────
// Reply matching — called by webhook handler.
//
// Split into two operations so the handler can CHECK the order-level guard
// BEFORE persisting the vote. This prevents the admin dashboard from
// showing "declined" when the buyer tapped NO *after* already confirming.
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
        messageType: { $ne: 'info' }, // info messages have no Yes/No vote
        status: { $in: ['sent', 'sending', 'voted_yes', 'voted_no'] },
    }).sort({ createdAt: -1 });
};

// Returns the pending/voted job for a specific orderId (button click matching).
exports.findPendingJobByOrderId = async (orderId) => {
    return WhatsAppPendingMessage.findOne({
        orderId,
        messageType: { $ne: 'info' },
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
