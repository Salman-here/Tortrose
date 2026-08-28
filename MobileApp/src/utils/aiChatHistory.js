export const CONVERSATION_GROUP_ORDER = [
  'Today',
  'Yesterday',
  'This Week',
  'This Month',
  'Older',
];

const asDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const startOfDay = (value) => {
  const date = asDate(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

export const getConversationGroupLabel = (value, nowValue = new Date()) => {
  const date = startOfDay(value);
  const today = startOfDay(nowValue);
  if (!date || !today) return 'Older';

  const diffDays = Math.max(0, Math.floor((today.getTime() - date.getTime()) / 86400000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'This Week';
  if (diffDays < 30) return 'This Month';
  return 'Older';
};

export const formatConversationTimestamp = (value, nowValue = new Date()) => {
  const date = asDate(value);
  const now = asDate(nowValue) || new Date();
  if (!date) return 'Recently';

  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const normalizeConversationSummary = (conversation) => {
  const id = conversation?._id || conversation?.id;
  if (!id) return null;

  const title = String(conversation?.title || '').trim() || 'New Chat';
  const preview = String(conversation?.preview || '').trim();
  const rawCount = Number(conversation?.messageCount);

  return {
    ...conversation,
    _id: String(id),
    title,
    preview,
    messageCount: Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0,
    lastActive: conversation?.lastActive || conversation?.updatedAt || conversation?.createdAt || null,
    source: conversation?.source === 'mobile' ? 'mobile' : 'web',
  };
};

export const groupConversationSessions = (conversations, query = '', nowValue = new Date()) => {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  const grouped = new Map(CONVERSATION_GROUP_ORDER.map((title) => [title, []]));

  (Array.isArray(conversations) ? conversations : [])
    .map(normalizeConversationSummary)
    .filter(Boolean)
    .filter((conversation) => (
      !normalizedQuery
      || conversation.title.toLocaleLowerCase().includes(normalizedQuery)
      || conversation.preview.toLocaleLowerCase().includes(normalizedQuery)
    ))
    .sort((left, right) => {
      const leftTime = asDate(left.lastActive)?.getTime() || 0;
      const rightTime = asDate(right.lastActive)?.getTime() || 0;
      return rightTime - leftTime;
    })
    .forEach((conversation) => {
      grouped.get(getConversationGroupLabel(conversation.lastActive, nowValue)).push(conversation);
    });

  return CONVERSATION_GROUP_ORDER
    .map((title) => ({ title, data: grouped.get(title) }))
    .filter((section) => section.data.length > 0);
};

const normalizeToolEvent = (event) => {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'tool_result' && event.tool) {
    return { name: event.tool, result: event.result || {} };
  }
  if (event.type !== 'client_action' || !event.action) return null;
  if (event.action === 'show_style_advice') {
    return { name: event.action, result: { styleAdvice: event.args || {} } };
  }
  if (event.action === 'suggest_outfit') {
    return { name: event.action, result: { outfitSuggestion: event.args || {} } };
  }
  return null;
};

export const normalizeChatHistoryMessage = (message, index = 0, conversationId = 'conversation') => {
  const role = ['user', 'assistant', 'system'].includes(message?.role)
    ? message.role
    : 'assistant';
  const toolResults = (Array.isArray(message?.toolEvents) ? message.toolEvents : [])
    .map(normalizeToolEvent)
    .filter(Boolean);
  const attachments = (Array.isArray(message?.attachments) ? message.attachments : [])
    .filter((attachment) => attachment?.url)
    .map((attachment, attachmentIndex) => ({
      ...attachment,
      id: String(attachment.id || `${conversationId}-${index}-attachment-${attachmentIndex}`),
      type: attachment.type || 'image',
      name: attachment.name || 'Attachment',
    }));

  return {
    id: String(
      message?._id
      || message?.id
      || `${conversationId}-${message?.createdAt || index}`
    ),
    role,
    content: String(message?.content || ''),
    ...(attachments.length ? { attachments } : {}),
    ...(toolResults.length ? { toolResults } : {}),
    ...(message?.createdAt ? { createdAt: message.createdAt } : {}),
  };
};
