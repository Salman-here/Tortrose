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

module.exports = { friendlyBuyerOrderCopy };
