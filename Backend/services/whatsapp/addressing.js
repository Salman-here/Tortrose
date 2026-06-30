'use strict';

const uniqueNonEmpty = (items = []) => [...new Set(items.filter(Boolean))];
const recentLidByPhone = new Map();
const LID_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;

const phoneFromJid = (jid) => {
    if (!jid || typeof jid !== 'string') return '';
    const at = jid.indexOf('@');
    const raw = at > 0 ? jid.slice(0, at) : jid;
    return raw.replace(/[^\d]/g, '');
};

const isGroupOrBroadcastJid = (jid = '') => (
    jid.endsWith('@g.us') ||
    jid.includes('@broadcast') ||
    jid === 'status@broadcast'
);

const isLidJid = (jid = '') => jid.endsWith('@lid');
const isPhoneJid = (jid = '') => jid.endsWith('@s.whatsapp.net');

const rememberPhoneLid = (phone, lidJid) => {
    const digits = phoneFromJid(phone);
    if (!digits || !isLidJid(lidJid)) return;
    recentLidByPhone.set(digits, { lidJid, seenAt: Date.now() });
};

const getRememberedLid = (phone) => {
    const digits = phoneFromJid(phone);
    if (!digits) return '';
    const mapped = recentLidByPhone.get(digits);
    if (!mapped) return '';
    if (Date.now() - mapped.seenAt > LID_MAPPING_TTL_MS) {
        recentLidByPhone.delete(digits);
        return '';
    }
    return mapped.lidJid;
};

const resolveReplyTo = (phone, requestedRecipient) => {
    if (isLidJid(requestedRecipient)) return requestedRecipient;
    return getRememberedLid(phone) || requestedRecipient || phone;
};

// WhatsApp LID mode can send inbound messages with key.remoteJid as the
// replyable @lid chat and key.remoteJidAlt as the user's real phone JID.
// Some Evolution webhook payloads reverse those two fields. When both are
// present, always identify the user by the phone JID and reply to the LID JID.
const resolveInboundAddress = (msg) => {
    const remoteJid = msg?.key?.remoteJid || msg?.remoteJid || '';
    const altJid =
        msg?.key?.remoteJidAlt ||
        msg?.remoteJidAlt ||
        msg?.key?.participantAlt ||
        msg?.participantAlt ||
        '';
    const participantJid = msg?.key?.participant || msg?.participant || '';
    const participantAltJid = msg?.key?.participantAlt || msg?.participantAlt || '';
    const jidCandidates = [remoteJid, altJid, participantJid, participantAltJid].filter(Boolean);
    const lidJid = jidCandidates.find(isLidJid) || '';
    const phoneJid = jidCandidates.find(isPhoneJid) || '';
    const remotePhone = phoneFromJid(remoteJid);
    const altPhone = phoneFromJid(altJid);
    const participantPhone = phoneFromJid(participantJid);
    const participantAltPhone = phoneFromJid(participantAltJid);
    const phoneJidDigits = phoneFromJid(phoneJid);

    const identityPhone = phoneJidDigits || altPhone || remotePhone || participantAltPhone || participantPhone;
    rememberPhoneLid(identityPhone, lidJid);

    return {
        remoteJid,
        altJid,
        participantJid,
        participantAltJid,
        lidJid,
        phoneJid,
        identityPhone,
        replyTo: lidJid || remoteJid || altJid || participantJid || participantAltJid || phoneJidDigits || altPhone || remotePhone,
        candidatePhones: uniqueNonEmpty([phoneJidDigits, altPhone, remotePhone, participantAltPhone, participantPhone]),
    };
};

module.exports = {
    phoneFromJid,
    isGroupOrBroadcastJid,
    isLidJid,
    isPhoneJid,
    rememberPhoneLid,
    getRememberedLid,
    resolveReplyTo,
    resolveInboundAddress,
    uniqueNonEmpty,
};
