'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Store = require('../models/Store');
const ChatHistory = require('../models/ChatHistory');
const Preview = require('../models/AIStoreCurrencyPreview');
const { formatMoneySync } = require('./currencyService');
const { storeCurrencyChangeLimit, assertStoreCurrencyChangeAllowed, formatCurrencyChangeDate } = require('./storeCurrencyChangePolicy');
const {
  normalizeProductCurrency,
  ensureStoreProductCurrencyInitialized,
  buildProductCurrencyConversionPlan,
  commitProductCurrencyConversion,
} = require('./storeProductCurrencyService');

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const TOKEN_RE = /\baic1\.[a-f0-9]{64}\b/g;
const failure = (code, error) => ({ success: false, code, error, needsCurrencyPreview: true });
const money = (amount, currency) => {
  const value = formatMoneySync(amount, currency, { sourceCurrency: currency });
  return value.includes(currency) ? value : `${value} ${currency}`;
};

function isSingleStoreCurrencyRequest(text) {
  const value = String(text || '').replace(/\b(store|shop|brand)(?:'s)?\s+(?:product|pricing)\s+currency\b/gi, '$1 currency');
  return /\b(?:store|shop|brand)\b/i.test(value)
    && /\b(?:currency|USD|PKR|EUR|GBP|dollars?|rupees?|euros?|pounds?)\b/i.test(value)
    && /\b(?:change|switch|convert|preview|again|back|want)\b/i.test(value)
    // Do not consume a separate product/order/profile action or block an
    // individual foreign-currency price input during the store cooldown.
    && !/\b(?:products?|items?|listings?|prices?|stock|quantity|orders?|coupons?|shipping|description|image|name|email|profile)\b/i.test(value);
}

async function getStoreCurrencyCooldownReply(sellerId, role, text) {
  if (!sellerId || !['seller', 'admin'].includes(role) || !isSingleStoreCurrencyRequest(text)) return '';
  const store = await Store.findOne({ seller: sellerId })
    .select('productCurrency lastProductCurrencyChangeAt isActive').lean();
  if (!store || !store.productCurrency) return '';
  const currency = normalizeProductCurrency(store.productCurrency, null);
  const limit = storeCurrencyChangeLimit(store);
  if (store.isActive === false) return `Your store is blocked. Its product currency is ${currency}; no currency change was made.`;
  if (limit.canChange) return '';
  const codes = [...new Set((String(text).match(/\b(?:USD|PKR|EUR|GBP)\b/gi) || []).map(code => code.toUpperCase()))];
  const target = /\bto\s+(USD|PKR|EUR|GBP)\b/i.exec(text)?.[1]?.toUpperCase();
  if (target === currency || codes.length === 1 && codes[0] === currency) {
    return `Your store already uses ${currency}. No store currency or product prices were changed.`;
  }
  return `Your store currently uses ${currency}. You cannot change its currency again until ${formatCurrencyChangeDate(limit.nextAllowedAt)} because a completed change starts a ${limit.cooldownDays}-day waiting period. You can still give me an individual product price in another supported currency; I will convert and save it in ${currency} and show both amounts. No store-wide change was made.`;
}

function isCurrencyChangeConfirmation(text, targetCurrency, sourceCurrency) {
  const value = String(text || '').trim();
  if (!value || /[?？]|\b(?:no|not|don't|dont|do not|cancel|stop|wait|instead|but|unless|maybe|later|explain|what|why|how|when|which|tell me|show me|can you|could you|would you|nahi|nahin|mat|ruk)\b/i.test(value)) return false;
  if (/\b(?:only|just)\s+(?:this|that|one|the)\s+(?:product|item|price)\b|\b(?:single product|individual product|product price|stock|quantity)\b/i.test(value)) return false;
  const aliases = [
    ['USD', /\b(?:USD|US dollars?|dollars?)\b|\$/i],
    ['PKR', /\b(?:PKR|Pakistani rupees?|rupees?|rupey|rupay|Rs)\b/i],
    ['EUR', /\b(?:EUR|euros?)\b|€/i],
    ['GBP', /\b(?:GBP|British pounds?|pounds?|sterling)\b|£/i],
    ['CAD', /\b(?:CAD|Canadian dollars?)\b/i], ['JPY', /\b(?:JPY|yen)\b/i],
    ['AUD', /\b(?:AUD|Australian dollars?)\b/i], ['INR', /\b(?:INR|Indian rupees?)\b/i],
    ['AED', /\b(?:AED|dirhams?)\b/i],
  ];
  const mentioned = aliases.filter(([, pattern]) => pattern.test(value)).map(([code]) => code);
  const sourcePattern = aliases.find(([code]) => code === sourceCurrency)?.[1];
  const targetPattern = aliases.find(([code]) => code === targetCurrency)?.[1];
  const confirmsDirection = sourcePattern && targetPattern && new RegExp(
    `(?:${sourcePattern.source})(?:\\s+(?:store|product|pricing|currency)){0,3}\\s+to\\s+(?:${targetPattern.source})`, 'i'
  ).test(value);
  // Mentioning the original currency is valid in "from PKR to USD". It must
  // not make a clear confirmation fail, nor allow the reversed direction.
  if (mentioned.some(code => code !== targetCurrency && !(confirmsDirection && code === sourceCurrency))) return false;
  return /^(?:yes|yep|yeah|confirm(?:ed)?|approve(?:d)?|go ahead|proceed|do it|sure|ok(?:ay)?|haan|han|ji|theek hai)\b/i.test(value)
    || Boolean(confirmsDirection && /^(?:please\s+)?(?:change|switch|convert)\b/i.test(value))
    || /^(?:please\s+)?(?:change|switch|convert)\s+(?:my\s+|the\s+)?(?:whole\s+|entire\s+)?store(?:'s)?\s+(?:product\s+)?currency\s+to\s+(?:USD|PKR|EUR|GBP)\b/i.test(value);
}

async function previousPreviewToken(messages, { userId, conversationId } = {}) {
  // Only the latest assistant turn may supply approval context. Do not borrow
  // an old quote when "yes" actually answers an unrelated intervening question.
  const previous = [...(messages || [])].reverse().find(message => message?.role === 'assistant');
  const tokens = [...new Set(String(previous?.content || '').match(TOKEN_RE) || [])];
  if (tokens.length === 1) return tokens[0];
  if (tokens.length > 1) return null;
  if (!mongoose.Types.ObjectId.isValid(String(conversationId || ''))) return null;
  // Backward-compatible with installed clients that do not yet copy this new
  // tool's token into their summaries. Read only this actor's selected chat.
  const history = await ChatHistory.findOne({ user: userId, 'conversations._id': conversationId })
    .select('conversations').lean();
  const conversation = history?.conversations?.find(item => String(item._id) === String(conversationId));
  const saved = [...(conversation?.messages || [])].reverse().find(message => message.role === 'assistant');
  const previews = (saved?.toolEvents || []).filter(event => event.tool === 'preview_store_currency_change' && event.result?.success && event.result?.data?.quoteToken);
  return previews.length === 1 ? previews[0].result.data.quoteToken : null;
}

async function previewStoreCurrencyChange(sellerId, args = {}) {
  const targetCurrency = normalizeProductCurrency(args.currency, null);
  const requestKey = String(args._chatRequestKey || '');
  if (!requestKey) return failure('AI_CURRENCY_REQUEST_REQUIRED', 'Please retry this currency preview from your current chat.');
  const state = await ensureStoreProductCurrencyInitialized(sellerId);
  if (!state.hasStore) return failure('STORE_NOT_FOUND', 'Create your store before changing its product currency.');
  const store = await Store.findOne({ seller: sellerId });
  if (targetCurrency === state.activeCurrency && state.status === 'active') {
    return { success: true, data: { productCurrency: state, unchanged: true }, message: `Your store already uses ${targetCurrency}. No store currency or product prices were changed.` };
  }
  const limit = assertStoreCurrencyChangeAllowed(store);
  if (state.status === 'pending_conversion' && state.pendingCurrency !== targetCurrency) {
    return failure('STORE_CURRENCY_PENDING', `Your store already has a pending change to ${state.pendingCurrency}. Finish or cancel it in Store Settings before choosing ${targetCurrency}. No new change was made.`);
  }
  const plan = await buildProductCurrencyConversionPlan(sellerId, store, targetCurrency);
  const count = plan.operations.length;
  const examples = plan.examples.map(example => `${example.name}: ${money(example.fromPrice, example.fromCurrency)} → ${money(example.toPrice, targetCurrency)}${example.fromDiscountedPrice > 0 ? `; sale price ${money(example.fromDiscountedPrice, example.fromDiscountedCurrency)} → ${money(example.toDiscountedPrice, targetCurrency)}` : ''}`);
  const notice = [
    `Change your store product currency from ${state.activeCurrency} to ${targetCurrency}?`,
    `${count} existing product${count === 1 ? '' : 's'}${count ? ', including regular and sale prices, will be converted and saved' : '; new products will be saved'} in ${targetCurrency}.`,
    ...examples,
    `This is a long-term pricing choice: after it completes, you cannot change store currency again for ${limit.cooldownDays} days.`,
    'Past orders and balances stay unchanged. Shipping, tax and coupon settings keep their own saved currencies.',
    'These conversion prices are held for 10 minutes. No store currency or product prices have changed yet. Confirm this store-wide change, or say no to keep your current store currency.',
  ].join('\n');
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  const token = `aic1.${crypto.randomBytes(32).toString('hex')}`;
  await Preview.create({
    token, seller: sellerId, requestKey, targetCurrency, sourceCurrency: state.activeCurrency,
    plan, notice, cooldownDays: limit.cooldownDays, expiresAt,
    purgeAt: new Date(Date.now() + 30 * 86400000),
  });
  return {
    success: true, previewOnly: true, requiresConfirmation: true,
    data: { quoteToken: token, targetCurrency, sourceCurrency: state.activeCurrency, productCount: count, cooldownDays: limit.cooldownDays, examples: plan.examples, expiresAt: expiresAt.toISOString() },
    message: notice, requiredDisclosure: notice,
  };
}

async function changeStoreCurrency(sellerId, args = {}) {
  const token = await previousPreviewToken(args._imageContextMessages, { userId: sellerId, conversationId: args._chatConversationId });
  if (!token) return failure('AI_CURRENCY_PREVIEW_REQUIRED', 'Please review a store-currency change preview first. Your store currency and products are unchanged.');
  const preview = await Preview.findOne({ token, seller: sellerId });
  if (!preview) return failure('AI_CURRENCY_PREVIEW_INVALID', 'That currency preview could not be verified for your store. Please request a fresh preview.');
  if (!isCurrencyChangeConfirmation(args._lastUserText, preview.targetCurrency, preview.sourceCurrency)) {
    return failure('AI_CURRENCY_CONFIRMATION_REQUIRED', 'No store-wide change was made. Please explicitly confirm the reviewed currency change, or ask your question before deciding.');
  }
  if (args.currency !== undefined && normalizeProductCurrency(args.currency, null) !== preview.targetCurrency) {
    return failure('AI_CURRENCY_TARGET_CHANGED', 'That is a different target currency. Please review a new conversion preview before confirming.');
  }
  if (!args._chatRequestKey || preview.requestKey === args._chatRequestKey) {
    return failure('AI_CURRENCY_CONFIRMATION_REQUIRED', 'Show the preview and wait for the seller to confirm in their next message. No store-wide change was made.');
  }
  if (preview.status === 'committed') return { ...preview.result, replayed: true };
  if (preview.expiresAt.getTime() <= Date.now()) return failure('AI_CURRENCY_PREVIEW_EXPIRED', 'That currency preview expired. No prices were changed. Please review fresh conversion prices and confirm again.');
  try {
    const store = await Store.findOne({ seller: sellerId });
    if (!store) return failure('STORE_NOT_FOUND', 'Your store was not found.');
    const limit = assertStoreCurrencyChangeAllowed(store);
    if (limit.cooldownDays !== preview.cooldownDays) return failure('AI_CURRENCY_POLICY_CHANGED', 'The currency change waiting period changed. Please review a fresh preview before confirming.');
    return await commitProductCurrencyConversion(sellerId, preview.plan, {
      afterWrite: async session => {
        const updated = await Store.findOne({ seller: sellerId }).session(session);
        const changeLimit = storeCurrencyChangeLimit(updated);
        const message = `Your store product currency is now ${preview.targetCurrency}. Converted and saved ${preview.plan.operations.length} existing product(s), including sale prices. You can change store currency again on ${formatCurrencyChangeDate(changeLimit.nextAllowedAt)} after the ${changeLimit.cooldownDays}-day waiting period. Past orders and balances are unchanged.`;
        const result = {
          success: true,
          data: { currency: preview.targetCurrency, previousCurrency: preview.sourceCurrency, converted: preview.plan.operations.length, changeLimit },
          message, requiredDisclosure: message,
        };
        const saved = await Preview.updateOne({ _id: preview._id, seller: sellerId, status: 'quoted', expiresAt: { $gt: new Date() } }, { $set: { status: 'committed', committedAt: new Date(), result } }, { session });
        if (saved.matchedCount !== 1) {
          const error = new Error('This currency preview expired or was already processed. Refresh to see the current store currency.');
          error.code = 'AI_CURRENCY_PREVIEW_CONFLICT'; error.status = 409; throw error;
        }
        return result;
      },
    });
  } catch (error) {
    // A concurrent confirmation may have completed while this transaction
    // retried. Reuse that exact committed result, never convert a second time.
    const committed = await Preview.findOne({ _id: preview._id, seller: sellerId, status: 'committed' }).lean();
    if (committed?.result) return { ...committed.result, replayed: true };
    throw error;
  }
}

module.exports = { previewStoreCurrencyChange, changeStoreCurrency, previousPreviewToken, isCurrencyChangeConfirmation, getStoreCurrencyCooldownReply, isSingleStoreCurrencyRequest, PREVIEW_TTL_MS };
