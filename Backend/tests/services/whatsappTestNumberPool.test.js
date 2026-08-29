'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const WhatsAppTestMessage = require('../../models/WhatsAppTestMessage');
const WhatsAppTestNumber = require('../../models/WhatsAppTestNumber');
const {
    captureOutboundIfTestNumber,
    isActiveTestNumber,
    provisionTestNumberPool,
    testNumberForSlot,
    testPoolNumbers,
} = require('../../services/whatsapp/testNumberPoolService');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Promise.all([WhatsAppTestNumber.init(), WhatsAppTestMessage.init()]);
}, 60000);

afterEach(async () => {
    await Promise.all([
        WhatsAppTestNumber.deleteMany({}),
        WhatsAppTestMessage.deleteMany({}),
    ]);
});

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
}, 60000);

describe('fixed WhatsApp test-number pool', () => {
    test('generates exactly the reserved +1 202-555-0100 through 0149 range', () => {
        const numbers = testPoolNumbers();
        expect(numbers).toHaveLength(50);
        expect(numbers[0]).toBe('12025550100');
        expect(numbers[49]).toBe('12025550149');
        expect(new Set(numbers).size).toBe(50);
        expect(testNumberForSlot(1)).toBe(numbers[0]);
        expect(testNumberForSlot(50)).toBe(numbers[49]);
        expect(() => testNumberForSlot(0)).toThrow(RangeError);
        expect(() => testNumberForSlot(51)).toThrow(RangeError);
    });

    test('provisions all 50 records idempotently and reactivates the pool', async () => {
        await provisionTestNumberPool();
        await WhatsAppTestNumber.updateOne({ number: '12025550117' }, { $set: { isActive: false } });
        await provisionTestNumberPool();

        const records = await WhatsAppTestNumber.find().sort({ slot: 1 }).lean();
        expect(records).toHaveLength(50);
        expect(records.every(record => record.isActive)).toBe(true);
        expect(records.map(record => record.slot)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    });

    test('captures messages only for active records in the fixed range', async () => {
        await provisionTestNumberPool();
        expect(await isActiveTestNumber('+1 (202) 555-0101')).toBe(true);
        expect(await isActiveTestNumber('+1 212 555 0101')).toBe(false);

        const captured = await captureOutboundIfTestNumber({
            number: '+1 (202) 555-0101',
            instanceName: 'rozare-seller',
            instanceType: 'seller',
            messageType: 'text',
            text: 'Your verification code is: *123456*',
            payload: { text: 'Your verification code is: *123456*' },
        });
        expect(captured.virtualTestTransport).toBe(true);
        expect(captured.messageId).toMatch(/^rozare-test-/);
        expect(await WhatsAppTestMessage.countDocuments({ number: '12025550101' })).toBe(1);

        const normalDelivery = await captureOutboundIfTestNumber({
            number: '+1 212 555 0101',
            instanceName: 'rozare-seller',
            instanceType: 'seller',
            messageType: 'text',
            text: 'Must not be captured',
        });
        expect(normalDelivery).toBeNull();
        expect(await WhatsAppTestMessage.countDocuments()).toBe(1);

        await WhatsAppTestNumber.updateOne({ number: '12025550101' }, { $set: { isActive: false } });
        expect(await captureOutboundIfTestNumber({
            number: '+1 202 555 0101',
            messageType: 'text',
            text: 'Inactive must not be captured',
        })).toBeNull();
    });
});
