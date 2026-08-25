const crypto = require('crypto');
const Notification = require('../models/Notification');
const BroadcastJob = require('../models/BroadcastJob');
const User = require('../models/User');
const { sendExpoPushStrict } = require('../utils/expoPush');
const { sendEmail } = require('./mailController');
const { broadcastEmail } = require('../utils/emailTemplates');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const buyerEvolution = require('../services/whatsapp/evolutionClient');
const sellerEvolution = require('../services/whatsapp/sellerEvolutionClient');
const { configKeyFor } = require('../services/whatsapp/gatewayMode');
const { normalizePhoneDigits } = require('../utils/phoneNumber');
const {
    buildScopedNotificationQuery,
    normalizeNotificationSurface,
    notificationSurfaceAllowedForRole,
} = require('../services/notificationAudienceService');
const {
    BROADCAST_DELIVERY_LEASE_MS,
    broadcastForResponse,
    cancelScheduledBroadcast,
    createBroadcastJob,
} = require('../services/broadcastJobService');

// ─────────────────────────── helpers ───────────────────────────

const buildAudienceQuery = (audience, userIds) => {
    if (audience === 'specific') {
        return {
            _id: { $in: Array.isArray(userIds) ? userIds : [] },
            status: 'active',
        };
    }
    if (audience === 'all_users') return { role: 'user', status: 'active' };
    if (audience === 'all_sellers') return { role: 'seller', status: 'active' };
    if (audience === 'both') return { role: { $in: ['user', 'seller'] }, status: 'active' };
    // Invalid/missing audiences must never degrade into a query for every
    // account. Validation normally rejects this before dispatch, while this
    // fail-closed branch also protects scheduled/legacy jobs.
    return { _id: { $in: [] }, status: 'active' };
};

const recipientMatchesAudience = (job, recipient) => {
    if (!recipient || recipient.status !== 'active') return false;
    if (job.audience === 'all_users') return recipient.role === 'user';
    if (job.audience === 'all_sellers') return recipient.role === 'seller';
    if (job.audience === 'both') return recipient.role === 'user' || recipient.role === 'seller';
    if (job.audience !== 'specific' || !Array.isArray(job.userIds)) return false;

    const recipientId = String(recipient._id || '');
    return recipientId !== '' && job.userIds.some((id) => String(id) === recipientId);
};

const verifiedWhatsAppDestination = (recipient) => {
    let number = '';
    let client;
    let configKey;

    if (recipient.role === 'user' && recipient.whatsappInfo?.verified === true) {
        number = recipient.whatsappInfo.number;
        client = buyerEvolution;
        configKey = configKeyFor('main');
    } else if (
        recipient.role === 'seller'
        && recipient.sellerInfo?.whatsappVerified === true
        && recipient.whatsappNotificationPrefs?.enabled !== false
    ) {
        number = recipient.sellerInfo.whatsappNumber;
        client = sellerEvolution;
        configKey = configKeyFor('seller');
    }

    const digits = normalizePhoneDigits(number);
    // E.164 permits at most 15 digits. Existing verification endpoints require
    // at least 10, so fail closed if persisted data cannot be a verified number.
    if (!client || digits.length < 10 || digits.length > 15) return null;
    return { client, configKey, digits };
};

const leaseLostError = () => {
    const error = new Error('Broadcast delivery authority was lost to another worker.');
    error.code = 'BROADCAST_LEASE_LOST';
    return error;
};

const matchedCount = (result) => Number(
    result?.matchedCount ?? result?.n ?? result?.modifiedCount ?? 0
);

const isDuplicateOnlyInsertError = (error) => {
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    if (writeErrors.some((entry) => Number(entry?.code ?? entry?.err?.code) !== 11000)) return false;
    if (writeErrors.length > 0) return true;
    return Number(error?.code) === 11000;
};

const activeLeaseFilter = (jobId, leaseToken, now = new Date()) => ({
    _id: jobId,
    status: 'sending',
    leaseToken,
    leaseExpiresAt: { $gt: now },
});

const renewBroadcastLease = async (jobId, leaseToken) => {
    if (!leaseToken) return;
    const now = new Date();
    const result = await BroadcastJob.updateOne(
        activeLeaseFilter(jobId, leaseToken, now),
        { $set: { leaseExpiresAt: new Date(now.getTime() + BROADCAST_DELIVERY_LEASE_MS) } }
    );
    if (matchedCount(result) !== 1) throw leaseLostError();
};

const reapExpiredBroadcastLeases = async (now = new Date()) => {
    const legacyCutoff = new Date(now.getTime() - BROADCAST_DELIVERY_LEASE_MS);
    return BroadcastJob.updateMany(
        {
            status: 'sending',
            $or: [
                { leaseExpiresAt: { $lte: now } },
                // Compatibility for jobs left in `sending` before leases were
                // introduced. Fresh legacy jobs receive one full lease window.
                { leaseExpiresAt: null, updatedAt: { $lte: legacyCutoff } },
            ],
        },
        {
            $set: {
                status: 'scheduled',
                leaseToken: '',
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
                lastError: 'Recovered after the previous broadcast delivery lease expired.',
            },
            $inc: { leaseRecoveryCount: 1 },
        }
    );
};

const normalizedRecurrenceAnchorDay = (anchorDay, fallbackDate) => {
    const parsed = Number(anchorDay);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 31) return parsed;
    return new Date(fallbackDate).getUTCDate();
};

const computeNextRunAt = (current, recurrence, recurrenceAnchorDay = null) => {
    const d = new Date(current);
    if (Number.isNaN(d.getTime())) return null;
    if (recurrence === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else if (recurrence === 'monthly') {
        const anchorDay = normalizedRecurrenceAnchorDay(recurrenceAnchorDay, d);
        // Move on day one first so January 29/30/31 cannot overflow through
        // February into March. Then clamp to the target month's final UTC day.
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + 1);
        const lastDayOfTargetMonth = new Date(Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth() + 1,
            0
        )).getUTCDate();
        d.setUTCDate(Math.min(anchorDay, lastDayOfTargetMonth));
    }
    else return null;
    return d;
};

const computeNextFutureRunAt = (
    current,
    recurrence,
    recurrenceAnchorDay = null,
    after = new Date()
) => {
    const cutoff = new Date(after);
    let next = computeNextRunAt(current, recurrence, recurrenceAnchorDay);
    if (!next || Number.isNaN(cutoff.getTime()) || next > cutoff) return next;

    if (recurrence === 'daily' || recurrence === 'weekly') {
        const intervalMs = recurrence === 'daily'
            ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
        const intervalsToSkip = Math.floor((cutoff.getTime() - next.getTime()) / intervalMs) + 1;
        return new Date(next.getTime() + intervalsToSkip * intervalMs);
    }

    if (recurrence === 'monthly') {
        const monthsToSkip = Math.max(0,
            (cutoff.getUTCFullYear() - next.getUTCFullYear()) * 12
            + cutoff.getUTCMonth()
            - next.getUTCMonth()
        );
        if (monthsToSkip > 0) {
            next.setUTCDate(1);
            next.setUTCMonth(next.getUTCMonth() + monthsToSkip);
            const anchorDay = normalizedRecurrenceAnchorDay(recurrenceAnchorDay, current);
            const lastDay = new Date(Date.UTC(
                next.getUTCFullYear(),
                next.getUTCMonth() + 1,
                0
            )).getUTCDate();
            next.setUTCDate(Math.min(anchorDay, lastDay));
        }
        if (next <= cutoff) next = computeNextRunAt(next, 'monthly', recurrenceAnchorDay);
    }

    return next;
};

const finalizeSuccessfulBroadcastRun = async (job, leaseToken, stats) => {
    const completedAt = new Date();
    let status = 'sent';
    let nextRunAt = null;
    let recurrenceAnchorDay = job.recurrenceAnchorDay || null;

    if (job.scheduleType === 'recurring' && job.recurrence !== 'none') {
        const occurrence = job.nextRunAt || completedAt;
        if (job.recurrence === 'monthly') {
            recurrenceAnchorDay = normalizedRecurrenceAnchorDay(recurrenceAnchorDay, occurrence);
        }
        // If the service was unavailable for several intervals, send this run
        // once and advance to the first future occurrence. Replaying every
        // missed daily/monthly slot in one scheduler tick would spam users.
        const next = computeNextFutureRunAt(
            occurrence,
            job.recurrence,
            recurrenceAnchorDay,
            completedAt
        );
        if (next && (!job.endsAt || next <= job.endsAt)) {
            status = 'scheduled';
            nextRunAt = next;
        }
    }

    const result = await BroadcastJob.updateOne(
        activeLeaseFilter(job._id, leaseToken, completedAt),
        {
            $set: {
                status,
                nextRunAt,
                lastRunAt: completedAt,
                lastError: '',
                recurrenceAnchorDay,
                leaseToken: '',
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
            },
            $inc: {
                runCount: 1,
                'stats.recipients': stats.recipients,
                'stats.pushSent': stats.pushSent,
                'stats.emailSent': stats.emailSent,
                'stats.whatsappSent': stats.whatsappSent,
            },
        }
    );
    if (matchedCount(result) !== 1) throw leaseLostError();

    job.status = status;
    job.nextRunAt = nextRunAt;
    job.lastRunAt = completedAt;
    job.lastError = '';
    job.recurrenceAnchorDay = recurrenceAnchorDay;
    job.leaseToken = '';
    job.leaseAcquiredAt = null;
    job.leaseExpiresAt = null;
    job.runCount = (job.runCount || 0) + 1;
    job.stats = {
        recipients: (job.stats?.recipients || 0) + stats.recipients,
        pushSent: (job.stats?.pushSent || 0) + stats.pushSent,
        emailSent: (job.stats?.emailSent || 0) + stats.emailSent,
        whatsappSent: (job.stats?.whatsappSent || 0) + stats.whatsappSent,
    };
    return job;
};

const failBroadcastRun = async (job, leaseToken, error) => {
    const now = new Date();
    const result = await BroadcastJob.updateOne(
        activeLeaseFilter(job._id, leaseToken, now),
        {
            $set: {
                status: 'failed',
                lastError: String(error?.message || error).slice(0, 500),
                leaseToken: '',
                leaseAcquiredAt: null,
                leaseExpiresAt: null,
            },
        }
    );
    if (matchedCount(result) !== 1) return false;
    job.status = 'failed';
    job.lastError = String(error?.message || error).slice(0, 500);
    job.leaseToken = '';
    job.leaseAcquiredAt = null;
    job.leaseExpiresAt = null;
    return true;
};

/**
 * Execute one run of a BroadcastJob: resolve recipients, then fan out to
 * the selected channels (inapp, push, email, whatsapp). Returns delivery stats.
 */
const dispatchBroadcast = async (job, { leaseToken = '' } = {}) => {
    const renewLease = () => renewBroadcastLease(job._id, leaseToken);
    await renewLease();
    const channels = job.channels || ['inapp', 'push'];
    const audienceQuery = buildAudienceQuery(job.audience, job.userIds);
    const resolvedRecipients = await User.find(audienceQuery)
        .select('_id role status expoPushTokens email sellerInfo.whatsappNumber sellerInfo.whatsappVerified whatsappInfo.number whatsappInfo.verified whatsappNotificationPrefs.enabled')
        .lean();
    // The database query is the primary boundary. Re-check its result so a
    // stale/malformed scheduled job or future query refactor cannot fan out to
    // a blocked account, changed role, or unselected specific account.
    const recipients = resolvedRecipients.filter((recipient) => recipientMatchesAudience(job, recipient));

    if (!recipients.length) return { recipients: 0, pushSent: 0, emailSent: 0, whatsappSent: 0 };

    let pushSent = 0;
    let emailSent = 0;
    let whatsappSent = 0;

    // ── Channel: In-App Notifications ──
    if (channels.includes('inapp')) {
        await renewLease();
        const broadcastRun = Number.isSafeInteger(Number(job.runCount)) ? Number(job.runCount) : 0;
        const docs = recipients.map((u) => ({
            user: u._id,
            title: job.title,
            body: job.body,
            category: job.category,
            linkTo: job.linkTo,
            source: 'admin_broadcast',
            targetRole: u.role,
            audience: job.audience,
            broadcastJob: job._id,
            sentBy: job.createdBy,
            dedupeKey: `admin-broadcast:${job._id}:run:${broadcastRun}:user:${u._id}`,
        }));
        try {
            await Notification.insertMany(docs, { ordered: false });
        } catch (err) {
            // A recovered run intentionally reuses the same per-run keys. The
            // unique index makes already-created inbox rows harmless, while a
            // database/validation failure must fail the run instead of being
            // incorrectly reported as delivered.
            if (!isDuplicateOnlyInsertError(err)) throw err;
        }
    }

    // ── Channel: Push Notifications (Expo) ──
    if (channels.includes('push')) {
        // Keep each authority scope and payload bound to one account. Bounded
        // concurrency avoids serial latency without reintroducing role-wide
        // token groups that can cross account boundaries during ownership lag.
        const pushRecipients = recipients.filter(recipient => recipient.expoPushTokens?.length);
        const PUSH_CONCURRENCY = 10;
        for (let i = 0; i < pushRecipients.length; i += PUSH_CONCURRENCY) {
            await renewLease();
            const batch = pushRecipients.slice(i, i + PUSH_CONCURRENCY);
            const deliveries = await Promise.all(batch.map(async (recipient) => {
                const recipientUserId = String(recipient._id);
                const targetRole = recipient.role || 'user';
                try {
                    return await sendExpoPushStrict(recipient.expoPushTokens, {
                        title: job.title,
                        body: job.body,
                        data: {
                            type: 'admin_broadcast',
                            jobId: String(job._id),
                            category: job.category,
                            linkTo: job.linkTo || undefined,
                            recipientUserId,
                            targetRole,
                            audience: job.audience,
                        },
                        channelId: 'general',
                    }, {
                        recipientUserId,
                    });
                } catch (err) {
                    console.warn('[broadcast] push failed for user', recipientUserId, err.message);
                    return { sentCount: 0 };
                }
            }));
            pushSent += deliveries.reduce((sum, delivery) => sum + (delivery?.sentCount || 0), 0);
        }
    }

    // ── Channel: Email (batched, max 10 concurrent) ──
    if (channels.includes('email')) {
        const emailData = broadcastEmail(job.title, job.body, job.category, job.linkTo);
        const emailRecipients = recipients.filter((u) => u.email);
        const BATCH_SIZE = 10;
        for (let i = 0; i < emailRecipients.length; i += BATCH_SIZE) {
            await renewLease();
            const batch = emailRecipients.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
                batch.map((u) =>
                    sendEmail({ to: u.email, subject: emailData.subject, html: emailData.html })
                        .then((delivery) => (
                            delivery?.success === true
                            && typeof delivery.messageId === 'string'
                            && delivery.messageId.trim() !== ''
                                ? 1
                                : 0
                        ))
                        .catch((err) => {
                            console.warn('[broadcast] email failed for', u.email, err.message);
                            return 0;
                        })
                )
            );
            emailSent += results.reduce((sum, v) => sum + v, 0);
        }
    }

    // ── Channel: WhatsApp ──
    if (channels.includes('whatsapp')) {
        try {
            const waRecipients = recipients
                .map((recipient) => ({ recipient, destination: verifiedWhatsAppDestination(recipient) }))
                .filter(({ destination }) => destination);
            const configKeys = [...new Set(waRecipients.map(({ destination }) => destination.configKey))];
            const configEntries = await Promise.all(configKeys.map(async (singletonKey) => [
                singletonKey,
                await WhatsAppConfig.findOne({ singletonKey }),
            ]));
            const connectedConfigKeys = new Set(
                configEntries.filter(([, config]) => config?.status === 'connected').map(([key]) => key)
            );
            const waMessage = `*${job.title}*\n\n${job.body}${job.linkTo ? `\n\n🔗 ${process.env.FRONTEND_URL || 'https://rozare.com'}${job.linkTo}` : ''}`;
            const WA_CONCURRENCY = 5;

            // Await the provider attempts so the job stores successful sends,
            // not an optimistic recipient count that can later be double-added.
            for (let i = 0; i < waRecipients.length; i += WA_CONCURRENCY) {
                await renewLease();
                const batch = waRecipients.slice(i, i + WA_CONCURRENCY);
                const results = await Promise.all(batch.map(async ({ recipient, destination }) => {
                    if (!connectedConfigKeys.has(destination.configKey)) return 0;
                    try {
                        const delivery = await destination.client.sendText(destination.digits, waMessage);
                        return typeof delivery?.messageId === 'string' && delivery.messageId.trim() !== ''
                            ? 1
                            : 0;
                    } catch (err) {
                        console.warn('[broadcast] whatsapp failed for user', String(recipient._id), err.message);
                        return 0;
                    }
                }));
                whatsappSent += results.reduce((sum, sent) => sum + sent, 0);
            }
        } catch (err) {
            console.warn('[broadcast] WhatsApp channel error:', err.message);
        }
    }

    await renewLease();
    return { recipients: recipients.length, pushSent, emailSent, whatsappSent };
};

// ─────────────────────────── admin endpoints ───────────────────────────

// POST /api/notifications/broadcast — admin
exports.createBroadcast = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin only' });
        }

        const now = new Date();
        const { job, leaseToken } = await createBroadcastJob({
            input: req.body || {},
            createdBy: req.user.id,
            claimImmediate: true,
            now,
        });

        // Fire immediate jobs synchronously so the admin gets instant feedback.
        if (job.scheduleType === 'immediate') {
            try {
                const stats = await dispatchBroadcast(job, { leaseToken });
                await finalizeSuccessfulBroadcastRun(job, leaseToken, stats);
            } catch (err) {
                await failBroadcastRun(job, leaseToken, err).catch(() => false);
                console.error('[broadcast] immediate dispatch failed:', err.message);
                return res.status(500).json({ msg: 'Broadcast dispatch failed. Please try again or check server logs.', jobId: job._id, status: job.status });
            }
        }

        res.status(201).json({ job: broadcastForResponse(job) });
    } catch (err) {
        if (err?.code === 'BROADCAST_INPUT_INVALID') {
            return res.status(400).json({ msg: err.message });
        }
        console.error('createBroadcast:', err);
        res.status(500).json({ msg: 'Failed to create broadcast' });
    }
};

// GET /api/notifications/broadcasts — admin: list all jobs
exports.listBroadcasts = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Admin only' });
        const jobs = await BroadcastJob.find()
            .select('-leaseToken')
            .sort({ createdAt: -1 })
            .limit(100)
            .populate('createdBy', 'username email')
            .lean();
        res.json({ jobs });
    } catch (err) {
        console.error('listBroadcasts:', err);
        res.status(500).json({ msg: 'Failed to fetch broadcasts' });
    }
};

// POST /api/notifications/broadcasts/:id/cancel — admin
exports.cancelBroadcast = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Admin only' });
        const result = await cancelScheduledBroadcast(req.params.id);
        if (result.outcome === 'cancelled') {
            return res.json({ job: broadcastForResponse(result.job) });
        }
        if (result.outcome === 'not_found') {
            return res.status(404).json({ msg: 'Broadcast not found' });
        }
        if (result.outcome === 'sending') {
            return res.status(409).json({ msg: 'Broadcast delivery has already started and can no longer be cancelled' });
        }
        return res.status(400).json({ msg: 'Broadcast already finalized' });
    } catch (err) {
        console.error('cancelBroadcast:', err);
        res.status(500).json({ msg: 'Failed to cancel broadcast' });
    }
};

// GET /api/notifications/audience-preview?audience=...&userIds=...
exports.audiencePreview = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Admin only' });
        const { audience = 'all_users' } = req.query;
        const userIds = Array.isArray(req.query.userIds)
            ? req.query.userIds
            : req.query.userIds
                ? String(req.query.userIds).split(',').filter(Boolean)
                : [];
        const q = buildAudienceQuery(audience, userIds);
        const count = await User.countDocuments(q);
        res.json({ count });
    } catch (err) {
        console.error('audiencePreview:', err);
        res.status(500).json({ msg: 'Failed to preview audience' });
    }
};

// GET /api/notifications/users-search?q=jane&role=user|seller
exports.searchUsers = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Admin only' });
        const { q = '', role } = req.query;
        const filter = { status: 'active' };
        if (role && ['user', 'seller'].includes(role)) filter.role = role;
        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [{ username: rx }, { email: rx }];
        }
        const users = await User.find(filter)
            .select('username email role avatar')
            .limit(20)
            .lean();
        res.json({ users });
    } catch (err) {
        console.error('searchUsers:', err);
        res.status(500).json({ msg: 'Failed to search users' });
    }
};

// ─────────────────────────── user endpoints ───────────────────────────

const requestedNotificationSurface = (req) => {
    const rawSurface = req.query?.surface;
    if (rawSurface === undefined) return { surface: null };
    const surface = normalizeNotificationSurface(rawSurface);
    if (!surface || !notificationSurfaceAllowedForRole(surface, req.user?.role)) {
        return {
            error: {
                msg: 'Notification surface is not available for this account role.',
                code: 'NOTIFICATION_SURFACE_INVALID',
            },
        };
    }
    return { surface };
};

// GET /api/notifications/me — list my notifications
exports.listMine = async (req, res) => {
    try {
        const requestedSurface = requestedNotificationSurface(req);
        if (requestedSurface.error) return res.status(400).json(requestedSurface.error);
        const { surface } = requestedSurface;
        const scopedQuery = buildScopedNotificationQuery({
            userId: req.user.id,
            role: req.user.role,
            ...(surface ? { surface } : {}),
        });
        const items = await Notification.find(scopedQuery)
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        const unread = await Notification.countDocuments(buildScopedNotificationQuery({
            userId: req.user.id,
            role: req.user.role,
            read: false,
            ...(surface ? { surface } : {}),
        }));
        res.json({
            account: {
                userId: String(req.user.id),
                role: req.user.role,
                ...(surface ? { surface } : {}),
            },
            items,
            unread,
        });
    } catch (err) {
        console.error('listMine:', err);
        res.status(500).json({ msg: 'Failed to fetch notifications' });
    }
};

// PATCH /api/notifications/:id/read
exports.markRead = async (req, res) => {
    try {
        const requestedSurface = requestedNotificationSurface(req);
        if (requestedSurface.error) return res.status(400).json(requestedSurface.error);
        const { surface } = requestedSurface;
        const n = await Notification.findOneAndUpdate(
            {
                _id: req.params.id,
                ...buildScopedNotificationQuery({
                    userId: req.user.id,
                    role: req.user.role,
                    ...(surface ? { surface } : {}),
                }),
            },
            { read: true, readAt: new Date() },
            { new: true }
        );
        if (!n) return res.status(404).json({ msg: 'Notification not found' });
        res.json({
            account: {
                userId: String(req.user.id),
                role: req.user.role,
                ...(surface ? { surface } : {}),
            },
            notification: n,
        });
    } catch (err) {
        console.error('markRead:', err);
        res.status(500).json({ msg: 'Failed to mark read' });
    }
};

// POST /api/notifications/read-all
exports.markAllRead = async (req, res) => {
    try {
        const requestedSurface = requestedNotificationSurface(req);
        if (requestedSurface.error) return res.status(400).json(requestedSurface.error);
        const { surface } = requestedSurface;
        await Notification.updateMany(
            buildScopedNotificationQuery({
                userId: req.user.id,
                role: req.user.role,
                read: false,
                ...(surface ? { surface } : {}),
            }),
            { read: true, readAt: new Date() }
        );
        res.json({
            ok: true,
            account: {
                userId: String(req.user.id),
                role: req.user.role,
                ...(surface ? { surface } : {}),
            },
        });
    } catch (err) {
        console.error('markAllRead:', err);
        res.status(500).json({ msg: 'Failed to mark all read' });
    }
};

// ─────────────────────────── dispatcher (called by cron loop) ───────────────────────────

exports.processDueBroadcasts = async () => {
    const now = new Date();
    // Requeue expired leases first. This recovers process crashes and legacy
    // jobs that were left in `sending` without a lease, while the claim below
    // still ensures only one worker can own the recovered run.
    await reapExpiredBroadcastLeases(now);
    // Atomically claim each job. The previous find-then-save sequence let two
    // overlapping cron ticks or service replicas load and send the same job.
    for (let claimedCount = 0; claimedCount < 20; claimedCount += 1) {
        const leaseToken = crypto.randomUUID();
        const leaseAcquiredAt = new Date();
        const job = await BroadcastJob.findOneAndUpdate(
            { status: 'scheduled', nextRunAt: { $lte: now } },
            {
                $set: {
                    status: 'sending',
                    leaseToken,
                    leaseAcquiredAt,
                    leaseExpiresAt: new Date(leaseAcquiredAt.getTime() + BROADCAST_DELIVERY_LEASE_MS),
                },
            },
            { new: true, sort: { nextRunAt: 1, _id: 1 } }
        );
        if (!job) break;

        try {
            if (!job.channels || job.channels.length === 0) job.channels = ['inapp', 'push'];
            const stats = await dispatchBroadcast(job, { leaseToken });
            await finalizeSuccessfulBroadcastRun(job, leaseToken, stats);
        } catch (err) {
            console.error('[broadcast] dispatch failed for', job._id, err.message);
            if (err.code !== 'BROADCAST_LEASE_LOST') {
                await failBroadcastRun(job, leaseToken, err).catch((failureError) => {
                    console.error('[broadcast] failed to persist job failure:', failureError.message);
                });
            }
        }
    }
};

exports._dispatchBroadcast = dispatchBroadcast; // exported for tests
exports._computeNextRunAt = computeNextRunAt;
exports._computeNextFutureRunAt = computeNextFutureRunAt;
exports._reapExpiredBroadcastLeases = reapExpiredBroadcastLeases;
