'use strict';
const NotificationOutbox = require('../../models/NotificationOutbox');

// Keep old event snapshots byte-for-byte on replay. Every caller still goes
// through the outbox's normal recipient, financial and content-hash checks.
async function friendlyBuyerOrderCopy(eventKey, channels, session) {
  if (!channels.includes('whatsapp')) return false;
  const existing = await NotificationOutbox.findOne({
    eventKey, channel: 'whatsapp', 'recipient.audienceRole': 'buyer',
  }).select('payload.message').session(session).lean();
  return !existing || existing.payload?.message?.startsWith('Hey ');
}

async function buyerOrderStoreCopy(eventKey, channels, session) {
  const selected = channels.filter(channel => ['email', 'whatsapp'].includes(channel));
  if (!selected.length) return { email: false, whatsapp: false };
  const existing = await NotificationOutbox.find({
    eventKey, channel: { $in: selected }, 'recipient.audienceRole': 'buyer',
  }).select('channel payload.message payload.text').session(session).lean();
  const enabled = channel => {
    if (!selected.includes(channel)) return false;
    const record = existing.find(row => row.channel === channel);
    if (!record) return true;
    // A previous version may have a friendly greeting but no store header.
    // Retain that exact presentation; normal outbox hashes still validate it.
    return /^(?:Store|Stores): .+/m.test(record.payload?.[channel === 'email' ? 'text' : 'message'] || '');
  };
  return { email: enabled('email'), whatsapp: enabled('whatsapp') };
}

async function buyerOrderKeptPhrase(eventKey, channels, phrase, session) {
  const existing = await NotificationOutbox.find({
    eventKey, channel: { $in: channels }, 'recipient.audienceRole': 'buyer',
  }).select('channel payload.body payload.text payload.html payload.message').session(session).lean();
  return Object.fromEntries(channels.map(channel => {
    const payload = existing.find(row => row.channel === channel)?.payload;
    return [channel, Boolean(payload && String(payload.body || payload.text || payload.message || payload.html || '').includes(phrase))];
  }));
}

module.exports = { friendlyBuyerOrderCopy, buyerOrderStoreCopy, buyerOrderKeptPhrase };
