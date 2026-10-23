export const chatSourceLabels = { web: 'Web', mobile: 'Mobile app', whatsapp: 'WhatsApp', unknown: 'Unspecified' };
const id = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const account = value => value && id(value.id) && typeof value.name === 'string' && typeof value.email === 'string'
  && ['user', 'seller', 'admin'].includes(value.role);
const conversation = value => value && id(value.id) && account(value.user) && typeof value.title === 'string'
  && Object.hasOwn(chatSourceLabels, value.source);
export const chatKey = value => value ? `${value.user.id}:${value.id}` : '';

export function inspectAdminChatList(value) {
  if (!value || !Array.isArray(value.conversations) || value.conversations.length > 50 || !value.conversations.every(conversation)
    || !value.pagination || !integer(value.pagination.total) || !integer(value.pagination.page) || value.pagination.page < 1
    || !integer(value.pagination.limit) || value.pagination.limit < 1 || typeof value.pagination.hasMore !== 'boolean') {
    throw Error('The saved conversation list could not be verified. Please refresh.');
  }
  return value;
}

export function safeChatAttachment(value) {
  if (!value || typeof value.url !== 'string' || value.url.length > 4096) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|signature|authorization/i.test(key))) return null;
    return { url: url.href, name: typeof value.name === 'string' ? value.name : 'Attachment' };
  } catch { return null; }
}

export function inspectAdminChatTranscript(value, expectedKey) {
  if (!conversation(value?.conversation) || chatKey(value.conversation) !== expectedKey || !Array.isArray(value.messages)
    || value.messages.length > 100 || !value.messages.every(message => message && typeof message.id === 'string'
      && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.length <= 24000)
    || !integer(value.pagination?.total) || !integer(value.pagination?.page) || typeof value.pagination?.hasOlder !== 'boolean') {
    throw Error('This transcript does not match the selected conversation. Please refresh.');
  }
  return value;
}
