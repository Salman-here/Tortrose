'use strict';
const ChatHistory = require('../models/ChatHistory');
const imageMarker = /\n?\[Attached product image: (https?:\/\/[^\]\s]+)\]/gi;
const messageText = message => typeof message?.content === 'string' ? message.content : '';
const baseText = message => messageText(message).replace(imageMarker, '').trim();
function imageAttachments(message) {
  const attachments = [
    ...(Array.isArray(message?.attachments) ? message.attachments.filter(attachment => attachment && (!attachment.type || attachment.type === 'image' || (typeof attachment.type === 'string' && attachment.type.startsWith('image/')))) : []),
    ...[...messageText(message).matchAll(imageMarker)].map(match => ({ type: 'image', url: match[1] })),
  ].filter(attachment => typeof attachment?.url === 'string' && /^https?:\/\//i.test(attachment.url));
  return [...new Map(attachments.map(attachment => [attachment.url, { type: 'image', url: attachment.url, name: attachment.name || 'Product image' }])).values()];
}

async function restoreAttachmentHistory(messages, userId, conversationId) {
  if (!userId || typeof conversationId !== 'string' || !/^[a-f\d]{24}$/i.test(conversationId)) return messages;
  const history = await ChatHistory.findOne({
    user: userId,
    conversations: { $elemMatch: { _id: conversationId, source: { $ne: 'whatsapp' } } },
  }).select({ 'conversations.$': 1 }).lean();
  const saved = history?.conversations?.[0]?.messages || [];
  return messages.map(message => {
    if (message.role !== 'user' || imageAttachments(message).length) return message;
    const matches = saved.filter(old => old.role === 'user' && baseText(old) === baseText(message) && imageAttachments(old).length);
    const possibilities = new Map(matches.map(old => [JSON.stringify(imageAttachments(old).map(image => image.url)), old]));
    // An ambiguous repeated caption is not enough evidence to select a photo.
    if (possibilities.size !== 1) return message;
    const attachments = imageAttachments([...possibilities.values()][0]);
    return { ...message, attachments, content: [messageText(message), ...attachments.map(image => `[Attached product image: ${image.url}]`)].join('\n\n') };
  });
}

function bindNamedProductImage(args, messages = []) {
  const product = args.product && typeof args.product === 'object' ? args.product : args;
  if (product.image || product.imageUrl || product.images?.length) return args;
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const name = normalize(product.name);
  if (!name) return args;
  const matches = messages.filter(message => message.role === 'user' && normalize(baseText(message)).includes(name) && imageAttachments(message).length);
  if (matches.length !== 1) return args;
  const images = imageAttachments(matches[0]);
  const next = { ...product, image: images[0].url, images: images.map(image => image.url) };
  return args.product ? { ...args, product: next } : next;
}

module.exports = { restoreAttachmentHistory, bindNamedProductImage, imageAttachments };
