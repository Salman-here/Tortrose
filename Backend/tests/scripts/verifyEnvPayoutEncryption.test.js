const path = require('path');
const { spawnSync } = require('child_process');

const backendDirectory = path.resolve(__dirname, '../..');
const validEnvironment = () => ({
    ...process.env,
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://127.0.0.1/verify-env-test',
    JWT_SECRET: 'verify-env-test-secret',
    WHATSAPP_WEBHOOK_SECRET: 'verify-env-whatsapp-webhook-secret',
    PAYOUT_ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString('base64'),
    PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID: 'active-v2',
    PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({
        'old-v1': Buffer.alloc(32, 42).toString('base64'),
    }),
    FRONTEND_URL: 'https://example.test',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-cloud-key',
    CLOUDINARY_API_SECRET: 'test-cloud-secret',
    clientID: 'test-client-id',
    clientSecret: 'test-client-secret',
    GOOGLE_CALLBACK_URL: 'https://example.test/google/callback',
    BREVO_API_KEY: 'test-brevo-key',
    BREVO_SENDER_NAME: 'Test Sender',
    BREVO_SENDER_EMAIL: 'sender@example.test',
    STRIPE_MODE: 'test',
    STRIPE_TEST_SECRET_KEY: 'sk_test_verify_env',
    STRIPE_TEST_PUBLISHABLE_KEY: 'pk_test_verify_env',
    STRIPE_TEST_WEBHOOK_SECRET: 'whsec_verify_env',
    STRIPE_MERCHANT_COUNTRY_CODE: 'US',
});

const verify = (environment) => spawnSync(
    process.execPath,
    ['verify-env.js'],
    {
        cwd: backendDirectory,
        env: environment,
        encoding: 'utf8',
        timeout: 15000,
    }
);

describe('verify-env payout encryption rotation validation', () => {
    test('accepts a strong active key and distinct strong previous keys', () => {
        const result = verify(validEnvironment());
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
    });

    test('rejects a weak previous key before deployment', () => {
        const environment = validEnvironment();
        environment.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON = JSON.stringify({
            'old-v1': 'weak-key',
        });
        const result = verify(environment);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON key old-v1 must contain exactly 32 random bytes'
        );
    });

    test('rejects an active key ID duplicated in the previous-key map', () => {
        const environment = validEnvironment();
        environment.PAYOUT_ACCOUNT_ENCRYPTION_PREVIOUS_KEYS_JSON = JSON.stringify({
            'active-v2': Buffer.alloc(32, 42).toString('base64'),
        });
        const result = verify(environment);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'must not repeat the active PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID'
        );
    });
});

describe('verify-env WhatsApp webhook authentication validation', () => {
    test('rejects deployment configuration with no webhook shared secret', () => {
        const environment = validEnvironment();
        delete environment.WHATSAPP_WEBHOOK_SECRET;
        delete environment.EVOLUTION_WEBHOOK_SECRET;

        const result = verify(environment);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('WHATSAPP_WEBHOOK_SECRET is required');
    });

    test('accepts the legacy secret temporarily and reports the migration requirement', () => {
        const environment = validEnvironment();
        delete environment.WHATSAPP_WEBHOOK_SECRET;
        environment.EVOLUTION_WEBHOOK_SECRET = 'legacy-webhook-secret';

        const result = verify(environment);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('legacy EVOLUTION_WEBHOOK_SECRET fallback is active');
    });
});
