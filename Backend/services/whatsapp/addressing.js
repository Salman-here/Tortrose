'use strict';

const ROUTE_SOURCE = 'sender-envelope-v2';
const LID_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const recentLidByPhone = new Map();
const uniqueNonEmpty = (items = []) => [...new Set(items.filter(Boolean))];
const isLidJid = value => typeof value === 'string' && /^\d+(?::\d+)?@lid$/i.test(value.trim());
const isPhoneJid = value => typeof value === 'string' && /^\d+(?::\d+)?@s\.whatsapp\.net$/i.test(value.trim());
const canonicalJid = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/:\d+(?=@)/, '') : '';
const phoneFromJid = value => typeof value === 'string' ? value.split('@')[0].split(':')[0].replace(/\D/g, '') : '';
const canonicalPhone = value => {
    if (typeof value !== 'string' || isLidJid(value)) return '';
    if (value.includes('@') && !isPhoneJid(value)) return '';
    if (!value.includes('@') && !/^\+?[\d()\s-]+$/.test(value)) return '';
    const digits = phoneFromJid(value);
    return digits.length >= 8 && digits.length <= 15 ? digits : '';
};
const toPhoneJid = value => {
    const phone = canonicalPhone(value);
    return phone ? phone + '@s.whatsapp.net' : '';
};
const isGroupOrBroadcastJid = value => typeof value === 'string' && (
    value.toLowerCase().endsWith('@g.us') || value.toLowerCase().includes('@broadcast')
);
const memoryKey = (phone, scope) => canonicalPhone(phone) ? (scope || 'global') + ':' + canonicalPhone(phone) : '';
const rememberPhoneLid = (phone, lid, scope = 'global', { verified = false } = {}) => {
    const key = memoryKey(phone, scope);
    if (!verified || !key || !isLidJid(lid)) return false;
    recentLidByPhone.set(key, { lidJid: canonicalJid(lid), seenAt: Date.now(), source: ROUTE_SOURCE });
    return true;
};
const getRememberedLid = (phone, scope = 'global') => {
    const key = memoryKey(phone, scope), value = recentLidByPhone.get(key);
    if (!value) return '';
    if (value.source !== ROUTE_SOURCE || Date.now() - value.seenAt > LID_MAPPING_TTL_MS) {
        recentLidByPhone.delete(key);
        return '';
    }
    return value.lidJid;
};
const resolveReplyTo = (phone, requested, scope = 'global') => {
    const pn = toPhoneJid(phone), cached = getRememberedLid(phone, scope);
    if (isPhoneJid(requested) && canonicalPhone(requested) === canonicalPhone(phone)) return pn;
    if (isLidJid(requested)) return cached === canonicalJid(requested) ? cached : pn;
    return cached || pn;
};

const ownerValues = (message, context) => [
    context?.ownerPhone, context?.ownerLid,
    message?.owner, message?.ownerJid, message?.ownerPn, message?.ownerPhone, message?.ownerNumber,
    message?.wuid, message?.selfJid, message?.selfPhone,
    message?.instance?.ownerJid, message?.instance?.owner, message?.instance?.wuid,
    message?.me?.id, message?.me?.lid,
].flatMap(value => value && typeof value === 'object'
    ? [value.id, value.jid, value.phone, value.lid] : [value]);

// These are protocol-level sender fields. Message text, quoted-message authors,
// contextInfo, mentions, contacts, forwarded content and arbitrary nested fields
// NEVER establish either an account identity or a reply destination.
const collectAddressHints = (message = {}, context = {}) => {
    const key = message?.key && typeof message.key === 'object' ? message.key : {};
    const peers = [key.remoteJid || message.remoteJid, key.remoteJidAlt || message.remoteJidAlt,
        key.senderLid, key.senderLID, message.senderLid, message.senderLID];
    const senderPhones = [key.senderPn, key.senderPN, message.senderPn, message.senderPN,
        key.senderPhone, message.senderPhone];
    if (peers.some(isLidJid)) senderPhones.push(key.participantPn, key.participantPN,
        message.participantPn, message.participantPN, key.participantPhone, message.participantPhone);
    const owners = ownerValues(message, context);
    return {
        lidJids: uniqueNonEmpty(peers.filter(isLidJid).map(canonicalJid)),
        phoneJids: uniqueNonEmpty([...peers, ...senderPhones].filter(isPhoneJid).map(canonicalJid)),
        phoneNumbers: uniqueNonEmpty([...peers, ...senderPhones].map(canonicalPhone)),
        excludedOwnerPhones: uniqueNonEmpty(owners.map(canonicalPhone)),
        excludedOwnerLids: uniqueNonEmpty(owners.filter(isLidJid).map(canonicalJid)),
    };
};

const resolveInboundAddress = (message = {}, context = {}) => {
    const key = message?.key && typeof message.key === 'object' ? message.key : {};
    const remoteJid = canonicalJid(key.remoteJid || message.remoteJid || '');
    const altJid = canonicalJid(key.remoteJidAlt || message.remoteJidAlt || '');
    const hints = collectAddressHints(message, context);
    const phones = hints.phoneNumbers.filter(phone => !hints.excludedOwnerPhones.includes(phone));
    const peerLids = hints.lidJids.filter(lid => !hints.excludedOwnerLids.includes(lid));
    const fromMe = key.fromMe ?? message.fromMe;
    const ownMessage = fromMe === true || fromMe === 1 || fromMe === '1' || fromMe === 'true';
    const privateChat = !isGroupOrBroadcastJid(remoteJid) && !isGroupOrBroadcastJid(altJid);
    const identityPhone = !ownMessage && privateChat && phones.length === 1 ? phones[0] : '';
    const lidJid = peerLids.length === 1 ? peerLids[0] : '';
    const explicitlyInbound = fromMe === false || fromMe === 0 || fromMe === '0' || fromMe === 'false';
    const verifiedPeerLid = Boolean(identityPhone && lidJid && explicitlyInbound && privateChat);
    return {
        remoteJid, altJid, participantJid: canonicalJid(key.participant || ''),
        participantAltJid: canonicalJid(key.participantAlt || ''),
        lidJid, phoneJid: toPhoneJid(identityPhone), identityPhone,
        replyTo: identityPhone ? (verifiedPeerLid ? lidJid : toPhoneJid(identityPhone)) : '',
        candidatePhones: identityPhone ? [identityPhone] : [],
        excludedOwnerPhones: hints.excludedOwnerPhones, excludedOwnerLids: hints.excludedOwnerLids,
        verifiedPeerLid, routingSource: verifiedPeerLid ? ROUTE_SOURCE : '',
        routingIssue: ownMessage ? 'own_message' : phones.length > 1 ? 'ambiguous_sender'
            : !identityPhone ? 'no_verified_sender' : peerLids.length > 1 ? 'ambiguous_peer_lids' : '',
    };
};

module.exports = {
    ROUTE_SOURCE, LID_MAPPING_TTL_MS, uniqueNonEmpty, phoneFromJid, canonicalPhone, canonicalJid,
    isGroupOrBroadcastJid, isLidJid, isPhoneJid, toPhoneJid,
    rememberPhoneLid, getRememberedLid, resolveReplyTo, collectAddressHints, resolveInboundAddress,
};
