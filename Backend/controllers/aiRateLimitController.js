const { getDailyUsageForRequest } = require('../services/aiChatRateLimitService');

const LIMIT_MESSAGE = 'Daily AI message limit reached. Resets at 00:00 UTC.';

exports.getRateLimit = async (req, res) => {
    try {
        return res.json(await getDailyUsageForRequest(req));
    } catch (error) {
        console.error('Get AI chat rate limit error:', error);
        return res.status(503).json({
            msg: 'AI usage status is temporarily unavailable.',
            code: 'AI_USAGE_UNAVAILABLE',
        });
    }
};

// Kept for compatibility with released mobile clients that call this endpoint
// before sending. It is intentionally read-only: the chat endpoints atomically
// consume the quota, so incrementing here would double-count those clients.
exports.preflightRateLimit = async (req, res) => {
    try {
        const usage = await getDailyUsageForRequest(req);
        if (usage.limit !== -1 && usage.remaining === 0) {
            return res.status(429).json({
                ...usage,
                msg: LIMIT_MESSAGE,
                code: 'AI_DAILY_LIMIT_REACHED',
            });
        }
        return res.json(usage);
    } catch (error) {
        console.error('Preflight AI chat rate limit error:', error);
        return res.status(503).json({
            msg: 'AI usage status is temporarily unavailable.',
            code: 'AI_USAGE_UNAVAILABLE',
        });
    }
};
