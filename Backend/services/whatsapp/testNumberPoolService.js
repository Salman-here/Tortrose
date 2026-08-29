'use strict';

const crypto = require('crypto');
const WhatsAppTestNumber = require('../../models/WhatsAppTestNumber');
const WhatsAppTestMessage = require('../../models/WhatsAppTestMessage');

const TEST_POOL_SIZE = 50;
const TEST_NUMBER_FIRST_SUFFIX = 100;
const TEST_NUMBER_PREFIX = '12025550';

const normalizeDigits = value => String(value || '').replace(/\D/g, '');

const testNumberForSlot = (slot) => {
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > TEST_POOL_SIZE) {
        throw new RangeError(`WhatsApp test-number slot must be between 1 and ${TEST_POOL_SIZE}`);
    }
    return `${TEST_NUMBER_PREFIX}${TEST_NUMBER_FIRST_SUFFIX + slot - 1}`;
};

const testPoolNumbers = () => Array.from(
    { length: TEST_POOL_SIZE },
    (_, index) => testNumberForSlot(index + 1)
);

const isReservedTestPoolNumber = (value) => testPoolNumbers().includes(normalizeDigits(value));

const provisionTestNumberPool = async (provisionedBy = null) => {
    const now = new Date();
    const operations = testPoolNumbers().map((number, index) => ({
        updateOne: {
            filter: { number },
            update: {
                $set: {
                    slot: index + 1,
                    label: `Rozare Test ${String(index + 1).padStart(2, '0')}`,
                    isActive: true,
                    ...(provisionedBy ? { provisionedBy } : {}),
                },
                $setOnInsert: { createdAt: now },
            },
            upsert: true,
        },
    }));

    await WhatsAppTestNumber.bulkWrite(operations, { ordered: false });
    return WhatsAppTestNumber.find({ number: { $in: testPoolNumbers() } })
        .sort({ slot: 1 })
        .lean();
};

const findActiveTestNumber = async (value) => {
    const number = normalizeDigits(value);
    if (!isReservedTestPoolNumber(number)) return null;
    return WhatsAppTestNumber.findOne({ number, isActive: true }).lean();
};

const isActiveTestNumber = async value => Boolean(await findActiveTestNumber(value));

const captureOutboundIfTestNumber = async ({
    number,
    instanceName = '',
    instanceType = '',
    messageType,
    text = '',
    payload = null,
}) => {
    const digits = normalizeDigits(number);
    const testNumber = await findActiveTestNumber(digits);
    if (!testNumber) return null;

    const messageId = `rozare-test-${crypto.randomUUID()}`;
    const message = await WhatsAppTestMessage.create({
        number: digits,
        direction: 'outbound',
        instanceName,
        instanceType,
        messageType,
        text: String(text || '').slice(0, 12000),
        payload,
        messageId,
        processingStatus: 'captured',
    });
    await WhatsAppTestNumber.updateOne(
        { _id: testNumber._id },
        { $set: { lastUsedAt: new Date() } }
    );

    return {
        messageId,
        raw: {
            virtualTestTransport: true,
            capturedMessageId: message._id.toString(),
            number: digits,
        },
        virtualTestTransport: true,
    };
};

module.exports = {
    TEST_POOL_SIZE,
    captureOutboundIfTestNumber,
    findActiveTestNumber,
    isActiveTestNumber,
    isReservedTestPoolNumber,
    normalizeDigits,
    provisionTestNumberPool,
    testNumberForSlot,
    testPoolNumbers,
};
