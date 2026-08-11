const Notification = require('../models/Notification');
const BroadcastJob = require('../models/BroadcastJob');
const User = require('../models/User');
const { sendExpoPush } = require('../utils/expoPush');
const { sendEmail } = require('./mailController');
const { broadcastEmail } = require('../utils/emailTemplates');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const sellerEvolution = require('../services/whatsapp/sellerEvolutionClient');
const {
    VALID_BROADCAST_AUDIENCES,
    buildScopedNotificationQuery,
    normalizeBroadcastAudience,
} = require('../services/notificationAudienceService');

// ─────────────────────────── helpers ───────────────────────────

const buildAudienceQuery = (audience, userIds) => {
    if (audience === 'specific') {
        return { _id: { $in: userIds || [] } };
    }
    if (audience === 'all_users') return { role: 'user' };
    if (audience === 'all_sellers') return { role: 'seller' };
    if (audience === 'both') return { role: { $in: ['user', 'seller'] } };
    // Invalid/missing audiences must never degrade into a query for every
    // account. Validation normally rejects this before dispatch, while this
    // fail-closed branch also protects scheduled/legacy jobs.
    return { _id: { $in: [] } };
};

const computeNextRunAt = (current, recurrence) => {
    const d = new Date(current);
    if (recurrence === 'daily') d.setDate(d.getDate() + 1);
    else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
    else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
    else return null;
    return d;
};

/**
 * Execute one run of a BroadcastJob: resolve recipients, then fan out to
 * the selected channels (inapp, push, email, whatsapp). Returns delivery stats.
 */
const dispatchBroadcast = async (job) => {
    const channels = job.channels || ['inapp', 'push'];
    const audienceQuery = buildAudienceQuery(job.audience, job.userIds);
    const recipients = await User.find(audienceQuery)
        .select('_id role expoPushTokens email sellerInfo whatsappNotificationPrefs')
        .lean();

    if (!recipients.length) return { recipients: 0, pushSent: 0, emailSent: 0, whatsappSent: 0 };

    let pushSent = 0;
    let emailSent = 0;
    let whatsappSent = 0;

    // ── Channel: In-App Notifications ──
    if (channels.includes('inapp')) {
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
        }));
        await Notification.insertMany(docs, { ordered: false }).catch((err) =>
            console.warn('[broadcast] insertMany partial failure:', err.message)
        );
    }

    // ── Channel: Push Notifications (Expo) ──
    if (channels.includes('push')) {
        // Keep each authority scope and payload bound to one account. Bounded
        // concurrency avoids serial latency without reintroducing role-wide
        // token groups that can cross account boundaries during ownership lag.
        const pushRecipients = recipients.filter(recipient => recipient.expoPushTokens?.length);
        const PUSH_CONCURRENCY = 10;
        for (let i = 0; i < pushRecipients.length; i += PUSH_CONCURRENCY) {
            const batch = pushRecipients.slice(i, i + PUSH_CONCURRENCY);
            const deliveries = await Promise.all(batch.map((recipient) => {
                const recipientUserId = String(recipient._id);
                const targetRole = recipient.role || 'user';
                return sendExpoPush(recipient.expoPushTokens, {
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
            const batch = emailRecipients.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
                batch.map((u) =>
                    sendEmail({ to: u.email, subject: emailData.subject, html: emailData.html })
                        .then(() => 1)
                        .catch((err) => {
                            console.warn('[broadcast] email failed for', u.email, err.message);
                            return 0;
                        })
                )
            );
            emailSent += results.reduce((sum, v) => sum + v, 0);
        }
    }

    // ── Channel: WhatsApp (dispatched asynchronously to avoid blocking) ──
    if (channels.includes('whatsapp')) {
        // Check connection upfront; actual sending happens in background
        try {
            const cfg = await WhatsAppConfig.findOne({ singletonKey: 'seller' });
            if (cfg && cfg.status === 'connected') {
                const waRecipients = recipients.filter((u) => {
                    if (u.sellerInfo?.whatsappNumber && u.sellerInfo?.whatsappVerified) return true;
                    if (u.sellerInfo?.phoneNumber) return true;
                    return false;
                });
                // Fire-and-forget: dispatch in background, update job stats when done
                const jobId = job._id;
                const waMessage = `*${job.title}*\n\n${job.body}${job.linkTo ? `\n\n🔗 ${process.env.FRONTEND_URL || 'https://rozare.com'}${job.linkTo}` : ''}`;
                setImmediate(async () => {
                    let waSent = 0;
                    for (const u of waRecipients) {
                        let phone = u.sellerInfo?.whatsappNumber && u.sellerInfo?.whatsappVerified
                            ? u.sellerInfo.whatsappNumber
                            : u.sellerInfo?.phoneNumber;
                        const digits = phone?.replace(/\D/g, '');
                        if (!digits) continue;
                        try {
                            await sellerEvolution.sendText(digits, waMessage);
                            waSent++;
                        } catch (err) {
                            console.warn('[broadcast] whatsapp failed for user', String(u._id), err.message);
                        }
                    }
                    // Update stats in DB after all WhatsApp messages are sent
                    try {
                        await BroadcastJob.updateOne(
                            { _id: jobId },
                            { $inc: { 'stats.whatsappSent': waSent } }
                        );
                    } catch (err) {
                        console.error('[broadcast] failed to update whatsapp stats:', err.message);
                    }
                });
                // Return estimated count (actual count updated async)
                whatsappSent = waRecipients.length; // optimistic estimate
            } else {
                console.warn('[broadcast] WhatsApp instance not connected — skipping whatsapp channel');
            }
        } catch (err) {
            console.warn('[broadcast] WhatsApp channel error:', err.message);
        }
    }

    return { recipients: recipients.length, pushSent, emailSent, whatsappSent };
};

// ─────────────────────────── admin endpoints ───────────────────────────

// POST /api/notifications/broadcast — admin
exports.createBroadcast = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ msg: 'Admin only' });
        }

        const {
            title,
            body,
            category = 'announcement',
            linkTo = '',
            audience = 'all_users',
            userIds = [],
            channels = ['inapp', 'push'],
            scheduleType = 'immediate',
            scheduledAt = null, // ISO string for one_time / recurring start
            recurrence = 'none',
            endsAt = null,
        } = req.body || {};

        if (!title || !body) {
            return res.status(400).json({ msg: 'title and body are required' });
        }
        if (!Array.isArray(channels) || channels.length === 0) {
            return res.status(400).json({ msg: 'channels must be a non-empty array' });
        }
        const validChannels = ['inapp', 'push', 'email', 'whatsapp'];
        if (channels.some((ch) => !validChannels.includes(ch))) {
            return res.status(400).json({ msg: `Invalid channel. Allowed: ${validChannels.join(', ')}` });
        }
        if (audience === 'specific' && (!Array.isArray(userIds) || userIds.length === 0)) {
            return res.status(400).json({ msg: 'userIds required when audience is "specific"' });
        }
        if (!normalizeBroadcastAudience(audience)) {
            return res.status(400).json({
                msg: `Invalid audience. Allowed: ${Array.from(VALID_BROADCAST_AUDIENCES).join(', ')}`,
            });
        }

        const now = new Date();
        let nextRunAt = now;
        if (scheduleType === 'one_time' || scheduleType === 'recurring') {
            if (!scheduledAt) {
                return res.status(400).json({ msg: 'scheduledAt is required for scheduled broadcasts' });
            }
            nextRunAt = new Date(scheduledAt);
            if (Number.isNaN(nextRunAt.getTime())) {
                return res.status(400).json({ msg: 'Invalid scheduledAt' });
            }
        }

        const job = await BroadcastJob.create({
            title,
            body,
            category,
            linkTo,
            audience,
            userIds: audience === 'specific' ? userIds : [],
            channels,
            scheduleType,
            recurrence: scheduleType === 'recurring' ? recurrence : 'none',
            nextRunAt,
            endsAt: endsAt ? new Date(endsAt) : null,
            status: 'scheduled',
            createdBy: req.user.id,
        });

        // Fire immediate jobs synchronously so the admin gets instant feedback.
        if (scheduleType === 'immediate') {
            try {
                job.status = 'sending';
                await job.save();
                const stats = await dispatchBroadcast(job);
                job.status = 'sent';
                job.lastRunAt = new Date();
                job.runCount = 1;
                job.stats = {
                    recipients: stats.recipients,
                    pushSent: stats.pushSent,
                    emailSent: stats.emailSent,
                    whatsappSent: stats.whatsappSent,
                };
                job.nextRunAt = null;
                await job.save();
            } catch (err) {
                job.status = 'failed';
                job.lastError = String(err.message || err).slice(0, 500);
                await job.save();
                console.error('[broadcast] immediate dispatch failed:', err.message);
                return res.status(500).json({ msg: 'Broadcast dispatch failed. Please try again or check server logs.', jobId: job._id, status: job.status });
            }
        }

        res.status(201).json({ job });
    } catch (err) {
        console.error('createBroadcast:', err);
        res.status(500).json({ msg: 'Failed to create broadcast' });
    }
};

// GET /api/notifications/broadcasts — admin: list all jobs
exports.listBroadcasts = async (req, res) => {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Admin only' });
        const jobs = await BroadcastJob.find()
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
        const job = await BroadcastJob.findById(req.params.id);
        if (!job) return res.status(404).json({ msg: 'Broadcast not found' });
        if (['sent', 'cancelled'].includes(job.status) && job.scheduleType !== 'recurring') {
            return res.status(400).json({ msg: 'Broadcast already finalized' });
        }
        job.status = 'cancelled';
        job.nextRunAt = null;
        await job.save();
        res.json({ job });
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
        const filter = {};
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

// GET /api/notifications/me — list my notifications
exports.listMine = async (req, res) => {
    try {
        const scopedQuery = buildScopedNotificationQuery({
            userId: req.user.id,
            role: req.user.role,
        });
        const items = await Notification.find(scopedQuery)
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        const unread = await Notification.countDocuments(buildScopedNotificationQuery({
            userId: req.user.id,
            role: req.user.role,
            read: false,
        }));
        res.json({ items, unread });
    } catch (err) {
        console.error('listMine:', err);
        res.status(500).json({ msg: 'Failed to fetch notifications' });
    }
};

// PATCH /api/notifications/:id/read
exports.markRead = async (req, res) => {
    try {
        const n = await Notification.findOneAndUpdate(
            {
                _id: req.params.id,
                ...buildScopedNotificationQuery({
                    userId: req.user.id,
                    role: req.user.role,
                }),
            },
            { read: true, readAt: new Date() },
            { new: true }
        );
        if (!n) return res.status(404).json({ msg: 'Notification not found' });
        res.json({ notification: n });
    } catch (err) {
        console.error('markRead:', err);
        res.status(500).json({ msg: 'Failed to mark read' });
    }
};

// POST /api/notifications/read-all
exports.markAllRead = async (req, res) => {
    try {
        await Notification.updateMany(
            buildScopedNotificationQuery({
                userId: req.user.id,
                role: req.user.role,
                read: false,
            }),
            { read: true, readAt: new Date() }
        );
        res.json({ ok: true });
    } catch (err) {
        console.error('markAllRead:', err);
        res.status(500).json({ msg: 'Failed to mark all read' });
    }
};

// ─────────────────────────── dispatcher (called by cron loop) ───────────────────────────

exports.processDueBroadcasts = async () => {
    const now = new Date();
    const due = await BroadcastJob.find({
        status: 'scheduled',
        nextRunAt: { $lte: now },
    }).limit(20);

    for (const job of due) {
        try {
            job.status = 'sending';
            if (!job.channels || job.channels.length === 0) job.channels = ['inapp', 'push'];
            await job.save();
            const stats = await dispatchBroadcast(job);
            job.lastRunAt = new Date();
            job.runCount = (job.runCount || 0) + 1;
            job.stats = {
                recipients: (job.stats?.recipients || 0) + stats.recipients,
                pushSent: (job.stats?.pushSent || 0) + stats.pushSent,
                emailSent: (job.stats?.emailSent || 0) + stats.emailSent,
                whatsappSent: (job.stats?.whatsappSent || 0) + stats.whatsappSent,
            };
            if (job.scheduleType === 'recurring' && job.recurrence !== 'none') {
                const next = computeNextRunAt(job.nextRunAt || now, job.recurrence);
                if (next && (!job.endsAt || next <= job.endsAt)) {
                    job.status = 'scheduled';
                    job.nextRunAt = next;
                } else {
                    job.status = 'sent';
                    job.nextRunAt = null;
                }
            } else {
                job.status = 'sent';
                job.nextRunAt = null;
            }
            await job.save();
        } catch (err) {
            console.error('[broadcast] dispatch failed for', job._id, err.message);
            job.status = 'failed';
            job.lastError = String(err.message || err).slice(0, 500);
            await job.save();
        }
    }
};

exports._dispatchBroadcast = dispatchBroadcast; // exported for tests
