'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const POLICY_VERSION = 'catalog-safety-2026-09-v1';
const HOLD_STATUSES = ['pending', 'blocked'];
const POLICY_CODES = ['profanity', 'sexual_goods', 'explicit_sexual_content', 'hate_or_threats', 'insufficient_details', 'image_invalid', 'content_limit'];
const PRODUCT_INPUT_FIELDS = new Set([
  'name', 'description', 'category', 'brand', 'tags', 'colors', 'optionGroups', 'image', 'images',
  'price', 'discountedPrice', 'priceCurrency', 'discountedPriceCurrency', 'discountedCurrency', 'currency',
  'stock', 'isFeatured', 'returnPolicy',
]);
const PRODUCT_CONTENT_FIELDS = ['name', 'description', 'category', 'brand', 'tags', 'colors', 'optionGroups', 'image', 'images', 'returnPolicy'];
const STORE_CONTENT_FIELDS = ['storeName', 'storeSlug', 'description', 'logo', 'banner', 'returnPolicy'];

// New submissions/edits are always managed. Reviewing the existing catalog is
// an explicit rollout choice because it temporarily removes unreviewed rows.
const reviewExistingCatalog = () => process.env.CATALOG_REVIEW_EXISTING === 'true';
const publicContentClause = () => {
  const approved = { moderationStatus: 'approved', moderationPolicyVersion: POLICY_VERSION, moderationReviewedAt: { $type: 'date' } };
  return reviewExistingCatalog() ? approved : { $or: [approved, {
    moderationPolicyVersion: { $in: ['', null] }, moderationStatus: { $in: ['approved', null] },
  }] };
};
const isContentHeld = entity => HOLD_STATUSES.includes(entity?.moderationStatus);
const isContentApproved = entity => Boolean(entity) && ((entity.moderationStatus === 'approved' && entity.moderationPolicyVersion === POLICY_VERSION
  && Boolean(entity.moderationReviewedAt) && Number.isFinite(new Date(entity.moderationReviewedAt).getTime())
  || !reviewExistingCatalog() && !entity.moderationPolicyVersion && [undefined, null, 'approved'].includes(entity.moderationStatus)));
const pickProductInput = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  .filter(([field]) => PRODUCT_INPUT_FIELDS.has(field)));

function normalizeForSafety(value) {
  const confusables = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'ј': 'j', 'к': 'k', 'υ': 'u' };
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/&#(?:x([a-f\d]+)|(\d+));?/gi, (_, hex, dec) => {
      const code = parseInt(hex || dec, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[аеорсхіјкυ]/g, char => confusables[char])
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[013457@$]/g, char => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', '$': 's' }[char]));
}

const bounded = expression => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${expression})(?=$|[^\\p{L}\\p{N}])`, 'iu');
// Deliberately narrow high-confidence rules. Context-sensitive words such as
// "sex", "breast", "cocktail" and industrial "vibrator" are NOT word-banned.
const SEVERE_LANGUAGE = bounded('f[\\W_]{0,3}(?:u|\\*)[\\W_]{0,3}c?[\\W_]{0,3}k(?:ing|er|ers|ed|s)?|mother[\\W_]{0,3}fuck(?:er|ers|ing)?|s[\\W_]{0,3}h[\\W_]{0,3}i[\\W_]{0,3}t(?:ty|ting|s)?|c[\\W_]{0,3}u[\\W_]{0,3}n[\\W_]{0,3}t(?:s)?|asshole(?:s)?|madarchod|bhenchod|behenchod|chutiya');
const SEXUAL_GOODS = bounded('sex[\\s_-]*toys?|sex[\\s_-]*dolls?|dildos?|fleshlights?|masturbators?|butt[\\s_-]*plugs?|anal[\\s_-]*beads?');

function publicImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
    if (net.isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return false;
    return value.length <= 2048;
  } catch (_) { return false; }
}

function contentSnapshot(kind, entity = {}) {
  const text = [];
  const addText = (field, value) => {
    if (typeof value === 'string' && value.trim()) text.push({ field, value: value.trim() });
  };
  if (kind === 'product') {
    for (const key of ['name', 'description', 'category', 'brand']) addText(key, entity[key]);
    for (const key of ['tags', 'colors']) (Array.isArray(entity[key]) ? entity[key] : []).forEach((value, i) => addText(`${key}.${i}`, value));
    (Array.isArray(entity.optionGroups) ? entity.optionGroups : []).forEach((group, i) => {
      addText(`optionGroups.${i}.name`, group?.name);
      addText(`optionGroups.${i}.default`, group?.default);
      (Array.isArray(group?.values) ? group.values : []).forEach((value, j) => addText(`optionGroups.${i}.values.${j}`, value));
    });
  } else {
    for (const key of ['storeName', 'storeSlug', 'description']) addText(key, entity[key]);
  }
  for (const field of ['warrantyDescription', 'policyDescription']) addText(`returnPolicy.${field}`, entity.returnPolicy?.[field]);
  const images = [];
  const seen = new Set();
  const addImage = (field, value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    if (url && !seen.has(url)) { seen.add(url); images.push({ field, url }); }
  };
  if (kind === 'product') {
    addImage('image', entity.image);
    (Array.isArray(entity.images) ? entity.images : []).forEach((image, i) => addImage(`images.${i}`, typeof image === 'string' ? image : image?.url));
  } else { addImage('logo', entity.logo); addImage('banner', entity.banner); }
  return { kind, text, images };
}

function inspectContent(snapshot) {
  if (snapshot.images.length > 12 || snapshot.text.reduce((sum, entry) => sum + entry.value.length, 0) > 20000 || JSON.stringify(snapshot.text).length > 64000) {
    return [{ field: 'content', code: 'content_limit', reason: 'Reduce excessive text or option values and use at most 12 images so every part can be checked.' }];
  }
  const violations = [];
  for (const entry of snapshot.text) {
    const value = normalizeForSafety(entry.value);
    if (SEVERE_LANGUAGE.test(value)) violations.push({ field: entry.field, code: 'profanity', reason: 'Remove offensive or profane wording from this field.' });
    const contextualReference = /\b(?:book|guide|education|educational|research|manual)\b|\bnot\s+(?:a\s+)?sex[\s_-]*toy/i.test(value);
    if (SEXUAL_GOODS.test(value) && !contextualReference) violations.push({ field: entry.field, code: 'sexual_goods', reason: 'Sex toys and products intended for sexual activity are not permitted on Rozare.' });
  }
  for (const entry of snapshot.images) if (!publicImageUrl(entry.url)) violations.push({ field: entry.field, code: 'image_invalid', reason: 'Use a publicly accessible HTTPS image uploaded for this listing.' });
  return violations.slice(0, 20);
}

const contentHash = snapshot => crypto.createHash('sha256').update(JSON.stringify({ policy: POLICY_VERSION, ...snapshot })).digest('hex');
module.exports = { POLICY_VERSION, POLICY_CODES, PRODUCT_CONTENT_FIELDS, STORE_CONTENT_FIELDS, contentHash, contentSnapshot, inspectContent, isContentApproved, isContentHeld, normalizeForSafety, pickProductInput, publicContentClause, publicImageUrl, reviewExistingCatalog };
