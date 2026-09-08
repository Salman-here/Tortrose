// Presentation only: retain the original metadata in conversation state so
// the backend can still use the uploaded photo on a later turn.
export const visibleAIUserMessage = (content = '') => String(content || '')
  .replace(/\n?\[Attached product image:\s*https?:\/\/[^\]\s]+\]/gi, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const chatAttachmentDisplayType = (attachment = {}) => {
  const type = String(attachment.type || attachment.mimeType || '').toLowerCase();
  if (type === 'image' || type.startsWith('image/')) return 'image';
  if (type === 'audio' || type.startsWith('audio/')) return 'audio';
  return 'file';
};
