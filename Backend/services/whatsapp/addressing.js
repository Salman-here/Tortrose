'use strict';

const uniqueNonEmpty = (items = []) => [...new Set(items.filter(Boolean))];

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

// WhatsApp LID mode can send inbound messages with key.remoteJid as the
// replyable @lid chat and key.remoteJidAlt as the user's real phone JID.
const resolveInboundAddress = (msg) => {
    const remoteJid = msg?.key?.remoteJid || msg?.remoteJid || '';
    const altJid =
        msg?.key?.remoteJidAlt ||
        msg?.remoteJidAlt ||
        msg?.key?.participantAlt ||
        msg?.participantAlt ||
        '';
    const remotePhone = phoneFromJid(remoteJid);
    const altPhone = phoneFromJid(altJid);

    return {
        remoteJid,
        altJid,
        identityPhone: altPhone || remotePhone,
        replyTo: remoteJid || altJid || altPhone || remotePhone,
        candidatePhones: uniqueNonEmpty([altPhone, remotePhone]),
    };
};

module.exports = {
    phoneFromJid,
    isGroupOrBroadcastJid,
    resolveInboundAddress,
    uniqueNonEmpty,
};
