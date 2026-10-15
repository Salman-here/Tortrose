'use strict';
const Evidence = require('../models/AfterSalesEvidence');
const objectId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const fail = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

async function ownedEvidence({ evidenceIds, buyerId, orderId, kind, claimId = null, session = null }) {
  const prefix = kind === 'warranty' ? 'WARRANTY' : 'RETURN';
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 6
    || evidenceIds.some(value => !objectId(value)) || new Set(evidenceIds).size !== evidenceIds.length) {
    throw fail('Attach between 1 and 6 uploaded photos.', `${prefix}_EVIDENCE_REQUIRED`);
  }
  const rows = await Evidence.find({ _id: { $in: evidenceIds }, user: buyerId, order: orderId,
    // Existing uploads before kind was introduced belong to warranty only.
    kind: kind === 'return' ? 'return' : { $ne: 'return' },
    $or: [{ claim: null }, ...(claimId ? [{ claim: claimId }] : [])],
  }).session(session).lean();
  if (rows.length !== evidenceIds.length) throw fail('A photo does not belong to this buyer, order and request type.', `${prefix}_EVIDENCE_UNOWNED`, 403);
  return rows;
}
module.exports = { ownedEvidence, objectId };
