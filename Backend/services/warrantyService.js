'use strict';
const crypto = require('node:crypto');
const Order = require('../models/Order');
const Request = require('../models/ReturnRequest');
const Evidence = require('../models/AfterSalesEvidence');
const User = require('../models/User');
const { runInTransaction } = require('./walletService');
const { allocateOrderLineAmountForQuantity, getOrderItemLineSubtotal } = require('./orderLinePricingService');
const { getAccountingOrderCurrency } = require('./orderMoneyService');
const { getConsumedQuantities, getItemSellerMap, getSellerFulfillment, getSellerPolicy, selectedReturnMoney } = require('./returnService');
const { notifySellerReturnRequested, notifyBuyerReturnStatus } = require('./returnNotificationService');
const id = value => String(value?._id || value || '');
const oid = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, code = 'WARRANTY_INVALID', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const keyHash = (key, buyer) => {
  if (typeof key !== 'string' || key.length < 16 || key.length > 256 || key !== key.trim()) throw failure('A valid request key is required.', 'WARRANTY_REQUEST_KEY_INVALID', 400);
  return `warranty:v1:${buyer}:${hash(key)}`;
};

function warrantyDeadline(deliveredAt, months) {
  const start = new Date(deliveredAt);
  if (!deliveredAt || !Number.isFinite(start.getTime()) || !Number.isSafeInteger(months) || months < 1 || months > 120) return null;
  // Calendar months, including leap years and Jan-31 -> Feb-28/29. A
  // replacement or appeal never restarts the purchased warranty clock.
  const day = start.getUTCDate(), end = new Date(start);
  end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay)); return end;
}

async function buildWarrantyEligibility(order, { session = null, at = new Date() } = {}) {
  const sellerMap = await getItemSellerMap(order, session);
  const { consumed } = await getConsumedQuantities(order._id, session, { financialOnly: true });
  const grouped = new Map();
  for (const item of order.orderItems || []) {
    const seller = sellerMap.get(id(item)); if (!seller) continue;
    const snapshot = Number(item.returnPolicySnapshotVersion) >= 1 ? item.returnPolicy
      : (order.sellerPolicies || []).find(row => id(row.seller) === seller)?.returnPolicy;
    const fulfillment = getSellerFulfillment(order, seller);
    const months = snapshot?.warrantyDuration, deadline = warrantyDeadline(fulfillment?.deliveredAt, months);
    const blocked = consumed.get(id(item)) || 0, availableQuantity = Math.max(0, item.quantity - blocked);
    let reason = '';
    if (order.awaitingPayment || order.orderStatus === 'cancelled' || fulfillment?.status === 'cancelled') reason = 'This order is not eligible for a warranty claim.';
    else if (['wallet', 'safepay', 'stripe'].includes(order.paymentMethod) && order.isPaid !== true) reason = 'Payment has not been confirmed for this purchased item.';
    else if (snapshot?.warrantyEnabled !== true) reason = 'No warranty was included with this purchased item.';
    else if (fulfillment?.status !== 'delivered' || !fulfillment.deliveredAt) reason = 'Warranty claims open after delivery.';
    else if (!deadline) reason = 'The purchased warranty terms could not be verified. Contact support.';
    else if (new Date(at).getTime() > deadline.getTime()) reason = 'The saved warranty period has expired.';
    else if (!availableQuantity) reason = 'These quantities already have an active claim or have been refunded.';
    const rows = grouped.get(seller) || [];
    rows.push({ orderItemId: id(item), productId: id(item.productId), name: item.name, image: item.image || '',
      purchasedQuantity: item.quantity, availableQuantity, eligible: !reason, reason,
      months: Number.isSafeInteger(months) ? months : 0, deliveredAt: fulfillment?.deliveredAt || null,
      deadline, description: snapshot?.warrantyDescription || '', selectedColor: item.selectedColor || null,
      selectedOptions: item.selectedOptions || {} }); grouped.set(seller, rows);
  }
  const groups = [];
  for (const [seller, items] of grouped) {
    const profile = await User.findById(seller).select('_id username').session(session).lean();
    const display = await getSellerPolicy(order, seller, session);
    groups.push({ seller: { _id: seller, username: profile?.username || 'Seller' },
      store: { _id: id(display.storeId) || null, storeName: display.storeName || '' }, items });
  }
  return { version: 1, orderId: id(order), currency: getAccountingOrderCurrency(order), groups };
}

async function verifiedEvidence({ evidenceIds, buyerId, orderId, claimId = null, session }) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 6
      || evidenceIds.some(value => !oid(value)) || new Set(evidenceIds).size !== evidenceIds.length) throw failure('Attach between 1 and 6 uploaded photos.', 'WARRANTY_EVIDENCE_REQUIRED', 400);
  const rows = await Evidence.find({ _id: { $in: evidenceIds }, user: buyerId, order: orderId,
    $or: [{ claim: null }, ...(claimId ? [{ claim: claimId }] : [])] }).session(session).lean();
  if (rows.length !== evidenceIds.length) throw failure('A photo does not belong to this buyer and order.', 'WARRANTY_EVIDENCE_UNOWNED', 403);
  return rows;
}

function normalizeInput(input) {
  if (!oid(input.orderId) || !oid(input.buyerId) || !oid(input.sellerId)
      || typeof input.reasonDetails !== 'string' || input.reasonDetails.trim().length < 10 || input.reasonDetails.length > 1500
      || !Array.isArray(input.items) || input.items.length !== 1) throw failure('Select one purchased product and explain the warranty issue.', 'WARRANTY_INPUT_INVALID', 400);
  if (input.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw failure('Select a valid purchased product.', 'WARRANTY_INPUT_INVALID', 400);
  const items = input.items.map(item => ({ orderItemId: item.orderItemId, quantity: item.quantity })).sort((a,b) => String(a.orderItemId).localeCompare(String(b.orderItemId)));
  if (items.some(item => !oid(item.orderItemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
      || new Set(items.map(item => item.orderItemId)).size !== items.length) throw failure('Warranty quantities must be whole purchased units.', 'WARRANTY_QUANTITY_INVALID', 400);
  const evidenceIds = Array.isArray(input.evidenceIds) ? [...input.evidenceIds].sort() : input.evidenceIds;
  const reasonDetails = input.reasonDetails.trim(), requestKey = keyHash(input.requestKey, input.buyerId);
  const requestFingerprint = hash({ orderId: input.orderId, sellerId: input.sellerId, buyerId: input.buyerId, reasonDetails, items, evidenceIds });
  return { ...input, reasonDetails, items, evidenceIds, requestKey, requestFingerprint };
}

function createWarrantyService({ now = () => new Date() } = {}) {
  async function createClaim(input) {
    const prepared = normalizeInput(input);
    return runInTransaction(async session => {
      const prior = await Request.findOne({ requestKey: prepared.requestKey, buyer: prepared.buyerId }).select('+requestFingerprint').session(session);
      if (prior) {
        if (prior.kind !== 'warranty' || prior.requestFingerprint !== prepared.requestFingerprint) throw failure('This key belongs to a different claim.', 'IDEMPOTENCY_CONFLICT');
        prior.$locals = { idempotencyReplay: true }; return prior;
      }
      const order = await Order.findOne({ _id: prepared.orderId, user: prepared.buyerId, awaitingPayment: { $ne: true } }).session(session);
      if (!order) throw failure('The order was not found in this buyer account.', 'WARRANTY_ORDER_NOT_FOUND', 404);
      // Same order fence as normal returns: both paths cannot claim the same
      // unit concurrently. This write is NOT an earnings or withdrawal hold.
      await Order.updateOne({ _id: order._id }, { $inc: { returnVersion: 1 } }, { session });
      const eligibility = await buildWarrantyEligibility(order, { session, at: now() });
      const group = eligibility.groups.find(row => row.seller._id === prepared.sellerId);
      if (!group) throw failure('These items do not belong to the selected seller.', 'WARRANTY_SELLER_MISMATCH', 403);
      const selected = prepared.items.map(wanted => {
        const item = group.items.find(row => row.orderItemId === wanted.orderItemId);
        if (!item?.eligible || wanted.quantity > item.availableQuantity) throw failure(item?.reason || 'This quantity is not eligible.', 'WARRANTY_NOT_ELIGIBLE');
        return { ...item, quantity: wanted.quantity };
      });
      const evidence = await verifiedEvidence({ ...prepared, orderId: id(order), session });
      const moneyState = await getConsumedQuantities(order._id, session, { financialOnly: true });
      const sellerItems = group.items.map(item => ({ ...item, purchasedQuantity: item.purchasedQuantity }));
      const selectedMoney = selected.map(item => ({ ...item,
        lineSubtotal: getOrderItemLineSubtotal(order.orderItems.find(row => id(row) === item.orderItemId)) }));
      const refund = selectedReturnMoney({ order, sellerId: prepared.sellerId, sellerItems, selected: selectedMoney,
        consumed: moneyState.consumed, settledQuantities: moneyState.settledQuantities,
        shippingAlreadyRefunded: moneyState.shippingRefundedBySeller.has(prepared.sellerId),
        sellerRefundedAmount: moneyState.refundedAmountBySeller.get(prepared.sellerId) || 0 });
      const deadline = new Date(Math.min(...selected.map(item => new Date(item.deadline).getTime())));
      const [claim] = await Request.create([{ kind: 'warranty', returnNumber: `WAR-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        requestKey: prepared.requestKey, requestFingerprint: prepared.requestFingerprint,
        order: order._id, orderId: order.orderId, buyer: prepared.buyerId, seller: prepared.sellerId,
        store: group.store._id || null, storeName: group.store.storeName, currency: eligibility.currency,
        evidence: evidence.map(row => row._id), evidenceUrls: evidence.map(row => row.url),
        evidenceHistory: [{ version: 0, evidence: evidence.map(row => row._id), urls: evidence.map(row => row.url), reason: prepared.reasonDetails, submittedAt: now() }],
        items: selected.map(item => {
          const original = order.orderItems.find(row => id(row) === item.orderItemId), subtotal = getOrderItemLineSubtotal(original);
          const lineSubtotal = allocateOrderLineAmountForQuantity(subtotal, item.purchasedQuantity,
            moneyState.consumed.get(item.orderItemId) || 0, item.quantity);
          return { orderItemId: item.orderItemId, productId: item.productId, name: item.name, image: item.image,
            quantity: item.quantity, purchasedQuantity: item.purchasedQuantity, unitPrice: subtotal / item.purchasedQuantity,
            lineSubtotal, selectedColor: item.selectedColor, selectedOptions: item.selectedOptions };
        }), reasonCategory: 'defective', reasonDetails: prepared.reasonDetails, status: 'requested',
        requestedAt: now(), eligibilityDeadline: deadline, refundFundingPolicy: 'seller_funded',
        warrantySnapshot: { version: 1, months: selected[0].months, deliveredAt: selected[0].deliveredAt,
          deadline, description: selected[0].description },
        // Shared refund/inspection machinery. The warranty deadline above,
        // NOT this return-policy compatibility field, governs claim creation.
        policySnapshot: { returnsEnabled: true, returnDuration: 1, refundType: 'full_refund', policyDescription: 'Warranty claim' },
        statusHistory: [{ status: 'requested', note: prepared.reasonDetails.slice(0, 1000), changedBy: prepared.buyerId, actorRole: 'buyer', changedAt: now() }], refund }], { session });
      await Evidence.updateMany({ _id: { $in: evidence.map(row => row._id) }, user: prepared.buyerId }, { $set: { claim: claim._id } }, { session });
      await notifySellerReturnRequested(claim, order, { session }); return claim;
    });
  }

  async function decide({ claimId, sellerId, outcome, resolution, reason, expectedUpdatedAt }) {
    if (!oid(claimId) || !oid(sellerId) || !['approve', 'reject'].includes(outcome)
        || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000
        || outcome === 'approve' && !['refund', 'replacement'].includes(resolution)) throw failure('Declare the resolution and give a clear decision reason.', 'WARRANTY_DECISION_INVALID', 400);
    return runInTransaction(async session => {
      const claim = await Request.findOne({ _id: claimId, seller: sellerId, kind: 'warranty' }).session(session);
      if (!claim) throw failure('Warranty claim not found for this seller.', 'WARRANTY_NOT_FOUND', 404);
      if (expectedUpdatedAt && new Date(claim.updatedAt).toISOString() !== expectedUpdatedAt) throw failure('The claim changed. Review it again.', 'WARRANTY_STALE');
      if (claim.status !== 'requested') throw failure('Only a pending warranty claim can receive this decision.', 'WARRANTY_DECISION_STATE');
      if (outcome === 'approve' && resolution === 'refund' && claim.refund.totalAmount <= 0) throw failure('No paid amount remains to refund. Choose a replacement for this claim.', 'WARRANTY_NO_REFUND_AMOUNT', 400);
      await Order.updateOne({ _id: claim.order }, { $inc: { returnVersion: 1 } }, { session });
      const alreadyReceived = claim.statusHistory.some(row => row.status === 'received_by_seller');
      claim.status = outcome === 'approve' ? (alreadyReceived ? 'under_review' : 'approved') : 'rejected';
      claim.decisionReason = reason.trim(); claim.sellerNote = reason.trim();
      if (outcome === 'approve') { claim.resolution = resolution; claim.policySnapshot.refundType = resolution === 'replacement' ? 'replacement_only' : 'full_refund'; }
      claim.statusHistory.push({ status: claim.status, note: `${outcome === 'approve' ? `Planned resolution: ${resolution}. ` : ''}${reason.trim()}`,
        changedBy: sellerId, actorRole: 'seller', changedAt: now() });
      await claim.save({ session }); await notifyBuyerReturnStatus(claim, await Order.findById(claim.order).session(session), '', { session }); return claim;
    });
  }

  async function appeal({ claimId, buyerId, reasonDetails, evidenceIds, requestKey }) {
    if (!oid(claimId) || !oid(buyerId) || typeof reasonDetails !== 'string' || reasonDetails.trim().length < 10 || reasonDetails.length > 1500
      || !Array.isArray(evidenceIds) || evidenceIds.length < 1 || evidenceIds.length > 6
      || evidenceIds.some(value => !oid(value)) || new Set(evidenceIds).size !== evidenceIds.length) throw failure('Explain the appeal and attach 1 to 6 photos for this original claim.', 'WARRANTY_APPEAL_INVALID', 400);
    const storageKey = keyHash(requestKey, buyerId), fingerprint = hash({ claimId, buyerId, reasonDetails: reasonDetails.trim(), evidenceIds: [...(evidenceIds || [])].sort() });
    return runInTransaction(async session => {
      const claim = await Request.findOne({ _id: claimId, buyer: buyerId, kind: 'warranty' }).select('+lastAppealKey +lastAppealFingerprint').session(session);
      if (!claim) throw failure('The original warranty claim was not found.', 'WARRANTY_NOT_FOUND', 404);
      if (claim.lastAppealKey === storageKey) {
        if (claim.lastAppealFingerprint !== fingerprint) throw failure('This appeal key belongs to different details.', 'IDEMPOTENCY_CONFLICT');
        return claim;
      }
      if (claim.status !== 'rejected' || claim.warrantySnapshot?.version !== 1
          || !Number.isFinite(new Date(claim.requestedAt).getTime()) || !Number.isFinite(new Date(claim.warrantySnapshot.deadline).getTime())
          || new Date(claim.requestedAt).getTime() > new Date(claim.warrantySnapshot.deadline).getTime()) throw failure('Only an original on-time rejected claim can be appealed.', 'WARRANTY_APPEAL_STATE');
      await Order.updateOne({ _id: claim.order }, { $inc: { returnVersion: 1 } }, { session });
      const evidence = await verifiedEvidence({ evidenceIds, buyerId, orderId: id(claim.order), claimId, session });
      const state = await getConsumedQuantities(claim.order, session, { financialOnly: true });
      const order = await Order.findById(claim.order).session(session);
      if (!order || id(order.user) !== buyerId || claim.items.some(item => (state.consumed.get(id(item.orderItemId)) || 0) + item.quantity > item.purchasedQuantity)) throw failure('A later claim or refund already uses these units.', 'WARRANTY_QUANTITY_UNAVAILABLE');
      // A rejected quote owns no money. If another purchased unit was refunded
      // meanwhile, reallocate exact cents using the SAME original paid prices.
      const sellerMap = await getItemSellerMap(order, session);
      const sellerItems = order.orderItems.filter(row => sellerMap.get(id(row)) === id(claim.seller))
        .map(row => ({ orderItemId: id(row), purchasedQuantity: row.quantity }));
      const selected = claim.items.map(item => {
        const original = order.orderItems.find(row => id(row) === id(item.orderItemId));
        if (!original || sellerMap.get(id(original)) !== id(claim.seller)) throw failure('The original claim identity cannot be verified.');
        return { orderItemId: id(item.orderItemId), quantity: item.quantity, purchasedQuantity: original.quantity,
          lineSubtotal: getOrderItemLineSubtotal(original) };
      });
      const refund = selectedReturnMoney({ order, sellerId: id(claim.seller), sellerItems, selected,
        consumed: state.consumed, settledQuantities: state.settledQuantities,
        shippingAlreadyRefunded: state.shippingRefundedBySeller.has(id(claim.seller)),
        sellerRefundedAmount: state.refundedAmountBySeller.get(id(claim.seller)) || 0 });
      for (const item of claim.items) {
        const original = selected.find(row => row.orderItemId === id(item.orderItemId));
        item.set('lineSubtotal', allocateOrderLineAmountForQuantity(original.lineSubtotal, original.purchasedQuantity,
          state.consumed.get(id(item.orderItemId)) || 0, item.quantity), undefined, { overwriteImmutable: true });
      }
      for (const [field, amount] of Object.entries(refund)) claim.set(`refund.${field}`, amount, undefined, { overwriteImmutable: true });
      if (!Number.isSafeInteger(claim.appealVersion) || claim.appealVersion >= Number.MAX_SAFE_INTEGER) throw failure('The claim history requires support review.');
      claim.appealVersion += 1; claim.lastAppealKey = storageKey; claim.lastAppealFingerprint = fingerprint;
      claim.reasonDetails = reasonDetails.trim(); claim.evidence = evidence.map(row => row._id); claim.evidenceUrls = evidence.map(row => row.url);
      claim.evidenceHistory.push({ version: claim.appealVersion, evidence: evidence.map(row => row._id), urls: evidence.map(row => row.url), reason: reasonDetails.trim(), submittedAt: now() });
      claim.status = 'requested'; claim.resolution = null; claim.decisionReason = ''; claim.policySnapshot.refundType = 'full_refund';
      claim.statusHistory.push({ status: 'requested', note: `Appeal of the original on-time warranty claim: ${reasonDetails.trim()}`.slice(0, 1000),
        changedBy: buyerId, actorRole: 'buyer', changedAt: now() });
      await Evidence.updateMany({ _id: { $in: evidence.map(row => row._id) }, user: buyerId }, { $set: { claim: claim._id } }, { session });
      await claim.save({ session }); await notifySellerReturnRequested(claim, order, { session }); return claim;
    });
  }
  return { createClaim, decide, appeal };
}

module.exports = { warrantyDeadline, buildWarrantyEligibility, createWarrantyService, verifiedEvidence };
