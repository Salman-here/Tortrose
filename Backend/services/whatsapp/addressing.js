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
const JID_PATTERN = /\b\d{5,}@(lid|s\.whatsapp\.net)\b/g;
const ADDRESS_PATH_PATTERN = /(jid|phone|number|sender|remote|participant|author|from|user|owner)/i;

const memoryKey = (phone, scope = 'global') => {
    const digits = phoneFromJid(phone);
    return digits ? `${scope || 'global'}:${digits}` : '';
};

const rememberPhoneLid = (phone, lidJid, scope = 'global') => {
    const key = memoryKey(phone, scope);
    if (!key || !isLidJid(lidJid)) return;
    recentLidByPhone.set(key, { lidJid, seenAt: Date.now() });
};

const getRememberedLid = (phone, scope = 'global') => {
    const key = memoryKey(phone, scope);
    if (!key) return '';
    const mapped = recentLidByPhone.get(key);
    if (!mapped) return '';
    if (Date.now() - mapped.seenAt > LID_MAPPING_TTL_MS) {
        recentLidByPhone.delete(key);
        return '';
    }
    return mapped.lidJid;
};

const resolveReplyTo = (phone, requestedRecipient, scope = 'global') => {
    if (isLidJid(requestedRecipient)) return requestedRecipient;
    return getRememberedLid(phone, scope) || getRememberedLid(phone) || requestedRecipient || phone;
};

const collectAddressHints = (value, path = '', out = { lidJids: [], phoneJids: [], phoneNumbers: [] }, seen = new WeakSet(), depth = 0) => {
    if (value == null || depth > 8) return out;

    if (typeof value === 'string') {
        const matches = value.match(JID_PATTERN) || [];
        for (const jid of matches) {
            if (isLidJid(jid)) out.lidJids.push(jid);
            if (isPhoneJid(jid)) out.phoneJids.push(jid);
        }

        if (ADDRESS_PATH_PATTERN.test(path) && !value.includes('@lid')) {
            const digits = value.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15) out.phoneNumbers.push(digits);
        }
        return out;
    }

    if (typeof value !== 'object') return out;
    if (seen.has(value)) return out;
    seen.add(value);

    if (Array.isArray(value)) {
        value.forEach((item, index) => collectAddressHints(item, `${path}[${index}]`, out, seen, depth + 1));
        return out;
    }

    for (const [key, child] of Object.entries(value)) {
        collectAddressHints(child, path ? `${path}.${key}` : key, out, seen, depth + 1);
    }
    return out;
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
    const deepHints = collectAddressHints(msg);
    const jidCandidates = uniqueNonEmpty([
        remoteJid,
        altJid,
        participantJid,
        participantAltJid,
        ...deepHints.lidJids,
        ...deepHints.phoneJids,
    ]);
    const lidJid = jidCandidates.find(isLidJid) || '';
    const phoneJid = jidCandidates.find(isPhoneJid) || '';
    const remotePhone = phoneFromJid(remoteJid);
    const altPhone = phoneFromJid(altJid);
    const participantPhone = phoneFromJid(participantJid);
    const participantAltPhone = phoneFromJid(participantAltJid);
    const phoneJidDigits = phoneFromJid(phoneJid);

    const barePhone = deepHints.phoneNumbers.find(number => number !== remotePhone && number !== altPhone && number !== participantPhone && number !== participantAltPhone) || '';
    const identityPhone = phoneJidDigits || barePhone || altPhone || remotePhone || participantAltPhone || participantPhone;
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
        candidatePhones: uniqueNonEmpty([phoneJidDigits, barePhone, altPhone, remotePhone, participantAltPhone, participantPhone, ...deepHints.phoneNumbers]),
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
    collectAddressHints,
    resolveInboundAddress,
    uniqueNonEmpty,
};
