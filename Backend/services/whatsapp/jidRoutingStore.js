'use strict';

const mongoose = require('mongoose');
const WhatsAppJidMapping = require('../../models/WhatsAppJidMapping');
const {
    ROUTE_SOURCE, LID_MAPPING_TTL_MS, canonicalPhone, canonicalJid,
    isLidJid, isPhoneJid, toPhoneJid, rememberPhoneLid, getRememberedLid,
} = require('./addressing');

const isMongoReady = () => mongoose.connection.readyState === 1;
const physicalInstance = (type, name) => name || (type === 'seller'
    ? process.env.EVOLUTION_SELLER_INSTANCE_NAME || 'rozare-seller'
    : process.env.EVOLUTION_INSTANCE_NAME || 'rozare-main');
const scopeKey = (type, name) => type + ':' + physicalInstance(type, name);

const rememberInboundRoute = async (address, { instanceType, instanceName = '' } = {}) => {
    const phone = canonicalPhone(address?.identityPhone), lidJid = canonicalJid(address?.lidJid);
    if (!phone || !isLidJid(lidJid) || !['main', 'seller'].includes(instanceType)
        || address?.verifiedPeerLid !== true || address?.routingSource !== ROUTE_SOURCE
        || address?.excludedOwnerLids?.includes(lidJid)) return null;
    const name = physicalInstance(instanceType, instanceName);
    rememberPhoneLid(phone, lidJid, scopeKey(instanceType, name), { verified: true });
    if (!isMongoReady()) return null;
    try {
        return await WhatsAppJidMapping.findOneAndUpdate(
            { phone, instanceType },
            { $set: { lidJid, instanceName: name, source: ROUTE_SOURCE, lastSeenAt: new Date() } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        console.warn('[whatsapp:jids] verified route persistence failed:', error.message);
        return null;
    }
};

const resolveOutboundRecipient = async (phone, requested, { instanceType, instanceName = '' } = {}) => {
    const digits = canonicalPhone(phone), fallback = toPhoneJid(digits);
    if (!digits) return '';
    if (isPhoneJid(requested)) {
        if (canonicalPhone(requested) !== digits) console.warn('[whatsapp:jids] rejected mismatched phone recipient');
        return fallback;
    }
    if (!['main', 'seller'].includes(instanceType)) return fallback;
    const name = physicalInstance(instanceType, instanceName), scope = scopeKey(instanceType, name);
    let trusted = getRememberedLid(digits, scope);
    if (!trusted && isMongoReady()) {
        try {
            const route = await WhatsAppJidMapping.findOne({
                phone: digits, instanceType, instanceName: name, source: ROUTE_SOURCE,
                lastSeenAt: { $gte: new Date(Date.now() - LID_MAPPING_TTL_MS) },
            }).sort({ lastSeenAt: -1 }).lean();
            if (route && canonicalPhone(route.phone) === digits && route.source === ROUTE_SOURCE
                && route.instanceName === name && isLidJid(route.lidJid)
                && new Date(route.lastSeenAt).getTime() >= Date.now() - LID_MAPPING_TTL_MS) {
                trusted = canonicalJid(route.lidJid);
                rememberPhoneLid(digits, trusted, scope, { verified: true });
            }
        } catch (error) {
            console.warn('[whatsapp:jids] verified route lookup failed:', error.message);
        }
    }
    // An explicit LID is not authorization to redirect this phone. It must
    // match a fresh, verified association in this exact physical instance.
    if (isLidJid(requested)) return trusted === canonicalJid(requested) ? trusted : fallback;
    return trusted || fallback;
};

module.exports = { rememberInboundRoute, resolveOutboundRecipient };
