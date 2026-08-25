const {
    sealPayoutAccountSnapshot,
    openPayoutAccountSnapshot,
    payoutEncryptionConfigurationIsValid,
} = require('../../services/payoutAccountSnapshotService');

const ENV_NAMES = [
    'PAYOUT_ACCOUNT_ENCRYPTION_KEY',
    'PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID',
    'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON',
];
const originalEnvironment = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));

const context = {
    sellerId: 'seller-1',
    withdrawalId: 'withdrawal-1',
};
const snapshot = {
    accountHolderName: 'Snapshot Holder',
    bankName: 'Snapshot Bank',
    accountNumber: '001122334455',
    iban: 'PK00SNAPSHOT1234',
    currency: 'PKR',
};

afterAll(() => {
    for (const name of ENV_NAMES) {
        if (originalEnvironment[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnvironment[name];
    }
});

beforeEach(() => {
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString('base64');
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = 'snapshot-v1';
    delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON;
});

describe('payoutAccountSnapshotService', () => {
    test('authenticates ciphertext to the exact seller and withdrawal without leaking plaintext', () => {
        const envelope = sealPayoutAccountSnapshot(snapshot, context);

        expect(envelope).not.toContain(snapshot.accountNumber);
        expect(envelope).not.toContain(snapshot.iban);
        expect(openPayoutAccountSnapshot(envelope, context)).toEqual(snapshot);
        expect(() => openPayoutAccountSnapshot(envelope, {
            ...context,
            withdrawalId: 'withdrawal-2',
        })).toThrow(expect.objectContaining({
            code: 'WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE',
        }));
    });

    test('rejects authenticated-envelope tampering', () => {
        const envelope = JSON.parse(sealPayoutAccountSnapshot(snapshot, context));
        envelope.c = `${envelope.c[0] === 'A' ? 'B' : 'A'}${envelope.c.slice(1)}`;

        expect(() => openPayoutAccountSnapshot(JSON.stringify(envelope), context)).toThrow(
            expect.objectContaining({ code: 'WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE' })
        );
    });

    test.each([
        ['truncated authentication tag', (envelope) => {
            envelope.t = Buffer.from(envelope.t, 'base64url').subarray(0, 4).toString('base64url');
        }],
        ['short initialization vector', (envelope) => {
            envelope.i = Buffer.alloc(11, 1).toString('base64url');
        }],
        ['empty ciphertext', (envelope) => {
            envelope.c = '';
        }],
        ['non-canonical tag encoding', (envelope) => {
            envelope.t = `${envelope.t}=`;
        }],
        ['unknown envelope field', (envelope) => {
            envelope.extra = 'not-authenticated';
        }],
    ])('rejects a malformed envelope with %s', (_label, mutate) => {
        const envelope = JSON.parse(sealPayoutAccountSnapshot(snapshot, context));
        mutate(envelope);

        expect(() => openPayoutAccountSnapshot(JSON.stringify(envelope), context)).toThrow(
            expect.objectContaining({ code: 'WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE' })
        );
    });

    test('decrypts an open request after key rotation only when the old key remains configured', () => {
        const oldKey = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
        const envelope = sealPayoutAccountSnapshot(snapshot, context);

        process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 47).toString('base64');
        process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = 'snapshot-v2';
        expect(() => openPayoutAccountSnapshot(envelope, context)).toThrow(
            expect.objectContaining({ code: 'WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE' })
        );

        process.env.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON = JSON.stringify({
            'snapshot-v1': oldKey,
        });
        expect(openPayoutAccountSnapshot(envelope, context)).toEqual(snapshot);
    });

    test('fails configuration validation for a weak or malformed key', () => {
        process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = 'not-a-32-byte-key';
        expect(payoutEncryptionConfigurationIsValid()).toBe(false);
        expect(() => sealPayoutAccountSnapshot(snapshot, context)).toThrow(
            expect.objectContaining({ code: 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED' })
        );
    });

    test('fails closed when the previous-key rotation map is malformed', () => {
        const envelope = sealPayoutAccountSnapshot(snapshot, context);
        process.env.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON = JSON.stringify({
            'snapshot-old': 'weak-key',
        });

        expect(payoutEncryptionConfigurationIsValid()).toBe(false);
        expect(() => sealPayoutAccountSnapshot(snapshot, context)).toThrow(
            expect.objectContaining({ code: 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED' })
        );
        expect(() => openPayoutAccountSnapshot(envelope, context)).toThrow(
            expect.objectContaining({ code: 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED' })
        );
    });

    test('fails closed when the previous-key map repeats the active key ID', () => {
        process.env.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON = JSON.stringify({
            'snapshot-v1': Buffer.alloc(32, 7).toString('base64'),
        });

        expect(payoutEncryptionConfigurationIsValid()).toBe(false);
        expect(() => sealPayoutAccountSnapshot(snapshot, context)).toThrow(
            expect.objectContaining({ code: 'PAYOUT_ACCOUNT_ENCRYPTION_NOT_CONFIGURED' })
        );
    });
});
