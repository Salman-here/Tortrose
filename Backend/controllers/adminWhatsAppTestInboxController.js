'use strict';

const crypto = require('crypto');
const User = require('../models/User');
const WhatsAppTestMessage = require('../models/WhatsAppTestMessage');
const WhatsAppTestNumber = require('../models/WhatsAppTestNumber');
const { handleEvolutionWebhook } = require('../services/whatsapp/webhookHandler');
const {
    isActiveTestNumber,
    normalizeDigits,
    provisionTestNumberPool,
    testPoolNumbers,
} = require('../services/whatsapp/testNumberPoolService');

const MAX_PAGE_SIZE = 100;

const actionChoices = (message = {}) => {
    if (message.messageType === 'buttons') {
        return (message.payload?.buttons || [])
            .map(button => ({
                id: String(button?.id || '').trim(),
                label: String(button?.displayText || button?.id || '').trim(),
            }))
            .filter(action => action.id);
    }
    if (message.messageType === 'list') {
        return (message.payload?.sections || []).flatMap(section => (
            (section?.rows || []).map(row => ({
                id: String(row?.id || row?.rowId || '').trim(),
                label: String(row?.title || row?.displayText || row?.id || row?.rowId || '').trim(),
            }))
        )).filter(action => action.id);
    }
    return [];
};

const otpFromMessage = (message = {}) => {
    const match = String(message.text || '').match(/(?:code\s+is:?\s*\*?|code:?\s*\*?)(\d{6})/i);
    return match?.[1] || '';
};

const serializeMessage = message => ({
    _id: message._id,
    number: message.number,
    direction: message.direction,
    instanceName: message.instanceName,
    instanceType: message.instanceType,
    messageType: message.messageType,
    text: message.text,
    payload: message.payload,
    messageId: message.messageId,
    sourceMessage: message.sourceMessage,
    actionId: message.actionId,
    actionLabel: message.actionLabel,
    processingStatus: message.processingStatus,
    processingError: message.processingError,
    processedAt: message.processedAt,
    createdAt: message.createdAt,
    otp: message.direction === 'outbound' ? otpFromMessage(message) : '',
    actions: message.direction === 'outbound' ? actionChoices(message) : [],
});

const loadAssignments = async (numbers) => {
    if (!numbers.length) return new Map();
    const e164Numbers = numbers.map(number => `+${number}`);
    const users = await User.find({
        $or: [
            { 'sellerInfo.whatsappDigits': { $in: numbers } },
            { 'sellerInfo.whatsappNumber': { $in: e164Numbers } },
            { 'whatsappInfo.number': { $in: e164Numbers } },
        ],
    }).select('username email role sellerInfo.whatsappNumber sellerInfo.whatsappDigits sellerInfo.whatsappVerified whatsappInfo')
        .lean();

    const assignments = new Map();
    for (const user of users) {
        const candidates = [
            user?.sellerInfo?.whatsappDigits,
            user?.sellerInfo?.whatsappNumber,
            user?.whatsappInfo?.number,
        ].map(normalizeDigits).filter(Boolean);
        for (const number of candidates) {
            if (!numbers.includes(number)) continue;
            if (!assignments.has(number)) assignments.set(number, []);
            assignments.get(number).push({
                userId: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                sellerVerified: Boolean(user?.sellerInfo?.whatsappVerified),
                buyerVerified: Boolean(user?.whatsappInfo?.verified),
            });
        }
    }
    return assignments;
};

exports.provisionPool = async (req, res) => {
    try {
        const records = await provisionTestNumberPool(req.user?._id || req.user?.id || null);
        return res.status(200).json({
            success: true,
            count: records.length,
            msg: `${records.length} reserved WhatsApp test numbers are active.`,
        });
    } catch (error) {
        console.error('[whatsapp-test-inbox] provisionPool:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to provision the WhatsApp test pool.' });
    }
};

exports.getNumbers = async (_req, res) => {
    try {
        const numbers = await WhatsAppTestNumber.find({ number: { $in: testPoolNumbers() } })
            .sort({ slot: 1 })
            .lean();
        const assignments = await loadAssignments(numbers.map(record => record.number));
        return res.status(200).json({
            success: true,
            count: numbers.length,
            targetCount: testPoolNumbers().length,
            data: numbers.map(record => ({
                _id: record._id,
                number: record.number,
                e164: `+${record.number}`,
                slot: record.slot,
                label: record.label,
                isActive: record.isActive,
                lastUsedAt: record.lastUsedAt,
                createdAt: record.createdAt,
                assignments: assignments.get(record.number) || [],
            })),
        });
    } catch (error) {
        console.error('[whatsapp-test-inbox] getNumbers:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to load the WhatsApp test pool.' });
    }
};

exports.setNumberActive = async (req, res) => {
    try {
        if (typeof req.body?.isActive !== 'boolean') {
            return res.status(400).json({ success: false, msg: 'isActive (boolean) is required.' });
        }
        const record = await WhatsAppTestNumber.findById(req.params.id);
        if (!record || !testPoolNumbers().includes(record.number)) {
            return res.status(404).json({ success: false, msg: 'WhatsApp test number not found.' });
        }
        record.isActive = req.body.isActive;
        await record.save();
        return res.status(200).json({
            success: true,
            data: { _id: record._id, number: record.number, isActive: record.isActive },
        });
    } catch (error) {
        console.error('[whatsapp-test-inbox] setNumberActive:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to update the WhatsApp test number.' });
    }
};

exports.getMessages = async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
        const filter = {};
        if (req.query.number) {
            const number = normalizeDigits(req.query.number);
            if (!testPoolNumbers().includes(number)) {
                return res.status(400).json({ success: false, msg: 'Invalid WhatsApp test number filter.' });
            }
            filter.number = number;
        }
        if (['outbound', 'inbound'].includes(req.query.direction)) filter.direction = req.query.direction;
        if (['text', 'media', 'poll', 'list', 'buttons'].includes(req.query.messageType)) {
            filter.messageType = req.query.messageType;
        }

        const [messages, total] = await Promise.all([
            WhatsAppTestMessage.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            WhatsAppTestMessage.countDocuments(filter),
        ]);
        return res.status(200).json({
            success: true,
            data: messages.map(serializeMessage),
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (error) {
        console.error('[whatsapp-test-inbox] getMessages:', error.message);
        return res.status(500).json({ success: false, msg: 'Failed to load WhatsApp test messages.' });
    }
};

const dispatchSyntheticButton = async ({ number, instanceName, actionId, actionLabel }) => {
    let statusCode = 200;
    let responseBody = null;
    const response = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(body) {
            responseBody = body;
            return body;
        },
    };
    const request = {
        whatsappWebhookAuthenticated: true,
        headers: {},
        body: {
            event: 'MESSAGES_UPSERT',
            instance: instanceName || process.env.EVOLUTION_SELLER_INSTANCE_NAME || 'rozare-seller',
            data: {
                key: {
                    id: `rozare-test-inbound-${crypto.randomUUID()}`,
                    remoteJid: `${number}@s.whatsapp.net`,
                    fromMe: false,
                },
                messageTimestamp: Math.floor(Date.now() / 1000),
                message: {
                    buttonsResponseMessage: {
                        selectedButtonId: actionId,
                        selectedDisplayText: actionLabel,
                    },
                },
            },
        },
    };

    await handleEvolutionWebhook(request, response);
    return { statusCode, responseBody, inboundMessageId: request.body.data.key.id };
};

exports.applyMessageAction = async (req, res) => {
    const adminId = req.user?._id || req.user?.id || null;
    let message = null;
    try {
        message = await WhatsAppTestMessage.findOneAndUpdate(
            {
                _id: req.params.id,
                direction: 'outbound',
                processingStatus: { $in: ['captured', 'processed'] },
            },
            { $set: { processingStatus: 'processing', processingError: '' } },
            { new: true }
        );
        if (!message) {
            return res.status(404).json({ success: false, msg: 'Actionable WhatsApp test message not found or already processing.' });
        }
        if (!await isActiveTestNumber(message.number)) {
            throw Object.assign(new Error('This WhatsApp test number is inactive.'), { statusCode: 409 });
        }

        const requestedActionId = String(req.body?.actionId || '').trim();
        const selected = actionChoices(message.toObject()).find(action => action.id === requestedActionId);
        if (!selected) {
            throw Object.assign(new Error('The requested button does not belong to this captured message.'), { statusCode: 400 });
        }

        const dispatch = await dispatchSyntheticButton({
            number: message.number,
            instanceName: message.instanceName,
            actionId: selected.id,
            actionLabel: selected.label,
        });
        if (dispatch.statusCode >= 400 || dispatch.responseBody?.ok === false) {
            throw Object.assign(new Error('The WhatsApp decision path rejected the simulated button response.'), {
                statusCode: 409,
            });
        }

        const now = new Date();
        const inbound = await WhatsAppTestMessage.create({
            number: message.number,
            direction: 'inbound',
            instanceName: message.instanceName,
            instanceType: message.instanceType,
            messageType: 'buttons',
            text: selected.label,
            payload: { selectedButtonId: selected.id, selectedDisplayText: selected.label },
            messageId: dispatch.inboundMessageId,
            sourceMessage: message._id,
            actionId: selected.id,
            actionLabel: selected.label,
            processingStatus: 'processed',
            processedAt: now,
            createdBy: adminId,
        });
        message.processingStatus = 'processed';
        message.processedAt = now;
        message.processingError = '';
        await message.save();

        return res.status(200).json({
            success: true,
            msg: `WhatsApp test action “${selected.label}” was submitted through the live decision path.`,
            data: serializeMessage(inbound.toObject()),
            webhook: dispatch.responseBody,
        });
    } catch (error) {
        if (message) {
            message.processingStatus = 'failed';
            message.processingError = String(error.message || 'Unknown processing error').slice(0, 1200);
            await message.save().catch(() => null);
        }
        console.error('[whatsapp-test-inbox] applyMessageAction:', error.message);
        return res.status(error.statusCode || 500).json({
            success: false,
            msg: error.message || 'Failed to process the WhatsApp test action.',
        });
    }
};
