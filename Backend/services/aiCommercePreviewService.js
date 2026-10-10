'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Preview = require('../models/AICommercePreview');
const History = require('../models/ChatHistory');
const TTL = 10 * 60 * 1000;
const canonical = value => {
  if (value?.toJSON) return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (code, error) => ({ success: false, code, error });

function isCommerceConfirmation(text = '') {
  const value = String(text).trim();
  if (!value || value.length > 1200 || /[?？؟]|\b(?:no|not|don't|dont|do not|never|stop|wait|later|instead|unless|but|maybe|review|preview|explain|what|why|how|when|which|show|view|find|search|list|read|check|get|tell|see|look|help|browse|recommend|suggest|can|could|would|dikhao|batao|ignore|bypass|skip|force|nahi|nahin|mat|ruk)\b|(?:نہیں|رکو|مت کریں|نہ کریں|کیوں|کیا|دکھا|بتا|دیکھ|नहीं|मत करो|रुको|क्यों|दिखा|बताओ|देख)/i.test(value)) return false;
  return /^(?:yes|yep|yeah|confirm(?:ed)?|approve(?:d)?|go ahead|proceed|do it|sure|ok(?:ay)?|haan|han|ji|theek hai)\b/i.test(value)
    || /^(?:ہاں|جی|ٹھیک ہے|تصدیق|हाँ|हां|जी)(?:\s|$|[،,.!])/u.test(value)
    || /^(?:please\s+)?(?:confirm|submit|request|accept|cancel|withdraw|approve|mark|update)\b/i.test(value);
}

function confirmationMatchesPreview(text, preview) {
  const value = String(text || '').replace(/[٠-٩۰-۹०-९]/gu, digit => {
    const code = digit.charCodeAt(0); return String(code - (code >= 0x0966 ? 0x0966 : code >= 0x06f0 ? 0x06f0 : 0x0660));
  }).replace(/٫/gu, '.').replace(/٬/gu, ',');
  const references = value.match(/\b(?:ORD|RET)-[a-z0-9-]+\b/gi) || [];
  const expectedReference = preview.contract.publicOrderId || preview.contract.returnNumber;
  if (references.length && (!expectedReference || references.some(reference => reference.toLowerCase() !== String(expectedReference).toLowerCase()))) return false;
  if (/\b(?:only|just)\s+(?:\d+|one|two|three|four|five|this item|that item|one seller)\b/i.test(value)) return false;
  if (/\b(?:withdraw|withdrawal|payout)\b/i.test(value) && preview.action !== 'request_withdrawal') return false;
  if (/\bcancel(?:lation)?\b/i.test(value) && !['cancel_order', 'cancel_return'].includes(preview.action)) return false;
  if (/\brefund\b/i.test(value) && !['cancel_order', 'request_return', 'accept_return'].includes(preview.action)) return false;
  if (/\b(?:subscription|subdomain|coupon|profile|wishlist|cart|password|address)\b/i.test(value)) return false;
  if (/\breturn[ -]request\b/i.test(value) && !['request_return', 'cancel_return', 'update_return_status', 'accept_return'].includes(preview.action)) return false;
  if (preview.action === 'cancel_order') {
    if (/\bwallet\b|والٹ/iu.test(value) && preview.input.refundDestination !== 'wallet') return false;
    if (/\b(?:card|bank refund|original payment)\b|کارڈ/iu.test(value) && preview.input.refundDestination !== 'original_card') return false;
  }
  if (preview.action === 'accept_return') {
    if (/\bsafepay\b/iu.test(value) && preview.input.fundingSource !== 'safepay') return false;
    if (/\b(?:held|pending)\b/iu.test(value) && preview.input.fundingSource !== 'held_order') return false;
    if (/\b(?:earnings|seller balance|available balance)\b/iu.test(value) && preview.input.fundingSource !== 'seller_balance') return false;
  }
  if (preview.action === 'request_return') {
    // Broader item selection is a new review, never an implied change to the
    // saved quote if the model forgets to pass the changed item arguments.
    if (/\b(?:all|both|every|entire)\b.{0,25}\b(?:items?|products?|order)\b/iu.test(value)) return false;
    const quantities = [...value.matchAll(/\b(\d+|one|two|three|four|five)\s+(?:units?|items?|products?)\b/giu)]
      .map(match => ({ one: 1, two: 2, three: 3, four: 4, five: 5 }[match[1].toLowerCase()] || Number(match[1])));
    const expectedQuantity = (preview.input.items || []).reduce((sum, item) => sum + item.quantity, 0);
    if (quantities.some(quantity => quantity !== expectedQuantity)) return false;
  }
  if (preview.action === 'request_withdrawal') {
    if (preview.contract.similarRequestIds?.length && !/\b(?:another|new|additional|second|naya|dobara)\b|ایک اور/iu.test(value)) return false;
  }
  if (preview.action === 'request_withdrawal' || preview.action === 'cancel_order' && preview.input.refundDestination !== 'none'
      || preview.action === 'accept_return' && preview.input.fundingSource !== 'none') {
    const option = preview.contract.options?.find(row => row.destination === preview.input.refundDestination);
    const amount = preview.action === 'request_withdrawal' ? preview.input.amount
      : preview.action === 'accept_return' ? preview.contract.refund?.totalAmount : option?.amountMinor / 100;
    const currency = preview.action === 'request_withdrawal' ? preview.input.currency : preview.contract.currency;
    const amounts = (value.replace(/\b(?:ORD|RET)-[a-z0-9-]+\b/gi, '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(number => Number(number.replace(/,/g, '')));
    if (amounts.some(given => given !== amount)) return false;
    const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000 };
    if ([...value.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand)\b/gi)]
      .some(match => numberWords[match[1].toLowerCase()] !== amount)) return false;
    const currencies = value.match(/\b(?:USD|PKR|EUR|GBP)\b/gi) || [];
    if (currencies.some(given => given.toUpperCase() !== currency)) return false;
    const aliases = [['USD', /\$|\b(?:US dollars?|dollars?)\b|ڈالر/i], ['PKR', /\b(?:Rs|rupees?)\b|روپے/i],
      ['EUR', /€|\beuros?\b|یورو/i], ['GBP', /£|\bpounds?\b|پاؤنڈ/i]];
    if (aliases.some(([given, pattern]) => pattern.test(value) && given !== currency)
      || /\b(?:CAD|AUD|INR|AED|JPY|SAR|Canadian|Australian|Indian rupees?|dirhams?|yen)\b|₹/i.test(value)) return false;
  }
  if (preview.action === 'update_order_status') {
    const statuses = value.match(/\b(?:confirmed|processing|shipped|delivered|cancelled|canceled)\b/gi) || [];
    if (statuses.some(status => status.toLowerCase() !== preview.input.newStatus)) return false;
  }
  if (preview.action === 'update_return_status') {
    const statuses = [['approved', /\bapprov(?:e|ed)\b/i], ['rejected', /\breject(?:ed)?\b/i],
      ['pickup_scheduled', /\b(?:pickup scheduled|schedule pickup|pickup_scheduled)\b/i], ['picked_up', /\b(?:picked up|picked_up)\b/i],
      ['in_transit_to_seller', /\b(?:in transit|in_transit_to_seller)\b/i], ['received_by_seller', /\b(?:received|received_by_seller)\b/i],
      ['under_review', /\b(?:under review|under_review)\b/i]];
    if (statuses.some(([status, pattern]) => pattern.test(value) && status !== preview.input.status)) return false;
  }
  return true;
}

// Approval context comes ONLY from this actor's last persisted assistant
// turn, never a client/model-supplied tool memory or an old unrelated quote.
async function retainedServerReviewEvent(user, args) {
  const userId = String(user?._id || user?.id || '');
  const conversationId = String(args._chatConversationId || '');
  if (!mongoose.isValidObjectId(conversationId)) return null;
  const history = await History.findOne({ user: userId, 'conversations._id': conversationId }).select('conversations').lean();
  const conversation = history?.conversations?.find(item => String(item._id) === conversationId);
  const last = [...(conversation?.messages || [])].reverse().find(message => message.role === 'assistant');
  const candidates = (last?.toolEvents || []).filter(event => event.result?.previewOnly === true
    && typeof event.result?.data?.quoteToken === 'string' && event.result.data.quoteToken.length > 0);
  const tokens = [...new Set(candidates.map(event => event.result.data.quoteToken))];
  if (tokens.length !== 1) return null;
  return candidates.find(event => event.result.data.quoteToken === tokens[0]);
}
async function previousCommercePreview(user, args, action = null) {
  const retained = await retainedServerReviewEvent(user, args);
  if (!/^aif1\.[a-f0-9]{64}$/.test(retained?.result?.data?.quoteToken || '')) return null;
  const userId = String(user?._id || user?.id || '');
  const conversationId = String(args._chatConversationId || '');
  const tokens = [retained.result.data.quoteToken];
  return Preview.findOne({ token: tokens[0], user: userId, role: user.role, ...(action ? { action } : {}),
    $or: [{ conversation: conversationId }, { conversation: null }] });
}

async function createCommercePreview(action, prepared, user, args) {
  const requestKey = String(args._chatRequestKey || '');
  if (!requestKey || requestKey.length > 240) return fail('AI_COMMERCE_REQUEST_REQUIRED', 'Please review this action from your current signed-in chat. No action was performed.');
  const unresolved = await Preview.findOne({ user: user._id || user.id, action, status: 'processing' }).lean();
  if (unresolved) {
    if (action === 'request_withdrawal') {
      const recorded = await require('../models/SellerWithdrawalRequest').findOne({ seller: user._id || user.id,
        idempotencyKey: 'ai-commerce:' + unresolved.token.slice(5), balanceVersion: 2,
        amount: unresolved.input.amount, currency: unresolved.input.currency,
        requestedAmount: unresolved.input.amount, requestedCurrency: unresolved.input.currency }).lean();
      if (recorded) {
        const result = { success: true, replayed: true, data: { withdrawalId: String(recorded._id),
          amount: recorded.amount, currency: recorded.currency, status: recorded.status },
          message: `Your previously confirmed withdrawal request for ${recorded.amount.toFixed(2)} ${recorded.currency} already exists (recorded status: ${recorded.status}). No new withdrawal was submitted and no bank transfer was performed by chat.` };
        await Preview.updateOne({ _id: unresolved._id, status: 'processing' }, { $set: { status: 'completed', result, completedAt: new Date() } });
        return result;
      }
    }
    return fail('AI_COMMERCE_ACTION_PENDING', 'A previous reviewed action of this type has an uncertain outcome. Check its current status before submitting another. No new action was performed.');
  }
  const conversationId = String(args._chatConversationId || '');
  if (conversationId && !mongoose.isValidObjectId(conversationId)) return fail('AI_COMMERCE_CONVERSATION_INVALID', 'Please reopen your current chat and review this action again.');
  if (conversationId && !await History.exists({ user: user._id || user.id, 'conversations._id': conversationId })) {
    return fail('AI_COMMERCE_CONVERSATION_INVALID', 'This chat does not belong to your account. No action was performed.');
  }
  const identity = { user: user._id || user.id, action, requestKey, fingerprint: digest({ input: prepared.input, contract: prepared.contract }) };
  let row;
  try { row = await Preview.findOneAndUpdate(identity, { $setOnInsert: { token: 'aif1.' + crypto.randomBytes(32).toString('hex'),
    user: user._id || user.id, role: user.role, conversation: conversationId || null, action, requestKey,
    fingerprint: identity.fingerprint,
    input: canonical(prepared.input), contract: canonical(prepared.contract), notice: prepared.notice,
    expiresAt: new Date(Date.now() + TTL) } }, { upsert: true, new: true, runValidators: true }); }
  catch (error) { if (error.code !== 11000) throw error; row = await Preview.findOne(identity); }
  return { success: true, previewOnly: true, requiresConfirmation: true,
    message: `${row.notice}\nReview these details and confirm in your next message. Nothing has been submitted or refunded yet.`,
    data: { quoteToken: row.token, action, request: prepared.input,
      commercePreview: { title: prepared.title, notice: prepared.notice, action, expiresAt: row.expiresAt,
        ...(prepared.options ? { options: prepared.options } : {}) },
      ...(prepared.data || {}) } };
}

async function executeReviewedCommerceAction(action, args, user, { prepare, execute }) {
  const preview = args.confirm === true ? await previousCommercePreview(user, args, action) : null;
  if (!preview) return createCommercePreview(action, await prepare(action, args, user), user, args);
  if (!isCommerceConfirmation(args._lastUserText)) {
    return fail('AI_COMMERCE_CONFIRMATION_REQUIRED', 'No action was performed. Please explicitly confirm the reviewed action, or tell me what to change. Questions and refusals are not confirmation.');
  }
  if (!confirmationMatchesPreview(args._lastUserText, preview)) return fail('AI_COMMERCE_CONFIRMATION_CHANGED', 'Your message changes the reviewed amount, currency, reference, items or status. Nothing was submitted. Ask for an updated preview and confirm that instead.');
  if (preview.requestKey === args._chatRequestKey) return fail('AI_COMMERCE_CONFIRMATION_REQUIRED', 'Review the preview first and confirm in a subsequent message. No action was performed.');
  if (preview.status === 'completed') return { ...preview.result, replayed: true, originallyCompletedAt: preview.completedAt };
  if (preview.status !== 'quoted') return fail('AI_COMMERCE_ACTION_PENDING', 'This reviewed action is already being processed or needs recovery. Check its current status; do not submit another action.');
  if (preview.expiresAt.getTime() <= Date.now()) {
    const refreshed = await prepare(action, { ...preview.input, ...args }, user);
    refreshed.notice = 'Your previous review expired. Nothing was submitted. Review these refreshed details and confirm again.\n' + refreshed.notice;
    return createCommercePreview(action, refreshed, user, args);
  }
  const current = await prepare(action, { ...preview.input, ...args }, user);
  if (digest(current.contract) !== digest(preview.contract) || digest(current.input) !== digest(preview.input)) {
    current.notice = 'The details changed since your previous review. Nothing was submitted. Review these updated details and confirm again.\n' + current.notice;
    return createCommercePreview(action, current, user, args);
  }
  const claimed = await Preview.findOneAndUpdate({ _id: preview._id, user: user._id || user.id, status: 'quoted',
    expiresAt: { $gt: new Date() } }, { $set: { status: 'processing' } }, { new: true });
  if (!claimed) return fail('AI_COMMERCE_ACTION_PENDING', 'This action is already being processed. Check its current status before trying again.');
  try {
    // The same canonical service/transaction as web and mobile revalidates
    // ownership, inventory, shipment status, funding and balances at commit.
    const result = JSON.parse(JSON.stringify(await execute(action, claimed.input, user, claimed)));
    if (result.uncertain) return fail('AI_COMMERCE_ACTION_PENDING', 'The result could not be confirmed. Check the order, return or withdrawal before submitting again; this action will not be replayed automatically.');
    const updated = await Preview.updateOne({ _id: claimed._id, status: 'processing' },
      { $set: { status: result.success === true ? 'completed' : 'failed', result, completedAt: new Date() } });
    if (updated.matchedCount !== 1) throw new Error('Preview receipt not persisted');
    return result;
  } catch (error) {
    // Do not release a claim after an ambiguous commit or transport failure.
    // An operator can inspect it, but a retry cannot duplicate financial work.
    if (error.statusCode >= 400 && error.statusCode < 500 && error.code !== 'UNKNOWN_TRANSACTION_COMMIT_RESULT') {
      const result = fail(error.code || 'AI_COMMERCE_REJECTED', error.message);
      await Preview.updateOne({ _id: claimed._id, status: 'processing' }, { $set: { status: 'failed', result } });
      return result;
    }
    return fail('AI_COMMERCE_ACTION_PENDING', 'This action may have completed but its result is not confirmed. Check the current status. It will not be automatically executed again.');
  }
}

module.exports = { TTL, canonical, digest, isCommerceConfirmation, previousCommercePreview, retainedServerReviewEvent,
  confirmationMatchesPreview, createCommercePreview, executeReviewedCommerceAction };
