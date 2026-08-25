'use strict';

const {
  ensureProductBlockedNotification,
} = require('./sellerOperationalNotificationService');

const PLACEHOLDER_PHRASES = new Set([
  'test',
  'testing',
  'test product',
  'dummy',
  'dummy product',
  'sample',
  'sample product',
  'demo',
  'demo product',
  'fake',
  'fake product',
  'product',
  'new product',
  'asdf',
  'qwerty',
  'abc',
  'abcd',
  'abcde',
  'hello',
  'hello so',
  'hi',
  'ok',
  'okay',
  'nice',
  'good',
  'very good',
  'lorem ipsum',
]);

const PLACEHOLDER_WORDS = new Set([
  'test',
  'testing',
  'dummy',
  'sample',
  'demo',
  'fake',
  'placeholder',
  'product',
  'item',
  'listing',
  'new',
  'asdf',
  'qwerty',
  'abc',
  'hello',
  'hi',
  'ok',
  'okay',
  'nice',
  'good',
  'random',
  'lorem',
  'ipsum',
]);

const REAL_PRODUCT_HINTS = new Set([
  'toy',
  'cart',
  'shirt',
  'shoe',
  'shoes',
  'bag',
  'watch',
  'dress',
  'phone',
  'case',
  'cover',
  'cream',
  'oil',
  'soap',
  'bottle',
  'book',
  'perfume',
  'chair',
  'table',
  'lamp',
  'kids',
  'baby',
  'men',
  'women',
  'cotton',
  'leather',
  'wood',
  'steel',
  'plastic',
]);

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const tokensOf = (value) => normalize(value).split(' ').filter(Boolean);

const alphaOnly = (value) => String(value || '').toLowerCase().replace(/[^a-z]/g, '');

function longestConsonantRun(word) {
  const runs = word.match(/[^aeiou\s\d]{3,}/g) || [];
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

function hasProductHint(tokens) {
  return tokens.some(token => REAL_PRODUCT_HINTS.has(token));
}

function isKeyboardOrRandomToken(token) {
  const word = alphaOnly(token);
  if (word.length < 5) return false;

  if (/^(.)\1{4,}$/.test(word)) return true;

  const vowels = (word.match(/[aeiou]/g) || []).length;
  const rare = (word.match(/[jqxzkv]/g) || []).length;
  const vowelRatio = vowels / word.length;
  const rareRatio = rare / word.length;
  const consonantRun = longestConsonantRun(word);
  const uniqueRatio = new Set(word.split('')).size / word.length;

  if (vowels === 0 && word.length >= 6) return true;
  if (consonantRun >= 5) return true;
  if (rareRatio >= 0.28 && consonantRun >= 3) return true;
  if (vowelRatio < 0.18 && consonantRun >= 4) return true;
  if (word.length >= 8 && rareRatio >= 0.2 && uniqueRatio >= 0.65) return true;

  return false;
}

function looksLikeGibberish(value) {
  const tokens = tokensOf(value).filter(token => /[a-z]/.test(token));
  if (!tokens.length) return false;

  const meaningfulTokens = tokens.filter(token => alphaOnly(token).length >= 2);
  if (!meaningfulTokens.length) return false;

  const longTokens = meaningfulTokens.filter(token => alphaOnly(token).length >= 5);
  const randomLongTokens = longTokens.filter(isKeyboardOrRandomToken);

  if (randomLongTokens.length && randomLongTokens.length === longTokens.length && meaningfulTokens.length <= 3) {
    return true;
  }

  const letters = alphaOnly(value);
  if (letters.length >= 8 && letters.length <= 30) {
    const randomTokens = meaningfulTokens.filter(isKeyboardOrRandomToken);
    return randomTokens.length >= Math.ceil(meaningfulTokens.length * 0.6);
  }

  return false;
}

function looksLikePlaceholder(value, { allowProductHints = false } = {}) {
  const text = normalize(value);
  if (!text) return true;
  if (PLACEHOLDER_PHRASES.has(text)) return true;

  const tokens = tokensOf(value);
  if (!tokens.length) return true;

  if (allowProductHints && hasProductHint(tokens)) return false;

  const nonNumericTokens = tokens.filter(token => !/^\d+$/.test(token));
  if (
    nonNumericTokens.length > 0 &&
    nonNumericTokens.length <= 3 &&
    nonNumericTokens.every(token => PLACEHOLDER_WORDS.has(token))
  ) {
    return true;
  }

  if (tokens.length <= 2 && tokens.every(token => token.length <= 2 || PLACEHOLDER_WORDS.has(token))) {
    return true;
  }

  return false;
}

function moderateProductAuthenticity(product = {}) {
  const name = product.name || '';
  const description = product.description || '';
  const reasons = [];
  const signals = [];

  if (looksLikePlaceholder(name, { allowProductHints: false })) {
    reasons.push('the product name looks like test or placeholder text');
    signals.push('placeholder_name');
  } else if (looksLikeGibberish(name)) {
    reasons.push('the product name looks like random text');
    signals.push('gibberish_name');
  }

  if (looksLikePlaceholder(description, { allowProductHints: true })) {
    reasons.push('the product description looks like test or placeholder text');
    signals.push('placeholder_description');
  } else if (looksLikeGibberish(description)) {
    reasons.push('the product description looks like random text');
    signals.push('gibberish_description');
  }

  const blocked = reasons.length > 0;
  return {
    blocked,
    status: blocked ? 'blocked' : 'approved',
    reason: blocked ? reasons.join('; ') : '',
    signals,
  };
}

function buildModerationFields(product = {}, { previouslyBlocked = false } = {}) {
  const result = moderateProductAuthenticity(product);
  const reviewedAt = new Date();

  let moderationNotice;
  if (result.blocked && !previouslyBlocked) {
    moderationNotice = {
      reviewedAt,
      productName: String(product?.name || 'Your product').trim().slice(0, 200),
      reason: String(result.reason || 'it looks like test or placeholder content').trim().slice(0, 600),
      notificationEnqueuedAt: null,
    };
  } else if (!result.blocked) {
    moderationNotice = {
      reviewedAt: null,
      productName: '',
      reason: '',
      notificationEnqueuedAt: reviewedAt,
    };
  }

  return {
    result,
    fields: {
      isBlocked: result.blocked,
      blockedAt: result.blocked ? reviewedAt : null,
      blockedReason: result.reason,
      moderationStatus: result.status,
      moderationReason: result.reason,
      moderationSignals: result.signals,
      moderationReviewedAt: reviewedAt,
      ...(moderationNotice ? { moderationNotice } : {}),
    },
  };
}

function publicProductFilter(extra = {}) {
  return {
    ...extra,
    isBlocked: { $ne: true },
    moderationStatus: { $ne: 'blocked' },
  };
}

function isProductBlocked(product = {}) {
  return product?.isBlocked === true || product?.moderationStatus === 'blocked';
}

async function notifyProductBlocked({ sellerId, product }) {
  if (!sellerId || !product || !isProductBlocked(product)) return;
  return ensureProductBlockedNotification(product, { stageIfMissing: true });
}

module.exports = {
  buildModerationFields,
  isProductBlocked,
  moderateProductAuthenticity,
  notifyProductBlocked,
  publicProductFilter,
};
