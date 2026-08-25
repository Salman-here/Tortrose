const { consumeDailyUsageForRequest } = require('../services/aiChatRateLimitService');

const LIMIT_MESSAGE = 'Daily AI message limit reached. Resets at 00:00 UTC.';

const setUsageHeaders = (res, usage) => {
  if (usage.limit === -1) return;
  res.setHeader('X-RateLimit-Limit', String(usage.limit));
  res.setHeader('X-RateLimit-Remaining', String(usage.remaining));
  res.setHeader('X-RateLimit-Reset', usage.resetAt);
};

module.exports = async function aiChatDailyLimit(req, res, next) {
  try {
    const usage = await consumeDailyUsageForRequest(req);
    setUsageHeaders(res, usage);
    if (!usage.allowed) {
      return res.status(429).json({
        error: LIMIT_MESSAGE,
        msg: LIMIT_MESSAGE,
        code: 'AI_DAILY_LIMIT_REACHED',
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        role: usage.role,
        resetAt: usage.resetAt,
      });
    }

    // The controller recognizes this server-only marker and will not consume a
    // second slot. Placing this middleware before multer prevents exhausted
    // callers from repeatedly buffering large attachments in memory.
    req.aiChatDailyUsage = usage;
    return next();
  } catch (error) {
    console.error('AI chat daily usage middleware error:', error);
    const clientError = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500;
    const message = clientError
      ? error.message
      : 'AI usage service is temporarily unavailable.';
    return res.status(clientError ? error.statusCode : 503).json({
      error: message,
      msg: message,
      code: clientError ? error.code : 'AI_USAGE_UNAVAILABLE',
    });
  }
};
