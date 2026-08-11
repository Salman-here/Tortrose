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
const toPhoneJid = (phone) => {
    const digits = phoneFromJid(phone);
    return digits ? `${digits}@s.whatsapp.net` : '';
};
const JID_PATTERN = /\b\d{5,}@(lid|s\.whatsapp\.net)\b/g;
const ADDRESS_PATH_PATTERN = /(jid|phone|number|sender|remote|participant|author|from|user)/i;
// Evolution/Baileys envelopes may contain both the message author and the
// connected instance owner. The latter is routing metadata, never the person
// who sent the inbound message. Treating owner/wuid/instance fields as generic
// address hints can make the bot reply to its own WhatsApp number.
const OWNER_PATH_PATTERN = /(^|\.)(owner(?:jid|pn|phone|number)?|instance(?:owner)?(?:jid|pn|phone|number)?|wuid|me|self(?:jid|pn|phone|number)?|connected(?:owner)?(?:jid|pn|phone|number)?)(\.|\[|$)/i;

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

const collectAddressHints = (
    value,
    path = '',
    out = { lidJids: [], phoneJids: [], phoneNumbers: [], excludedOwnerPhones: [] },
    seen = new WeakSet(),
    depth = 0
) => {
    if (value == null || depth > 8) return out;

    if (typeof value === 'string') {
        const ownerMetadata = OWNER_PATH_PATTERN.test(path);
        const matches = value.match(JID_PATTERN) || [];
        for (const jid of matches) {
            if (ownerMetadata) {
                const digits = phoneFromJid(jid);
                if (digits) out.excludedOwnerPhones.push(digits);
                continue;
            }
            if (isLidJid(jid)) out.lidJids.push(jid);
            if (isPhoneJid(jid)) out.phoneJids.push(jid);
        }

        if (ownerMetadata) {
            const digits = value.replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 15) out.excludedOwnerPhones.push(digits);
        } else if (ADDRESS_PATH_PATTERN.test(path) && !value.includes('@lid')) {
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
    // Baileys 7 exposes the real phone-number JID in senderPn/participantPn
    // when remoteJid is an opaque @lid address. Prefer these explicit sender
    // fields over recursively discovered metadata.
    const senderPhoneValues = uniqueNonEmpty([
        msg?.key?.senderPn,
        msg?.senderPn,
        msg?.key?.senderPN,
        msg?.senderPN,
        msg?.key?.participantPn,
        msg?.participantPn,
        msg?.key?.participantPN,
        msg?.participantPN,
    ]);
    const senderPhoneJids = senderPhoneValues.filter(isPhoneJid);
    const senderPhoneDigits = uniqueNonEmpty(senderPhoneValues.map(phoneFromJid))
        .filter(number => number.length >= 8 && number.length <= 15);
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
    const excludedOwnerPhones = uniqueNonEmpty(deepHints.excludedOwnerPhones);

    const explicitPhoneJidDigits = uniqueNonEmpty([
        ...senderPhoneDigits,
        isPhoneJid(altJid) ? altPhone : '',
        isPhoneJid(remoteJid) ? remotePhone : '',
        isPhoneJid(participantAltJid) ? participantAltPhone : '',
        isPhoneJid(participantJid) ? participantPhone : '',
        phoneJidDigits,
    ]).filter(number => !excludedOwnerPhones.includes(number));
    const lidDigits = uniqueNonEmpty([
        isLidJid(remoteJid) ? remotePhone : '',
        isLidJid(altJid) ? altPhone : '',
        isLidJid(participantJid) ? participantPhone : '',
        isLidJid(participantAltJid) ? participantAltPhone : '',
    ]);
    const barePhones = uniqueNonEmpty(deepHints.phoneNumbers)
        .filter(number => (
            !explicitPhoneJidDigits.includes(number) &&
            !lidDigits.includes(number) &&
            !excludedOwnerPhones.includes(number)
        ));
    // A LID is an opaque WhatsApp identifier, not a telephone number. Never
    // use its digits for account lookup; fail closed until a PN mapping arrives.
    const identityPhone = explicitPhoneJidDigits[0] || barePhones[0] || '';
    const replyPhoneJid = uniqueNonEmpty([
        ...senderPhoneJids,
        altJid,
        remoteJid,
        participantAltJid,
        participantJid,
        phoneJid,
        ...deepHints.phoneJids,
    ]).find(jid => isPhoneJid(jid) && phoneFromJid(jid) === identityPhone) || '';
    rememberPhoneLid(identityPhone, lidJid);

    return {
        remoteJid,
        altJid,
        participantJid,
        participantAltJid,
        lidJid,
        phoneJid,
        identityPhone,
        replyTo: lidJid || replyPhoneJid || (identityPhone ? toPhoneJid(identityPhone) : ''),
        candidatePhones: uniqueNonEmpty([...explicitPhoneJidDigits, ...barePhones]),
        excludedOwnerPhones,
    };
};

module.exports = {
    phoneFromJid,
    isGroupOrBroadcastJid,
    isLidJid,
    isPhoneJid,
    toPhoneJid,
    rememberPhoneLid,
    getRememberedLid,
    resolveReplyTo,
    collectAddressHints,
    resolveInboundAddress,
    uniqueNonEmpty,
};
