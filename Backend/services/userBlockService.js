const UserBlock = require('../models/UserBlock');

const requestUserId = req => req?.user?.id || req?.user?._id || null;

async function getBlockedUserIds(req) {
  const userId = requestUserId(req);
  if (!userId) return [];
  const rows = await UserBlock.find({ blocker: userId }).select('blocked').lean();
  return rows.map(row => row.blocked).filter(Boolean);
}

async function isUserBlocked(req, candidateId) {
  const userId = requestUserId(req);
  if (!userId || !candidateId) return false;
  return Boolean(await UserBlock.exists({ blocker: userId, blocked: candidateId }));
}

const blockedIdSet = ids => new Set((ids || []).map(String));

module.exports = {
  blockedIdSet,
  getBlockedUserIds,
  isUserBlocked,
  requestUserId,
};
