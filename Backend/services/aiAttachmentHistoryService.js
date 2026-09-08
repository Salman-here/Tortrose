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
    // Older web/mobile bundles may omit a new tool's structured follow-up
    // context. Restore only from this authenticated conversation, never from
    // a different person's history. The order service still verifies the
    // signature, owner, expiry and current checkout contract on confirmation.
    if (message.role === 'assistant' && !messageText(message).includes('aip1.')) {
      const visible = value => messageText(value).split(/\n\s*\[Tool memory:/)[0].trim();
      const previews = saved.filter(old => old.role === 'assistant' && visible(old) === visible(message))
        .flatMap(old => (old.toolEvents || []).filter(event => event.tool === 'preview_order' && event.result?.success && event.result?.data?.quoteToken).map(event => event.result.data));
      const unique = new Map(previews.map(data => [data.quoteToken, data]));
      if (unique.size === 1) {
        const data = [...unique.values()][0];
        return { ...message, content: `${messageText(message)}\n\n[Tool memory: preview_order did NOT place an order. ${JSON.stringify({ quoteToken: data.quoteToken, orderRequest: data.orderRequest, currency: data.currency, summary: data.summary })}. Use the exact token and request only after the buyer's next confirmation. Keep it internal.]` };
      }
    }
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
