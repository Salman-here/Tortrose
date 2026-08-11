'use strict';

const crypto = require('crypto');
const WhatsAppInboundReceipt = require('../../models/WhatsAppInboundReceipt');

const LEASE_MS = 2 * 60 * 1000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const retryableBusyError = () => {
    const error = new Error('This WhatsApp message is already being processed.');
    error.code = 'WHATSAPP_INBOUND_PROCESSING';
    error.retryable = true;
    return error;
};

async function claimInboundMessage({ instanceName, messageId, phone = '' }) {
    const instance = String(instanceName || '').trim();
    const id = String(messageId || '').trim();
    if (!instance || !id) {
        const error = new Error('A stable WhatsApp instance and message id are required.');
        error.code = 'WHATSAPP_INBOUND_ID_REQUIRED';
        throw error;
    }

    await WhatsAppInboundReceipt.init();
    const now = new Date();
    const processingToken = crypto.randomBytes(24).toString('base64url');
    const base = {
        instanceName: instance,
        messageId: id,
        phone: String(phone || '').replace(/\D/g, ''),
        status: 'processing',
        attempts: 1,
        processingToken,
        processingStartedAt: now,
        expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
    };

    try {
        const receipt = await WhatsAppInboundReceipt.create(base);
        return { claimed: true, duplicate: false, token: processingToken, attempt: receipt.attempts };
    } catch (error) {
        if (error?.code !== 11000) throw error;
    }

    const existing = await WhatsAppInboundReceipt.findOne({
        instanceName: instance,
        messageId: id,
    }).select('+processingToken').lean();
    if (existing?.status === 'completed') {
        return { claimed: false, duplicate: true, completed: true };
    }

    const claimed = await WhatsAppInboundReceipt.findOneAndUpdate(
        {
            instanceName: instance,
            messageId: id,
            $or: [
                { status: 'failed' },
                {
                    status: 'processing',
                    processingStartedAt: { $lte: new Date(now.getTime() - LEASE_MS) },
                },
            ],
        },
        {
            $set: {
                phone: base.phone,
                status: 'processing',
                processingToken,
                processingStartedAt: now,
                lastError: '',
                expiresAt: base.expiresAt,
            },
            $inc: { attempts: 1 },
        },
        { new: true }
    ).select('+processingToken').lean();

    if (!claimed) throw retryableBusyError();
    return {
        claimed: true,
        duplicate: true,
        token: processingToken,
        attempt: claimed.attempts,
    };
}

async function markInboundCompleted({ instanceName, messageId, token }) {
    const result = await WhatsAppInboundReceipt.updateOne(
        {
            instanceName,
            messageId,
            status: 'processing',
            processingToken: token,
        },
        {
            $set: {
                status: 'completed',
                completedAt: new Date(),
                lastError: '',
            },
            $unset: { processingToken: 1 },
        }
    );
    if (result.modifiedCount !== 1) {
        const error = new Error('WhatsApp inbound completion lease was lost.');
        error.code = 'WHATSAPP_INBOUND_LEASE_LOST';
        error.retryable = true;
        throw error;
    }
}

async function markInboundFailed({ instanceName, messageId, token, error }) {
    await WhatsAppInboundReceipt.updateOne(
        {
            instanceName,
            messageId,
            status: 'processing',
            processingToken: token,
        },
        {
            $set: {
                status: 'failed',
                lastError: String(error?.message || error || 'Inbound processing failed').slice(0, 1000),
            },
            $unset: { processingToken: 1 },
        }
    );
}

async function processInboundMessageOnce({ instanceName, messageId, phone, work }) {
    if (typeof work !== 'function') throw new TypeError('Inbound work callback is required.');
    const claim = await claimInboundMessage({ instanceName, messageId, phone });
    if (!claim.claimed) return { processed: false, duplicate: true, completed: true };

    try {
        const value = await work({ attempt: claim.attempt });
        await markInboundCompleted({
            instanceName: String(instanceName).trim(),
            messageId: String(messageId).trim(),
            token: claim.token,
        });
        return { processed: true, duplicate: claim.duplicate, value };
    } catch (error) {
        await markInboundFailed({
            instanceName: String(instanceName).trim(),
            messageId: String(messageId).trim(),
            token: claim.token,
            error,
        }).catch(markError => {
            console.error('[whatsapp:inbound] failed to release receipt:', markError.message);
        });
        throw error;
    }
}

module.exports = {
    claimInboundMessage,
    markInboundCompleted,
    markInboundFailed,
    processInboundMessageOnce,
    __private: {
        LEASE_MS,
        RECEIPT_TTL_MS,
        retryableBusyError,
    },
};
