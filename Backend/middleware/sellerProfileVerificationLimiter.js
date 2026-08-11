const rateLimit = require('express-rate-limit');

const accountKey = (req) => `seller-profile:${req.user?.id || req.user?._id || req.ip}`;

const createLimiter = ({ windowMs, max, msg }) => rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: accountKey,
    handler: (req, res) => res.status(429).json({ msg }),
});

const emailChangeInitiateLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    max: 3,
    msg: 'Too many email verification requests. Please try again in an hour.',
});

const emailChangeVerifyLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    msg: 'Too many email verification attempts. Please try again in 15 minutes.',
});

module.exports = {
    emailChangeInitiateLimiter,
    emailChangeVerifyLimiter,
};
