const { listAdminConversations, readAdminConversation } = require('../services/adminChatHistoryService');
const privateResponse = res => { res.set('Cache-Control', 'private, no-store'); res.set('Pragma', 'no-cache'); res.set('Vary', 'Authorization'); };
const sendError = (res, error) => {
  if ([400, 404].includes(error.status)) return res.status(error.status).json({ msg: error.message });
  console.error('Admin chat-history access failed:', error.name || 'Error');
  return res.status(500).json({ msg: 'Unable to load saved conversations. Please try again.' });
};
exports.list = async (req, res) => {
  privateResponse(res);
  try { return res.json(await listAdminConversations(req.query)); } catch (error) { return sendError(res, error); }
};
exports.read = async (req, res) => {
  privateResponse(res);
  try { return res.json(await readAdminConversation({ adminId: req.user.id, userId: req.params.userId,
    conversationId: req.params.conversationId, query: req.query })); } catch (error) { return sendError(res, error); }
};
