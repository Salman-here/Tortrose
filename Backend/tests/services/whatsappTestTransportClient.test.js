'use strict';

const mockPost = jest.fn();
const mockCaptureOutbound = jest.fn();
const mockIsActiveTestNumber = jest.fn();
const mockIsReservedTestPoolNumber = jest.fn();

jest.mock('axios', () => ({
    create: jest.fn(() => ({
        post: mockPost,
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        interceptors: { response: { use: jest.fn() } },
    })),
}));
jest.mock('../../services/whatsapp/testNumberPoolService', () => ({
    captureOutboundIfTestNumber: (...args) => mockCaptureOutbound(...args),
    isActiveTestNumber: (...args) => mockIsActiveTestNumber(...args),
    isReservedTestPoolNumber: (...args) => mockIsReservedTestPoolNumber(...args),
}));
jest.mock('../../services/whatsapp/jidRoutingStore', () => ({
    rememberInboundRoute: jest.fn(),
    resolveOutboundRecipient: jest.fn(async (_phone, fallback) => fallback || ''),
}));
jest.mock('../../services/whatsapp/gatewayHealth', () => ({
    isZombieGatewayError: jest.fn(() => false),
    isZombieGatewayBody: jest.fn(() => false),
    reportZombieSignal: jest.fn(),
}));

const createEvolutionClient = require('../../services/whatsapp/createEvolutionClient');

const ENV_KEYS = ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_SELLER_INSTANCE_NAME'];
let savedEnv;

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    process.env.EVOLUTION_API_URL = 'https://evolution.test';
    process.env.EVOLUTION_API_KEY = 'test-key';
    process.env.EVOLUTION_SELLER_INSTANCE_NAME = 'rozare-seller';
    jest.clearAllMocks();
    mockPost.mockResolvedValue({ data: { key: { id: 'provider-message-id' } } });
    mockCaptureOutbound.mockResolvedValue(null);
    mockIsActiveTestNumber.mockResolvedValue(false);
    mockIsReservedTestPoolNumber.mockReturnValue(false);
});

afterEach(() => {
    ENV_KEYS.forEach((key) => {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    });
});

describe('Evolution client test transport', () => {
    test('returns the virtual delivery without calling Evolution for a captured number', async () => {
        const virtual = {
            messageId: 'rozare-test-message',
            raw: { virtualTestTransport: true },
            virtualTestTransport: true,
        };
        mockCaptureOutbound.mockResolvedValue(virtual);
        const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');

        await expect(client.sendText('12025550101', 'OTP 123456')).resolves.toEqual(virtual);
        expect(mockCaptureOutbound).toHaveBeenCalledWith(expect.objectContaining({
            number: '12025550101',
            instanceName: 'rozare-seller',
            instanceType: 'seller',
            messageType: 'text',
        }));
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('continues to Evolution unchanged for a normal number', async () => {
        const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');
        const result = await client.sendText('923001234567', 'Normal delivery');

        expect(result.messageId).toBe('provider-message-id');
        expect(mockPost).toHaveBeenCalledWith(
            '/message/sendText/rozare-seller',
            expect.objectContaining({ number: expect.any(String), text: 'Normal delivery' })
        );
    });

    test('treats an active fictional test number as WhatsApp-capable without provider lookup', async () => {
        mockIsActiveTestNumber.mockResolvedValue(true);
        const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');

        await expect(client.checkWhatsAppNumber('12025550101')).resolves.toBe(true);
        expect(mockPost).not.toHaveBeenCalled();
    });

    test('skips typing presence for a virtual test number without creating an inbox message', async () => {
        mockIsReservedTestPoolNumber.mockReturnValue(true);
        const client = createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller');

        await expect(client.sendChatPresence('12025550101', {
            presence: 'composing',
            delay: 10000,
        })).resolves.toEqual({
            skipped: true,
            reason: 'virtual_test_number',
        });
        expect(mockCaptureOutbound).not.toHaveBeenCalled();
        expect(mockPost).not.toHaveBeenCalled();
    });
});
