const {
    decodeEncryptionKey,
    parsePreviousEncryptionKeys,
    readPayoutEncryptionConfiguration,
} = require('../../services/payoutEncryptionConfig');

describe('payoutEncryptionConfig', () => {
    const activeKey = Buffer.alloc(32, 11).toString('base64');
    const oldKey = Buffer.alloc(32, 22).toString('base64');

    test('accepts only exact 32-byte hexadecimal or canonical base64 keys', () => {
        expect(decodeEncryptionKey(activeKey)).toHaveLength(32);
        expect(decodeEncryptionKey(Buffer.alloc(32, 4).toString('hex'))).toHaveLength(32);
        expect(decodeEncryptionKey(activeKey.replace(/=+$/u, ''))).toHaveLength(32);
        expect(decodeEncryptionKey(`${activeKey}!`)).toBeNull();
        expect(decodeEncryptionKey(Buffer.alloc(31, 1).toString('base64'))).toBeNull();
        expect(decodeEncryptionKey('not base64')).toBeNull();
    });

    test('validates every previous key ID and value', () => {
        const valid = parsePreviousEncryptionKeys(JSON.stringify({ 'old-v1': oldKey }));
        expect(valid.errors).toEqual([]);
        expect(valid.keys['old-v1']).toHaveLength(32);

        const invalid = parsePreviousEncryptionKeys(JSON.stringify({
            'bad key id': oldKey,
            'old-v2': 'weak',
        }));
        expect(invalid.errors).toEqual(expect.arrayContaining([
            'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON contains an invalid key ID',
            expect.stringContaining('old-v2'),
        ]));
    });

    test.each([
        [() => JSON.stringify({ old: oldKey, ' old ': activeKey })],
        [() => `{"old":"${oldKey}","old":"${activeKey}"}`],
        [() => `{"o\\u006cd":"${oldKey}"}`],
    ])('rejects duplicate, normalized, or escaped key IDs before JSON can overwrite them', (buildRaw) => {
        const result = parsePreviousEncryptionKeys(buildRaw());
        expect(result.errors.some(message => (
            message.includes('duplicate or non-canonical key IDs')
            || message.includes('invalid key ID')
        ))).toBe(true);
        if (result.keys.old) {
            expect(result.keys.old.equals(Buffer.from(oldKey, 'base64'))).toBe(true);
        }
    });

    test.each([
        ['[]'],
        ['null'],
        ['"not-an-object"'],
        ['{broken'],
    ])('rejects a non-object previous-key document: %s', (raw) => {
        expect(parsePreviousEncryptionKeys(raw).errors).not.toHaveLength(0);
    });

    test('rejects active-key collisions while preserving a valid rotation map', () => {
        const collision = readPayoutEncryptionConfiguration({
            PAYOUT_ACCOUNT_ENCRYPTION_KEY: activeKey,
            PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID: 'active-v2',
            PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({
                'active-v2': oldKey,
            }),
        });
        expect(collision.errors).toContain(
            'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON must not repeat the active PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID'
        );

        const valid = readPayoutEncryptionConfiguration({
            PAYOUT_ACCOUNT_ENCRYPTION_KEY: activeKey,
            PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID: 'active-v2',
            PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({
                'old-v1': oldKey,
            }),
        });
        expect(valid.errors).toEqual([]);
        expect(valid.currentKeyId).toBe('active-v2');
        expect(valid.previousKeys['old-v1']).toHaveLength(32);
    });
});
