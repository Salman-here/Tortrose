const crypto = require('crypto');
const {
    readPayoutEncryptionConfiguration,
} = require('./payoutEncryptionConfig');

const SNAPSHOT_VERSION = 1;
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
const MAX_CIPHERTEXT_BYTES = 3072;

const payoutProtectionError = () => {
    const error = new Error(
        'Payout account protection is temporarily unavailable. Please retry later.'
    );
    error.statusCode = 503;
    error.code = 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED';
    return error;
};

const invalidDestinationError = (code = 'WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE') => {
    const error = new Error(
        'This withdrawal has no readable frozen payout destination and cannot advance. Contact support to review it safely.'
    );
    error.statusCode = 409;
    error.code = code;
    return error;
};

const encryptionKeyFor = (keyId) => {
    const configuration = readPayoutEncryptionConfiguration();
    if (configuration.errors.length) throw payoutProtectionError();
    if (keyId === configuration.currentKeyId) return configuration.currentKey;
    return configuration.previousKeys[keyId] || null;
};

const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
};

const aadFor = ({ sellerId, withdrawalId, authorization = null }) => Buffer.from(
    JSON.stringify(canonicalize({
        purpose: 'seller-withdrawal',
        sellerId: String(sellerId),
        withdrawalId: String(withdrawalId),
        version: SNAPSHOT_VERSION,
        authorization,
    })),
    'utf8'
);

const decodeCanonicalBase64Url = (value, { exactBytes = null, maxBytes = null } = {}) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
    try {
        const decoded = Buffer.from(value, 'base64url');
        if (decoded.toString('base64url') !== value) return null;
        if (exactBytes !== null && decoded.length !== exactBytes) return null;
        if (decoded.length === 0 || (maxBytes !== null && decoded.length > maxBytes)) return null;
        return decoded;
    } catch (_) {
        return null;
    }
};

const sealPayoutAccountSnapshot = (snapshot, context) => {
    const configuration = readPayoutEncryptionConfiguration();
    const keyId = configuration.currentKeyId;
    const key = configuration.currentKey;
    if (!keyId || !key || configuration.errors.length) throw payoutProtectionError();

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aadFor(context));
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(snapshot), 'utf8'),
        cipher.final(),
    ]);

    return JSON.stringify({
        v: SNAPSHOT_VERSION,
        k: keyId,
        i: iv.toString('base64url'),
        c: ciphertext.toString('base64url'),
        t: cipher.getAuthTag().toString('base64url'),
    });
};

const openPayoutAccountSnapshot = (envelope, context) => {
    if (!envelope) {
        throw invalidDestinationError('WITHDRAWAL_PAYOUT_DESTINATION_MISSING');
    }

    try {
        const serializedEnvelope = String(envelope);
        if (serializedEnvelope.length > 4096) throw new Error('Oversized payout snapshot envelope');
        const parsed = JSON.parse(serializedEnvelope);
        const envelopeKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.keys(parsed).sort()
            : [];
        if (
            parsed?.v !== SNAPSHOT_VERSION
            || !/^[A-Za-z0-9._-]{1,64}$/u.test(String(parsed?.k || ''))
            || JSON.stringify(envelopeKeys) !== JSON.stringify(['c', 'i', 'k', 't', 'v'])
        ) {
            throw new Error('Unsupported payout snapshot envelope');
        }
        const key = encryptionKeyFor(parsed.k);
        if (!key) throw new Error('Payout snapshot key unavailable');
        const iv = decodeCanonicalBase64Url(parsed.i, { exactBytes: IV_BYTES });
        const authTag = decodeCanonicalBase64Url(parsed.t, { exactBytes: AUTH_TAG_BYTES });
        const ciphertext = decodeCanonicalBase64Url(parsed.c, {
            maxBytes: MAX_CIPHERTEXT_BYTES,
        });
        if (!iv || !authTag || !ciphertext) {
            throw new Error('Malformed payout snapshot envelope');
        }

        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            iv,
            { authTagLength: AUTH_TAG_BYTES }
        );
        decipher.setAAD(aadFor(context));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');
        const snapshot = JSON.parse(plaintext);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            throw new Error('Invalid payout account snapshot');
        }
        return snapshot;
    } catch (error) {
        if (error?.code?.startsWith?.('WITHDRAWAL_PAYOUT_DESTINATION_')) throw error;
        if (error?.code === 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED') throw error;
        throw invalidDestinationError();
    }
};

const payoutEncryptionConfigurationIsValid = () => (
    (() => {
        const configuration = readPayoutEncryptionConfiguration();
        return Boolean(configuration.currentKeyId)
            && Boolean(configuration.currentKey)
            && configuration.errors.length === 0;
    })()
);

module.exports = {
    SNAPSHOT_VERSION,
    sealPayoutAccountSnapshot,
    openPayoutAccountSnapshot,
    payoutEncryptionConfigurationIsValid,
    invalidDestinationError,
};
