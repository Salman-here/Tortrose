'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockHandleEvolutionWebhook = jest.fn();
jest.mock('../../services/whatsapp/webhookHandler', () => ({
    handleEvolutionWebhook: (...args) => mockHandleEvolutionWebhook(...args),
}));

const WhatsAppTestMessage = require('../../models/WhatsAppTestMessage');
const WhatsAppTestNumber = require('../../models/WhatsAppTestNumber');
const { provisionTestNumberPool } = require('../../services/whatsapp/testNumberPoolService');
const controller = require('../../controllers/adminWhatsAppTestInboxController');

let mongoServer;

const makeResponse = () => {
    const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    return response;
};

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([WhatsAppTestNumber.init(), WhatsAppTestMessage.init()]);
}, 60000);

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
        WhatsAppTestNumber.deleteMany({}),
        WhatsAppTestMessage.deleteMany({}),
    ]);
    await provisionTestNumberPool();
    mockHandleEvolutionWebhook.mockImplementation(async (_req, res) => res.status(200).json({ ok: true }));
});

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
}, 60000);

describe('admin WhatsApp test inbox actions', () => {
    test('replays only a button captured on the selected test message', async () => {
        const outbound = await WhatsAppTestMessage.create({
            number: '12025550101',
            direction: 'outbound',
            instanceName: 'rozare-seller',
            instanceType: 'seller',
            messageType: 'buttons',
            text: 'Choose an order action',
            payload: {
                buttons: [
                    { id: 'confirm_ORD-TEST-1', displayText: 'Confirm order' },
                    { id: 'cancel_ORD-TEST-1', displayText: 'Cancel order' },
                ],
            },
            messageId: 'outbound-test-message-1',
        });
        const req = {
            params: { id: outbound._id.toString() },
            body: { actionId: 'confirm_ORD-TEST-1' },
            user: {},
        };
        const res = makeResponse();

        await controller.applyMessageAction(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockHandleEvolutionWebhook).toHaveBeenCalledTimes(1);
        const syntheticRequest = mockHandleEvolutionWebhook.mock.calls[0][0];
        expect(syntheticRequest.whatsappWebhookAuthenticated).toBe(true);
        expect(syntheticRequest.body.data.key.remoteJid).toBe('12025550101@s.whatsapp.net');
        expect(syntheticRequest.body.data.message.buttonsResponseMessage.selectedButtonId)
            .toBe('confirm_ORD-TEST-1');

        const inbound = await WhatsAppTestMessage.findOne({ direction: 'inbound' }).lean();
        expect(inbound.actionId).toBe('confirm_ORD-TEST-1');
        expect(String(inbound.sourceMessage)).toBe(String(outbound._id));
    });

    test('rejects an action id that was not present in the captured payload', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const outbound = await WhatsAppTestMessage.create({
            number: '12025550101',
            direction: 'outbound',
            instanceName: 'rozare-seller',
            instanceType: 'seller',
            messageType: 'buttons',
            text: 'Choose an order action',
            payload: { buttons: [{ id: 'confirm_ORD-TEST-2', displayText: 'Confirm order' }] },
            messageId: 'outbound-test-message-2',
        });
        const res = makeResponse();

        try {
            await controller.applyMessageAction({
                params: { id: outbound._id.toString() },
                body: { actionId: 'cancel_ORD-OTHER' },
                user: {},
            }, res);

            expect(res.statusCode).toBe(400);
            expect(mockHandleEvolutionWebhook).not.toHaveBeenCalled();
            expect(await WhatsAppTestMessage.countDocuments({ direction: 'inbound' })).toBe(0);
        } finally {
            errorSpy.mockRestore();
        }
    });
});
