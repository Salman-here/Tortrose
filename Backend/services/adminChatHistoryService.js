'use strict';
const mongoose = require('mongoose');
const ChatHistory = require('../models/ChatHistory');
const User = require('../models/User');
const AccessLog = require('../models/AdminChatAccessLog');
const SOURCES = ['web', 'mobile', 'whatsapp'];
const ROLES = ['user', 'seller', 'admin'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' ? value : value?._id ? String(value._id)
  : typeof value?.toHexString === 'function' ? value.toHexString() : '';
const sourceOf = value => SOURCES.includes(value) ? value : 'unknown';
const dateOf = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const objectId = value => {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw fail('Invalid account or conversation identifier.');
  return new mongoose.Types.ObjectId(value);
};
const boundedInteger = (value, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw fail('Invalid pagination.');
  return Number(value);
};
const choice = (value, allowed) => {
  if (value === undefined || value === 'all') return 'all';
  if (typeof value !== 'string' || !allowed.includes(value)) throw fail('Invalid chat filter.');
  return value;
};

function visibleText(value, limit = 24000) {
  if (typeof value !== 'string') return '';
  return value.split(/\n\s*\[Tool memory:/i)[0]
    .replace(/\n?\[Attached product image: https?:\/\/[^\]\s]+\]/gi, '')
    .replace(/\bBearer\s+[A-Za-z\d._~-]{16,}/gi, 'Bearer [hidden]')
    .replace(/\bsk-(?:or-v1-)?[A-Za-z\d_-]{20,}\b/g, '[API key hidden]')
    .replace(/\baip1\.[A-Za-z\d._-]+/g, '[private action reference hidden]')
    .replace(/\beyJ[A-Za-z\d_-]{12,}\.[A-Za-z\d_-]{12,}\.[A-Za-z\d_-]{12,}\b/g, '[session token hidden]')
    .replace(/\b(password|api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[^\s"']+/gi, '$1: [hidden]')
    .replace(/([?&](?:token|code|secret|api_key|client_secret)=)[^\s&#]+/gi, '$1[hidden]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim().slice(0, limit);
}

function attachmentView(value) {
  if (!value || typeof value.url !== 'string' || value.url.length > 4096) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|signature|authorization/i.test(key))) return null;
    return { type: typeof value.type === 'string' ? value.type.slice(0, 40) : 'file', url: url.href,
      name: visibleText(value.name || 'Attachment', 140) };
  } catch { return null; }
}

const userView = user => ({ id: id(user), name: visibleText(user.username, 120) || 'Rozare account',
  email: typeof user.email === 'string' ? user.email : '', role: user.role, status: user.status || 'active' });

async function listAdminConversations(query = {}) {
  const page = boundedInteger(query.page, 1, 1000), limit = boundedInteger(query.limit, 20, 50);
  const source = choice(query.source, [...SOURCES, 'unknown']), role = choice(query.role, ROLES);
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 100)) throw fail('Search must be at most 100 characters.');
  const search = (query.search || '').trim();
  const subjectId = query.userId === undefined ? null : objectId(query.userId);
  const subject = subjectId ? await User.findById(subjectId).select('_id username email role status').lean() : null;
  if (subjectId && !subject) throw fail('Account not found.', 404);
  const pipeline = [
    ...(subjectId ? [{ $match: { user: subjectId } }] : []),
    { $lookup: { from: User.collection.name, localField: 'user', foreignField: '_id', as: 'owner',
      pipeline: [{ $project: { _id: 1, username: 1, email: 1, role: 1, status: 1 } }] } },
    { $unwind: '$owner' },
    ...(role === 'all' ? [] : [{ $match: { 'owner.role': role } }]),
    { $set: { conversations: { $concatArrays: [{ $ifNull: ['$conversations', []] },
      { $cond: [{ $gt: [{ $size: { $ifNull: ['$messages', []] } }, 0] },
        [{ _id: '$_id', title: 'Legacy conversation', source: 'unknown', messages: '$messages', createdAt: '$createdAt', lastActive: '$updatedAt', legacy: true }], []] }] } } },
    { $unwind: '$conversations' },
    { $set: { source: { $cond: [{ $in: ['$conversations.source', SOURCES] }, '$conversations.source', 'unknown'] } } },
    ...(source === 'all' ? [] : [{ $match: { source } }]),
    ...(search ? [{ $match: { $or: ['owner.username', 'owner.email', 'conversations.title'].map(field => ({
      [field]: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
    })) } }] : []),
    { $project: { _id: '$conversations._id', owner: 1, source: 1, title: '$conversations.title',
      createdAt: '$conversations.createdAt', lastActive: { $ifNull: ['$conversations.lastActive', '$conversations.createdAt'] },
      legacy: { $ifNull: ['$conversations.legacy', false] },
      messageCount: { $size: { $filter: { input: { $ifNull: ['$conversations.messages', []] }, as: 'message',
        cond: { $in: ['$$message.role', ['user', 'assistant']] } } } } } },
    { $sort: { lastActive: -1, _id: -1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } },
  ];
  const [result] = await ChatHistory.aggregate(pipeline).option({ maxTimeMS: 10000 });
  const total = result?.count?.[0]?.total || 0;
  return { conversations: (result?.rows || []).map(row => ({ id: id(row), user: userView(row.owner),
    title: visibleText(row.title, 120) || 'Untitled conversation', source: sourceOf(row.source),
    legacy: Boolean(row.legacy),
    createdAt: dateOf(row.createdAt), lastActive: dateOf(row.lastActive), messageCount: row.messageCount })),
  subject: subject ? userView(subject) : null, pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total } };
}

async function readAdminConversation({ adminId, userId, conversationId, query = {} }) {
  const subjectId = objectId(userId), chatId = objectId(conversationId);
  const page = boundedInteger(query.page, 1, 1000), limit = boundedInteger(query.limit, 50, 100);
  const user = await User.findById(subjectId).select('_id username email role status').lean();
  if (!user) throw fail('Account not found.', 404);
  // Read raw legacy fields as well as current conversations. Old retained
  // top-level messages are not present in the current Mongoose schema.
  const history = await ChatHistory.collection.findOne({ user: subjectId, $or: [
    { 'conversations._id': chatId }, { _id: chatId, 'messages.0': { $exists: true } },
  ] }, { projection: { _id: 1, user: 1, createdAt: 1, updatedAt: 1, messages: 1, conversations: { $elemMatch: { _id: chatId } } } });
  const conversation = history?.conversations?.[0] || (history?.messages?.length && id(history) === String(chatId)
    ? { _id: history._id, title: 'Legacy conversation', source: 'unknown', messages: history.messages, createdAt: history.createdAt, lastActive: history.updatedAt, legacy: true } : null);
  if (!conversation) throw fail('Conversation not found for this account.', 404);
  const visibleMessages = (conversation.messages || []).filter(message => ['user', 'assistant'].includes(message.role));
  const end = Math.max(0, visibleMessages.length - (page - 1) * limit), start = Math.max(0, end - limit);
  const messages = visibleMessages.slice(start, end).map((message, index) => ({ id: id(message) || `legacy-${start + index}`, role: message.role,
    content: visibleText(message.content), createdAt: dateOf(message.createdAt),
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 10).map(attachmentView).filter(Boolean) }));
  // No transcript leaves the endpoint unless its access metadata was saved.
  await AccessLog.create({ admin: objectId(String(adminId)), subject: subjectId, conversation: chatId, source: sourceOf(conversation.source) });
  return { conversation: { id: id(conversation), user: userView(user), source: sourceOf(conversation.source),
    legacy: Boolean(conversation.legacy),
    title: visibleText(conversation.title, 120) || 'Untitled conversation', createdAt: dateOf(conversation.createdAt),
    lastActive: dateOf(conversation.lastActive) }, messages,
  pagination: { page, limit, total: visibleMessages.length, hasOlder: start > 0 } };
}

module.exports = { listAdminConversations, readAdminConversation, visibleText, attachmentView };
