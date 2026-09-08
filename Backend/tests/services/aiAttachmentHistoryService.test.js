'use strict';
jest.mock('../../models/ChatHistory', () => ({ findOne: jest.fn() }));
const ChatHistory = require('../../models/ChatHistory');
const { restoreAttachmentHistory, bindNamedProductImage } = require('../../services/aiAttachmentHistoryService');
const conversationId = '6a9b77adb0befe27bd10f25d';
const imageUrl = 'https://res.cloudinary.com/rozare/image/upload/tumbler.png';
const caption = 'add this to my store please. call it Horizon Commuter Tumbler';
const saved = { role: 'user', content: `${caption}\n\n[Attached product image: ${imageUrl}]`, attachments: [{ type: 'image', url: imageUrl }] };
const setHistory = messages => ChatHistory.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ conversations: [{ messages }] }) }) });
beforeEach(() => { jest.clearAllMocks(); setHistory([saved]); });

test('recovers an uploaded photo across a missing-details follow-up in the same authenticated conversation', async () => {
  const messages = await restoreAttachmentHistory([
    { role: 'user', content: caption },
    { role: 'assistant', content: 'What price and stock?' },
    { role: 'user', content: '2250 rupees and 8 in stock' },
  ], 'buyer-identity', conversationId);
  expect(messages[0].content).toContain(imageUrl);
  expect(messages[2].content).toBe('2250 rupees and 8 in stock');
  expect(ChatHistory.findOne).toHaveBeenCalledWith({ user: 'buyer-identity', conversations: { $elemMatch: { _id: conversationId, source: { $ne: 'whatsapp' } } } });
  const args = bindNamedProductImage({ name: 'Horizon Commuter Tumbler', price: 2250 }, messages);
  expect(args.image).toBe(imageUrl);
  expect(args.images).toEqual([imageUrl]);
});

test('does not borrow an image from another caption or an ambiguous repeated caption', async () => {
  const second = { ...saved, content: caption + '\n\n[Attached product image: https://example.com/other.png]', attachments: [] };
  setHistory([saved, second]);
  const messages = [{ role: 'user', content: caption }];
  expect(await restoreAttachmentHistory(messages, 'buyer-identity', conversationId)).toEqual(messages);
  expect(bindNamedProductImage({ name: 'An unrelated item' }, [saved])).toEqual({ name: 'An unrelated item' });
});

test('a new explicit image wins over historical images and existing image arguments are preserved', async () => {
  const explicit = { role: 'user', content: caption, attachments: [{ type: 'image', url: 'https://example.com/new.png' }] };
  expect((await restoreAttachmentHistory([explicit], 'buyer-identity', conversationId))[0]).toEqual(explicit);
  const args = { name: 'Horizon Commuter Tumbler', image: 'https://example.com/selected.png' };
  expect(bindNamedProductImage(args, [saved])).toEqual(args);
});

test('anonymous requests or missing conversation IDs never query stored attachments', async () => {
  const messages = [{ role: 'user', content: caption }];
  expect(await restoreAttachmentHistory(messages, null, conversationId)).toBe(messages);
  expect(await restoreAttachmentHistory(messages, 'buyer-identity', undefined)).toBe(messages);
  expect(ChatHistory.findOne).not.toHaveBeenCalled();
});

test('restores a saved order preview for an older client without guessing between repeated summaries', async () => {
  const data = { quoteToken: 'aip1.saved.signed', orderRequest: { productId: 'internal-product', quantity: 1 }, currency: 'PKR', summary: { totalAmount: 3939.5 } };
  const previewMessage = { role: 'assistant', content: 'Your total is Rs3939.50. Confirm?', toolEvents: [{ tool: 'preview_order', result: { success: true, data } }] };
  setHistory([previewMessage]);
  const incoming = [{ role: 'assistant', content: previewMessage.content + '\n\n[Tool memory: preview_order succeeded.]' }, { role: 'user', content: 'yes please' }];
  const restored = await restoreAttachmentHistory(incoming, 'buyer-identity', conversationId);
  expect(restored[0].content).toContain(data.quoteToken);
  expect(restored[1]).toEqual(incoming[1]);
  setHistory([previewMessage, { ...previewMessage, toolEvents: [{ tool: 'preview_order', result: { success: true, data: { ...data, quoteToken: 'aip1.different.signed' } } }] }]);
  expect(await restoreAttachmentHistory(incoming, 'buyer-identity', conversationId)).toEqual(incoming);
});
