const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const WHATSAPP_WEBHOOK_HEADER = 'x-rozare-webhook-secret';
const CANONICAL_SECRET_ENV = 'WHATSAPP_WEBHOOK_SECRET';
const LEGACY_SECRET_ENV = 'EVOLUTION_WEBHOOK_SECRET';

const normalizeSecret = value => typeof value === 'string' ? value.trim() : '';

const resolveWhatsAppWebhookSecrets = (env = process.env) => {
    const canonical = normalizeSecret(env[CANONICAL_SECRET_ENV]);
    const legacy = normalizeSecret(env[LEGACY_SECRET_ENV]);
    const acceptedSecrets = [...new Set([canonical, legacy].filter(Boolean))];

    return {
        configured: acceptedSecrets.length > 0,
        primarySecret: canonical || legacy,
        acceptedSecrets,
        usingLegacyFallback: !canonical && Boolean(legacy),
        rotatingFromLegacy: Boolean(canonical && legacy && canonical !== legacy),
    };
};

// Compare fixed-length digests so a wrong secret never takes a different code
// path merely because its raw byte length differs from the configured value.
const secretsEqual = (provided, expected) => {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
    const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(providedDigest, expectedDigest);
};

const requestSecretCandidates = (req = {}) => {
    const headers = req.headers || {};
    return [...new Set([
        headers[WHATSAPP_WEBHOOK_HEADER],
        // Some Evolution builds expose configured webhook headers through the
        // historical `apikey` header name. It is accepted only when its value
        // is the dedicated webhook secret, never merely EVOLUTION_API_KEY.
        headers.apikey,
    ].flat().filter(value => typeof value === 'string' && value.length > 0))];
};

const verifyWhatsAppWebhookRequest = (req, env = process.env) => {
    const config = resolveWhatsAppWebhookSecrets(env);
    if (!config.configured) {
        return {
            ok: false,
            statusCode: 503,
            code: 'WHATSAPP_WEBHOOK_SECRET_NOT_CONFIGURED',
            msg: 'WhatsApp webhook authentication is unavailable',
        };
    }

    const candidates = requestSecretCandidates(req);
    const authenticated = candidates.some(candidate => (
        config.acceptedSecrets.some(expected => secretsEqual(candidate, expected))
    ));

    if (!authenticated) {
        return {
            ok: false,
            statusCode: 401,
            code: 'WHATSAPP_WEBHOOK_UNAUTHORIZED',
            msg: 'Unauthorized webhook',
        };
    }

    return { ok: true, config };
};

const createWhatsAppWebhookAuthenticator = (env = process.env) => (
    (req, res, next) => {
        const verification = verifyWhatsAppWebhookRequest(req, env);
        if (!verification.ok) {
            return res.status(verification.statusCode).json({
                msg: verification.msg,
                code: verification.code,
            });
        }

        req.whatsappWebhookAuthenticated = true;
        return next();
    }
);

const authenticateWhatsAppWebhook = createWhatsAppWebhookAuthenticator();

const createWhatsAppWebhookRateLimiter = (env = process.env) => {
    const configuredLimit = Number.parseInt(env.WHATSAPP_WEBHOOK_RATE_LIMIT_MAX || '', 10);
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : 120;

    return rateLimit({
        windowMs: 60 * 1000,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        validate: false,
        keyGenerator: req => req.ip || req.socket?.remoteAddress || 'unknown',
        message: {
            msg: 'Too many WhatsApp webhook requests. Please retry later.',
            code: 'WHATSAPP_WEBHOOK_RATE_LIMITED',
        },
        handler: (req, res, _next, options) => {
            return res.status(options.statusCode).json(options.message);
        },
    });
};

const createWhatsAppWebhookIngress = ({ jsonParser, env = process.env } = {}) => {
    if (typeof jsonParser !== 'function') {
        throw new TypeError('WhatsApp webhook ingress requires a JSON parser middleware');
    }
    return [
        createWhatsAppWebhookRateLimiter(env),
        createWhatsAppWebhookAuthenticator(env),
        jsonParser,
    ];
};

const requireWhatsAppWebhookAuthentication = (req, res) => {
    if (req.whatsappWebhookAuthenticated === true) return true;
    const verification = verifyWhatsAppWebhookRequest(req);
    if (verification.ok) {
        req.whatsappWebhookAuthenticated = true;
        return true;
    }

    res.status(verification.statusCode).json({
        msg: verification.msg,
        code: verification.code,
    });
    return false;
};

const getOutboundWhatsAppWebhookSecret = (env = process.env) => {
    const config = resolveWhatsAppWebhookSecrets(env);
    if (config.configured) return config.primarySecret;

    const error = new Error(
        `${CANONICAL_SECRET_ENV} is required before an Evolution webhook can be registered`
    );
    error.code = 'WHATSAPP_WEBHOOK_SECRET_NOT_CONFIGURED';
    throw error;
};

module.exports = {
    CANONICAL_SECRET_ENV,
    LEGACY_SECRET_ENV,
    WHATSAPP_WEBHOOK_HEADER,
    authenticateWhatsAppWebhook,
    createWhatsAppWebhookAuthenticator,
    createWhatsAppWebhookIngress,
    createWhatsAppWebhookRateLimiter,
    getOutboundWhatsAppWebhookSecret,
    requireWhatsAppWebhookAuthentication,
    resolveWhatsAppWebhookSecrets,
    secretsEqual,
    verifyWhatsAppWebhookRequest,
};
