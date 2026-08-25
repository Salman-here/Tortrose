const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

const decodeEncryptionKey = (encoded) => {
    const value = String(encoded || '').trim();
    if (!value) return null;

    if (/^[a-fA-F0-9]{64}$/u.test(value)) {
        return Buffer.from(value, 'hex');
    }

    // Buffer.from is deliberately permissive, so validate the alphabet and
    // round-trip the canonical value before accepting key material.
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
    try {
        const decoded = Buffer.from(value, 'base64');
        const normalizedInput = value.replace(/=+$/u, '');
        const normalizedOutput = decoded.toString('base64').replace(/=+$/u, '');
        return decoded.length === 32 && normalizedInput === normalizedOutput
            ? decoded
            : null;
    } catch (_) {
        return null;
    }
};

const normalizeKeyId = (value, { defaultValue = null } = {}) => {
    const keyId = String(value ?? defaultValue ?? '').trim();
    return KEY_ID_PATTERN.test(keyId) ? keyId : null;
};

const parsePreviousEncryptionKeys = (rawValue) => {
    const raw = String(rawValue || '').trim();
    if (!raw) return { keys: {}, errors: [] };
    if (raw.length > 16384) {
        return {
            keys: {},
            errors: ['PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON is too large'],
        };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return {
            keys: {},
            errors: ['PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON must be a JSON object'],
        };
    }

    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
        return {
            keys: {},
            errors: ['PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON must be a JSON object'],
        };
    }

    // JSON.parse keeps only the last value for duplicate object keys. Scan the
    // deliberately flat, canonical key map as well so duplicate, escaped, or
    // whitespace-normalized IDs cannot silently select different key material.
    const rawKeyTokens = [...raw.matchAll(
        /"((?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\u0000-\u001F])*)"\s*:/gu
    )].map(match => match[1]);
    const decodedRawKeyIds = rawKeyTokens.map((token) => {
        try {
            return JSON.parse(`"${token}"`);
        } catch (_) {
            return null;
        }
    });
    if (
        decodedRawKeyIds.length !== Object.keys(parsed).length
        || decodedRawKeyIds.some((keyId, index) => keyId === null || keyId !== rawKeyTokens[index])
        || new Set(decodedRawKeyIds).size !== decodedRawKeyIds.length
    ) {
        return {
            keys: {},
            errors: [
                'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON contains duplicate or non-canonical key IDs',
            ],
        };
    }

    const keys = Object.create(null);
    const errors = [];
    for (const [rawKeyId, encodedKey] of Object.entries(parsed)) {
        const keyId = normalizeKeyId(rawKeyId);
        if (!keyId || rawKeyId !== keyId) {
            errors.push('PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON contains an invalid key ID');
            continue;
        }
        const key = decodeEncryptionKey(encodedKey);
        if (!key) {
            errors.push(
                `PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON key ${keyId} must contain exactly 32 random bytes encoded as base64 or 64 hexadecimal characters`
            );
            continue;
        }
        keys[keyId] = key;
    }

    return { keys, errors };
};

const readPayoutEncryptionConfiguration = (environment = process.env) => {
    const configuredKeyId = environment.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
    const currentKeyId = normalizeKeyId(configuredKeyId, { defaultValue: 'v1' });
    const currentKey = decodeEncryptionKey(environment.PAYOUT_ACCOUNT_ENCRYPTION_KEY);
    const previous = parsePreviousEncryptionKeys(
        environment.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON
    );
    const errors = [...previous.errors];

    if (configuredKeyId !== undefined && !currentKeyId) {
        errors.push('PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID contains unsupported characters');
    }
    if (environment.PAYOUT_ACCOUNT_ENCRYPTION_KEY && !currentKey) {
        errors.push(
            'PAYOUT_ACCOUNT_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64 or 64 hexadecimal characters'
        );
    }
    if (currentKeyId && Object.prototype.hasOwnProperty.call(previous.keys, currentKeyId)) {
        errors.push(
            'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON must not repeat the active PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID'
        );
    }

    return {
        currentKeyId,
        currentKey,
        previousKeys: previous.keys,
        errors: [...new Set(errors)],
    };
};

module.exports = {
    KEY_ID_PATTERN,
    decodeEncryptionKey,
    normalizeKeyId,
    parsePreviousEncryptionKeys,
    readPayoutEncryptionConfiguration,
};
