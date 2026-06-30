'use strict';

const mongoose = require('mongoose');
const WhatsAppJidMapping = require('../../models/WhatsAppJidMapping');
const {
    phoneFromJid,
    isLidJid,
    rememberPhoneLid,
    getRememberedLid,
} = require('./addressing');

const normalizePhone = (phone) => phoneFromJid(phone);
const isMongoReady = () => mongoose.connection.readyState === 1;

const rememberInboundRoute = async (address, { instanceType, instanceName = '', source = 'webhook' } = {}) => {
    const phone = normalizePhone(address?.identityPhone);
    const lidJid = address?.lidJid || (isLidJid(address?.replyTo) ? address.replyTo : '');
    if (!phone || !isLidJid(lidJid) || !instanceType) return null;

    rememberPhoneLid(phone, lidJid, instanceType);
    if (!isMongoReady()) return null;

    try {
        return await WhatsAppJidMapping.findOneAndUpdate(
            { phone, instanceType },
            {
                $set: {
                    lidJid,
                    instanceName,
                    source,
                    lastSeenAt: new Date(),
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (err) {
        console.warn('[whatsapp:jids] failed to persist route:', err.message);
        return null;
    }
};

const resolveOutboundRecipient = async (phone, requestedRecipient, { instanceType } = {}) => {
    if (isLidJid(requestedRecipient)) return requestedRecipient;

    const digits = normalizePhone(phone);
    if (!digits) return requestedRecipient || phone;

    const remembered = getRememberedLid(digits, instanceType) || getRememberedLid(digits);
    if (remembered) return remembered;

    if (!instanceType || !isMongoReady()) return requestedRecipient || phone;

    try {
        const route = await WhatsAppJidMapping.findOne({ phone: digits, instanceType })
            .sort({ lastSeenAt: -1 })
            .lean();
        if (route?.lidJid && isLidJid(route.lidJid)) {
            rememberPhoneLid(digits, route.lidJid);
            return route.lidJid;
        }
    } catch (err) {
        console.warn('[whatsapp:jids] failed to resolve route:', err.message);
    }

    return requestedRecipient || phone;
};

module.exports = {
    rememberInboundRoute,
    resolveOutboundRecipient,
};
