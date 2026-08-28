const crypto = require('crypto');
const mongoose = require('mongoose');
const Complaint = require('../models/Complaint');
const Product = require('../models/Product');
const Store = require('../models/Store');
const StoreReview = require('../models/StoreReview');
const ChatHistory = require('../models/ChatHistory');
const User = require('../models/User');
const UserBlock = require('../models/UserBlock');

const REPORT_KINDS = new Set(['ai_response', 'product', 'review', 'store', 'seller']);
const REPORT_REASONS = new Set(['inappropriate', 'harmful', 'misleading', 'spam', 'illegal', 'other']);
const validId = value => mongoose.Types.ObjectId.isValid(value);
const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

const reportCategory = kind => ({
  ai_response: 'ai_response',
  product: 'product_issue',
  review: 'review_report',
  store: 'store_report',
  seller: 'seller_complaint',
}[kind]);

const reportSubject = kind => ({
  ai_response: 'Reported AI response',
  product: 'Reported product',
  review: 'Reported store review',
  store: 'Reported store',
  seller: 'Reported seller',
}[kind]);

async function resolveAIReport({ userId, conversationId, messageId, content }) {
  if (!content) {
    const error = new Error('The AI response is required');
    error.statusCode = 400;
    throw error;
  }

  // Guest conversations are intentionally not persisted. Authenticated
  // reports are checked against the reporter's own saved conversation.
  const contentSource = { sourceId: crypto.createHash('sha256').update(content).digest('hex').slice(0, 24) };
  if (!userId || !conversationId) return contentSource;
  if (!validId(conversationId)) {
    const error = new Error('Conversation not found');
    error.statusCode = 404;
    throw error;
  }

  const history = await ChatHistory.findOne({ user: userId }).lean();
  const conversation = history?.conversations?.find(row => String(row._id) === String(conversationId));
  if (!conversation || conversation.source === 'whatsapp') {
    const error = new Error('Conversation not found');
    error.statusCode = 404;
    throw error;
  }

  const assistantMessages = (conversation.messages || []).filter(message => message.role === 'assistant');
  const message = validId(messageId)
    ? assistantMessages.find(row => String(row._id) === String(messageId))
    : [...assistantMessages].reverse().find(row => String(row.content || '').trim() === content);
  if (!message || String(message.content || '').trim() !== content) {
    const error = new Error('AI response not found in this conversation');
    error.statusCode = 404;
    throw error;
  }

  return {
    sourceId: String(message._id),
    conversationId: conversation._id,
    messageId: message._id,
  };
}

async function resolveMarketplaceReport(kind, targetId) {
  if (!validId(targetId)) {
    const error = new Error('Reported item not found');
    error.statusCode = 404;
    throw error;
  }

  if (kind === 'product') {
    const product = await Product.findById(targetId).select('name description seller image').lean();
    if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
    return {
      sourceId: String(product._id),
      targetUser: product.seller || null,
      relatedProduct: product._id,
      contentSnapshot: [product.name, product.description].filter(Boolean).join('\n').slice(0, 4000),
    };
  }

  if (kind === 'review') {
    const review = await StoreReview.findById(targetId).select('store user title comment rating').lean();
    if (review) {
      return {
        sourceId: String(review._id),
        targetUser: review.user,
        relatedReview: review._id,
        relatedStore: review.store,
        contentSnapshot: [review.title, review.comment, `Rating: ${review.rating}`].filter(Boolean).join('\n').slice(0, 4000),
      };
    }

    const product = await Product.findOne({ 'reviews._id': targetId })
      .select('name seller reviews.$')
      .lean();
    const productReview = product?.reviews?.[0];
    if (!productReview) throw Object.assign(new Error('Review not found'), { statusCode: 404 });
    return {
      sourceId: String(productReview._id),
      targetUser: productReview.user,
      relatedProduct: product._id,
      contentSnapshot: [product.name, productReview.comment, `Rating: ${productReview.rating}`].filter(Boolean).join('\n').slice(0, 4000),
    };
  }

  if (kind === 'store') {
    const store = await Store.findById(targetId).select('seller storeName description storeSlug').lean();
    if (!store) throw Object.assign(new Error('Store not found'), { statusCode: 404 });
    return {
      sourceId: String(store._id),
      targetUser: store.seller,
      relatedStore: store._id,
      contentSnapshot: [store.storeName, store.description, store.storeSlug].filter(Boolean).join('\n').slice(0, 4000),
    };
  }

  const seller = await User.findOne({ _id: targetId, role: 'seller' }).select('_id username email').lean();
  if (!seller) throw Object.assign(new Error('Seller not found'), { statusCode: 404 });
  const store = await Store.findOne({ seller: seller._id }).select('_id storeName storeSlug').lean();
  return {
    sourceId: String(seller._id),
    targetUser: seller._id,
    relatedStore: store?._id || null,
    contentSnapshot: [store?.storeName, store?.storeSlug, seller.username].filter(Boolean).join('\n').slice(0, 4000),
  };
}

exports.createReport = async (req, res) => {
  const kind = cleanText(req.body?.kind, 30);
  const reason = cleanText(req.body?.reason, 30);
  const details = cleanText(req.body?.details, 1000);
  const content = cleanText(req.body?.content, 4000);
  const userId = req.user?.id || req.user?._id || null;

  if (!REPORT_KINDS.has(kind) || !REPORT_REASONS.has(reason)) {
    return res.status(400).json({ msg: 'Choose a valid report type and reason' });
  }

  try {
    const target = kind === 'ai_response'
      ? await resolveAIReport({
        userId,
        conversationId: req.body?.conversationId,
        messageId: req.body?.messageId,
        content,
      })
      : await resolveMarketplaceReport(kind, req.body?.targetId);

    if (target.targetUser && userId && String(target.targetUser) === String(userId)) {
      return res.status(400).json({ msg: 'You cannot report your own content' });
    }

    const duplicateSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const duplicateQuery = {
      user: userId || null,
      'report.kind': kind,
      'report.sourceId': target.sourceId,
      createdAt: { $gte: duplicateSince },
    };
    const existing = userId
      ? await Complaint.findOne(duplicateQuery).select('_id status').lean()
      : null;
    if (existing) {
      return res.status(200).json({
        msg: 'You already reported this. Our safety team has it for review.',
        reportId: existing._id,
        duplicate: true,
      });
    }

    const snapshot = target.contentSnapshot || content;
    const complaint = await Complaint.create({
      user: userId || null,
      category: reportCategory(kind),
      subject: reportSubject(kind),
      message: details || `${reason.replace(/_/g, ' ')} report submitted for moderation.`,
      priority: ['harmful', 'illegal'].includes(reason) ? 'high' : 'medium',
      relatedProduct: target.relatedProduct || undefined,
      report: {
        kind,
        reason,
        details,
        sourceId: target.sourceId,
        conversationId: target.conversationId || null,
        messageId: target.messageId || null,
        contentSnapshot: snapshot,
        targetUser: target.targetUser || null,
        relatedReview: target.relatedReview || null,
        relatedStore: target.relatedStore || null,
        reporterType: userId ? 'account' : 'anonymous',
      },
    });

    return res.status(201).json({
      msg: 'Report submitted. Our safety team will review it.',
      reportId: complaint._id,
      duplicate: false,
    });
  } catch (error) {
    console.error('Create safety report error:', error.message);
    return res.status(error.statusCode || 500).json({ msg: error.statusCode ? error.message : 'Unable to submit report' });
  }
};

exports.listBlocks = async (req, res) => {
  try {
    const blocks = await UserBlock.find({ blocker: req.user.id })
      .sort({ createdAt: -1 })
      .populate({
        path: 'blocked',
        select: 'username avatar role',
        populate: { path: 'store', select: 'storeName storeSlug logo' },
      })
      .lean();
    return res.json({ blocks: blocks.filter(row => row.blocked) });
  } catch (error) {
    console.error('List user blocks error:', error.message);
    return res.status(500).json({ msg: 'Unable to load blocked accounts' });
  }
};

exports.createBlock = async (req, res) => {
  const blocker = req.user.id;
  const blocked = req.body?.userId;
  const source = ['seller', 'reviewer', 'user'].includes(req.body?.source) ? req.body.source : 'user';
  if (!validId(blocked)) return res.status(404).json({ msg: 'Account not found' });
  if (String(blocker) === String(blocked)) return res.status(400).json({ msg: 'You cannot block your own account' });

  try {
    const user = await User.findById(blocked).select('_id username role status').lean();
    if (!user || user.role === 'admin') return res.status(404).json({ msg: 'Account not found' });
    const block = await UserBlock.findOneAndUpdate(
      { blocker, blocked },
      { $set: { source } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
    return res.status(201).json({ msg: `${user.role === 'seller' ? 'Seller' : 'Account'} blocked`, block });
  } catch (error) {
    console.error('Create user block error:', error.message);
    return res.status(500).json({ msg: 'Unable to block this account' });
  }
};

exports.deleteBlock = async (req, res) => {
  if (!validId(req.params.userId)) return res.status(404).json({ msg: 'Account not found' });
  try {
    await UserBlock.deleteOne({ blocker: req.user.id, blocked: req.params.userId });
    return res.json({ msg: 'Account unblocked' });
  } catch (error) {
    console.error('Delete user block error:', error.message);
    return res.status(500).json({ msg: 'Unable to unblock this account' });
  }
};
