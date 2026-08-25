const crypto = require('crypto');
const AIChatDailyUsage = require('../models/AIChatDailyUsage');

const DAILY_LIMITS = Object.freeze({
    guest: 5,
    user: 20,
    seller: Infinity,
    seller_sub: Infinity,
    admin: Infinity,
});

const guestHashSecret = () => {
    const secret = String(
        process.env.AI_RATE_LIMIT_HASH_SECRET
        || process.env.JWT_SECRET
        || ''
    );
    if (!secret) {
        const error = new Error('AI guest usage protection is temporarily unavailable.');
        error.statusCode = 503;
        error.code = 'AI_USAGE_HASH_SECRET_MISSING';
        throw error;
    }
    return secret;
};

const normalizeRole = (req) => {
    if (!req.user) return 'guest';
    const role = String(req.user.role || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(DAILY_LIMITS, role) ? role : 'guest';
};

const utcDay = (now = new Date()) => {
    const value = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(value.getTime())) throw new TypeError('A valid date is required');
    const date = value.toISOString().slice(0, 10);
    const resetAtDate = new Date(`${date}T00:00:00.000Z`);
    resetAtDate.setUTCDate(resetAtDate.getUTCDate() + 1);
    return { date, resetAt: resetAtDate.toISOString() };
};

const requestSubject = (req, date) => {
    const userId = req.user?.id || req.user?._id;
    if (userId) {
        const normalizedUserId = String(userId);
        return {
            key: `${date}:user:${normalizedUserId}`,
            subjectType: 'user',
            userId: normalizedUserId,
            ipHash: null,
        };
    }

    // Store only a one-way digest. req.ip already follows Express's configured
    // proxy trust policy, whereas accepting a caller-supplied IP header here would
    // make the guest quota trivial to spoof.
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').trim().toLowerCase();
    const ipHash = crypto.createHmac('sha256', guestHashSecret()).update(ip).digest('hex');
    return {
        key: `${date}:guest:${ipHash}`,
        subjectType: 'guest',
        userId: null,
        ipHash,
    };
};

const publicUsage = ({ used, limit, role, resetAt, allowed = true }) => ({
    allowed,
    used,
    limit: limit === Infinity ? -1 : limit,
    remaining: limit === Infinity ? -1 : Math.max(0, limit - used),
    role,
    resetAt,
});

const usageContext = (req, now) => {
    const role = normalizeRole(req);
    const limit = DAILY_LIMITS[role] ?? DAILY_LIMITS.guest;
    const { date, resetAt } = utcDay(now);
    const subject = requestSubject(req, date);
    return { role, limit, date, resetAt, subject };
};

async function getDailyUsageForRequest(req, { now = new Date() } = {}) {
    const context = usageContext(req, now);
    if (context.limit === Infinity) {
        return publicUsage({ used: 0, ...context });
    }

    const record = await AIChatDailyUsage.findById(context.subject.key).lean();
    const used = record?.messageCount || 0;
    return publicUsage({
        used,
        allowed: used < context.limit,
        ...context,
    });
}

async function consumeDailyUsageForRequest(req, { now = new Date() } = {}) {
    const context = usageContext(req, now);
    if (context.limit === Infinity) {
        return publicUsage({ used: 0, ...context });
    }

    const resetAtDate = new Date(context.resetAt);
    const expiresAt = new Date(resetAtDate.getTime() + (24 * 60 * 60 * 1000));
    const filter = {
        _id: context.subject.key,
        messageCount: { $lt: context.limit },
    };
    const update = {
        $inc: { messageCount: 1 },
        $setOnInsert: {
            subjectType: context.subject.subjectType,
            userId: context.subject.userId,
            ipHash: context.subject.ipHash,
            role: context.role,
            date: context.date,
            expiresAt,
        },
    };

    let record;
    try {
        record = await AIChatDailyUsage.findOneAndUpdate(filter, update, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }).lean();
    } catch (error) {
        if (error?.code !== 11000) throw error;
        // A concurrent insert, or an upsert attempted after the existing record
        // reached its cap, collides with the deterministic _id. Retrying without
        // upsert either consumes one remaining slot or returns null at the cap.
        record = await AIChatDailyUsage.findOneAndUpdate(filter, update, {
            upsert: false,
            new: true,
        }).lean();
    }

    if (record) {
        return publicUsage({ used: record.messageCount, ...context });
    }

    const current = await AIChatDailyUsage.findById(context.subject.key).lean();
    return publicUsage({
        used: Math.max(context.limit, current?.messageCount || 0),
        allowed: false,
        ...context,
    });
}

module.exports = {
    DAILY_LIMITS,
    consumeDailyUsageForRequest,
    getDailyUsageForRequest,
};
