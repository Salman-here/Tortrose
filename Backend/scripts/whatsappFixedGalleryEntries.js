'use strict';

// Local previews only: controllers/webhooks are parsed, never required or run.
// A deliberately small expression interpreter cannot open a transport, read
// credentials, execute arbitrary JavaScript, or invoke a database query.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const parser = require('@babel/parser');
const { outboundNotificationUrl } = require('../utils/transactionalEmail');

const ROOT = path.resolve(__dirname, '../..');
const BASELINE = 'e7169e0577ac8b49b2ece10cccdf4247012a06bc';
const SOURCE_REVISION = process.env.ROZARE_GALLERY_SOURCE_REVISION || '';
if (SOURCE_REVISION && !/^[a-f0-9]{40}$/.test(SOURCE_REVISION)) throw new Error('Historical WhatsApp previews require an exact Git commit.');
const historicalText = sourcePath => execFileSync('git', ['show', `${SOURCE_REVISION}:${sourcePath}`], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const pureBuilder = sourcePath => {
  if (!SOURCE_REVISION) return require(path.resolve(ROOT, sourcePath));
  const localRequire = createRequire(path.resolve(ROOT, sourcePath)), module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Date, URL, Object, String, Number, Array, Map, Set, Math, JSON,
    require: name => ['../../utils/orderPresentation', '../moneyMath', './buyerOrderCopy'].includes(name) ? localRequire(name)
      : (() => { throw new Error(`Historical builder dependency blocked: ${name}`); })() });
  new vm.Script(historicalText(sourcePath), { filename: `historical:${sourcePath}` }).runInContext(context, { timeout: 1000 });
  return module.exports;
};
const buyer = pureBuilder('Backend/services/whatsapp/messageBuilder.js');
const seller = pureBuilder('Backend/services/whatsapp/sellerMessageTemplates.js');
const FILES = Object.freeze({
  buyerOtp: 'Backend/controllers/userWhatsappController.js',
  sellerOtp: 'Backend/controllers/sellerWhatsappController.js',
  changeOtp: 'Backend/controllers/userController.js',
  webhook: 'Backend/services/whatsapp/webhookHandler.js',
  assistant: 'Backend/services/whatsapp/whatsappAIChatService.js',
  broadcast: 'Backend/controllers/notificationController.js',
  queue: 'Backend/services/whatsapp/queue.js',
  buyer: 'Backend/services/whatsapp/messageBuilder.js',
  seller: 'Backend/services/whatsapp/sellerMessageTemplates.js',
  cancellation: 'Backend/services/orderFulfillmentService.js',
});
const sampleOrder = Object.freeze({
  _id: 'preview-only-order', orderId: 'ORD-PREVIEW', currency: 'PKR',
  paymentMethod: 'cash_on_delivery', orderStatus: 'shipped',
  orderItems: [{ name: 'Travel Mug', price: 1000, lineSubtotal: 1000, quantity: 1,
    selectedOptions: { Color: 'Blue' }, storeName: 'Atlas Aura' }],
  orderSummary: { subtotal: 1000, shippingCost: 200, tax: 0, couponDiscount: 0, totalAmount: 1200 },
  shippingInfo: { fullName: 'Sam Preview', city: 'Example City', email: 'sam@example.test' },
});

function parseSource(sourcePath, source) {
  const ast = parser.parse(source, { sourceType: 'unambiguous' });
  const nodes = [];
  function visit(node, ancestors = [], owner = '') {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration') owner = node.id.name;
    if (node.type === 'VariableDeclarator' && /FunctionExpression$/.test(node.init?.type || '')) owner = node.id.name;
    if (node.type === 'AssignmentExpression' && /FunctionExpression$/.test(node.right?.type || '')) {
      owner = source.slice(node.left.start, node.left.end);
    }
    nodes.push({ node, ancestors, owner });
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node], owner));
      else if (value?.type) visit(value, [...ancestors, node], owner);
    }
  }
  visit(ast);
  const sends = nodes.filter(({ node }) => node.type === 'CallExpression' && (
    ['sendText', 'sendButtons', 'sendList'].includes(node.callee?.property?.name)
    || node.callee?.name === 'sendResponse'
  ));
  return { sourcePath, source, nodes, sends };
}
const currentSource = sourcePath => parseSource(sourcePath, SOURCE_REVISION ? historicalText(sourcePath) : fs.readFileSync(path.join(ROOT, sourcePath), 'utf8'));
function pinnedSource(sourcePath) {
  try {
    return parseSource(sourcePath, execFileSync('git', ['show', `${BASELINE}:${sourcePath}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (_) { return null; }
}
const callName = site => site.node.callee?.property?.name || site.node.callee?.name;
const siteKey = (unit, site) => `${unit.sourcePath}:${site.node.loc.start.line}:${site.node.loc.start.column}`;
function sitesFor(unit, owner, method = 'sendText') {
  return unit.sends.filter(site => site.owner === owner && callName(site) === method);
}
function initializer(unit, site, name, assignmentIndex = null) {
  const candidates = unit.nodes.filter(({ node, owner }) => owner === site.owner && node.start < site.node.start && (
    node.type === 'VariableDeclarator' && node.id?.name === name && node.init
    || node.type === 'AssignmentExpression' && node.left?.name === name
  ));
  // Variable declarations in another branch must not accidentally supply a
  // message. Prefer declarations from lexical blocks enclosing the send.
  const scoped = candidates.filter(candidate => candidate.ancestors
    .filter(node => node.type === 'BlockStatement')
    .every(block => site.ancestors.includes(block)));
  const selected = assignmentIndex === null ? (scoped.length ? scoped : candidates).at(-1) : candidates[assignmentIndex];
  if (!selected) throw new Error(`No source initializer for ${name} at ${siteKey(unit, site)}`);
  return selected.node.init || selected.node.right;
}

const SAFE_METHODS = new Set(['join', 'filter', 'slice', 'split', 'trim', 'toLowerCase', 'replace', 'includes']);
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);
function evaluate(node, bindings, resolve, depth = 0) {
  if (!node || depth > 60) throw new Error('Preview expression is invalid or too deeply nested.');
  const run = child => evaluate(child, bindings, resolve, depth + 1);
  switch (node.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'RegExpLiteral': return new RegExp(node.pattern, node.flags);
    case 'Identifier':
      if (Object.hasOwn(bindings, node.name)) return bindings[node.name];
      if (node.name === 'undefined') return undefined;
      return run(resolve(node.name));
    case 'TemplateLiteral': return node.quasis.map((value, index) => value.value.cooked
      + (index < node.expressions.length ? String(run(node.expressions[index])) : '')).join('');
    case 'ArrayExpression': return node.elements.map(run);
    case 'ConditionalExpression': return run(node.test) ? run(node.consequent) : run(node.alternate);
    case 'LogicalExpression': {
      const value = run(node.left);
      if (node.operator === '||') return value || run(node.right);
      if (node.operator === '&&') return value && run(node.right);
      if (node.operator === '??') return value ?? run(node.right);
      break;
    }
    case 'BinaryExpression': {
      const left = run(node.left), right = run(node.right);
      if (node.operator === '+') return left + right;
      if (node.operator === '===') return left === right;
      if (node.operator === '!==') return left !== right;
      if (node.operator === '>') return left > right;
      if (node.operator === '<') return left < right;
      break;
    }
    case 'UnaryExpression': if (node.operator === '!') return !run(node.argument); break;
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const object = run(node.object);
      if (object == null && node.optional) return undefined;
      const property = node.computed ? run(node.property) : node.property.name;
      if (FORBIDDEN_PROPERTIES.has(property)) throw new Error('Unsafe preview property.');
      return object?.[property];
    }
    case 'CallExpression': case 'OptionalCallExpression': {
      if (node.callee.type === 'Identifier' && node.callee.name === 'sanitizeVisibleAIResponse') return '';
      if (node.callee.type === 'Identifier' && node.callee.name === 'outboundNotificationUrl') return outboundNotificationUrl(...node.arguments.map(run));
      if (!['MemberExpression', 'OptionalMemberExpression'].includes(node.callee.type)) break;
      const object = run(node.callee.object), method = node.callee.property.name;
      if (!SAFE_METHODS.has(method) || !(typeof object === 'string' || Array.isArray(object))) break;
      const args = node.arguments.map(run);
      if (method === 'filter' && args[0] !== Boolean) throw new Error('Only Boolean filtering is permitted.');
      return object[method](...args);
    }
  }
  throw new Error(`Unsupported data-only preview expression: ${node.type}${node.operator ? ` ${node.operator}` : ''}`);
}
function renderExpression(unit, site, extra = {}, { assignmentIndex = null, expression = null } = {}) {
  const bindings = {
    Boolean, firstName: 'Sam', orderId: 'ORD-PREVIEW', order: sampleOrder,
    isConfirmed: true, prevDecision: 'confirmed', contextMessage: '',
    maskedEmail: 'sa••••@example.test', cancelledFrom: 'your Rozare account',
    otp: '123456', OTP_EXPIRY_MINUTES: 2,
    SITE_URL: 'https://rozare.com', user: { username: 'Sam' },
    rateCheck: { resetInMinutes: 5 }, err: { message: 'Preview failure' },
    img: { imageUrl: 'https://rozare.com/preview-only-image.png', caption: 'Travel Mug — Blue' },
    job: { title: 'A Rozare update', body: 'Preview administrator announcement.', linkTo: '/marketplace' },
    process: { env: {} }, ...extra,
  };
  const argument = expression || site.node.arguments[1];
  const resolved = argument.type === 'Identifier' ? initializer(unit, site, argument.name, assignmentIndex) : argument;
  return evaluate(resolved, bindings, name => initializer(unit, site, name));
}
const normalize = payload => typeof payload === 'string'
  ? { message: payload, title: '', footer: '', buttons: [] }
  : { message: payload.description || payload.message || '', title: payload.title || payload.name || '',
    footer: payload.footer || payload.footerText || '', buttons: payload.buttons?.map(row => row.displayText)
      || payload.sections?.flatMap(section => section.rows.map(row => row.title)) || payload.values || [] };

function buildFixedWhatsAppGalleryEntries({ includeLegacy = true, includeBefore = true } = {}) {
  const units = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, currentSource(file)]));
  const oldUnits = includeBefore ? Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, pinnedSource(file)])) : {};
  const entries = [], covered = new Set(), exclusions = [];
  const add = (group, name, unit, site, after, { activity = 'active', before = null, note = '' } = {}) => {
    if (site) covered.add(siteKey(unit, site));
    entries.push({ channel: 'whatsapp', group, name, activity,
      kind: activity === 'legacy' ? 'Retained template' : 'Actual source preview',
      sourcePath: unit.sourcePath, sourceLine: site?.node.loc.start.line || 1,
      sourceBaseline: before ? BASELINE : null,
      comparison: before ? 'Source snapshot' : 'No pinned comparison',
      after: normalize(after), ...(before ? { before: normalize(before) } : {}), note });
  };
  const capture = (key, owner, names, { variants = {}, activity = 'active', method = 'sendText' } = {}) => {
    const unit = units[key], sites = sitesFor(unit, owner, method);
    if (sites.length !== names.length) throw new Error(`Fixed WhatsApp coverage changed in ${unit.sourcePath}: ${owner} (${sites.length}, expected ${names.length}).`);
    const old = oldUnits[key], oldSites = old ? sitesFor(old, owner, method) : [];
    names.forEach((name, index) => {
      for (const variant of variants[index] || [{}]) {
        const after = renderExpression(unit, sites[index], variant.bindings, variant);
        let before = null;
        if (oldSites.length === sites.length) {
          try { before = renderExpression(old, oldSites[index], variant.bindings, variant); } catch (_) { /* no invented old copy */ }
        }
        add(key === 'assistant' ? 'Assistant fixed messages' : key === 'broadcast' ? 'Announcements' : key.endsWith('Otp') ? 'Verification' : 'Order decisions',
          `${name}${variant.label ? ` — ${variant.label}` : ''}`, unit, sites[index], after, { activity, before, note: variant.note || '' });
      }
    });
  };
  capture('buyerOtp', 'exports.sendUserWhatsAppOTP', ['Buyer WhatsApp code']);
  capture('sellerOtp', 'exports.sendWhatsAppOTP', ['Seller WhatsApp code']);
  capture('changeOtp', 'exports.initiateWhatsAppChange', ['Change seller WhatsApp number']);
  capture('webhook', 'sendResponseMessage', ['Buyer decision acknowledgement'], {
    variants: { 0: [{ label: 'confirmed', bindings: { isConfirmed: true } }, { label: 'cancelled', bindings: { isConfirmed: false } }] },
  });
  const helperOptions = { activity: 'legacy' };
  capture('webhook', 'sendLockedMessage', ['Legacy locked decision helper'], { ...helperOptions, variants: { 0: [
    ...['confirmed', 'cancelled', ''].map(prevDecision => ({ label: prevDecision || 'other', bindings: { prevDecision } })),
  ] } });
  capture('webhook', 'sendUnclearReplyHint', ['Legacy typed-reply hint'], helperOptions);
  capture('webhook', 'sendReconfirmPrompt', ['Reconfirmation buttons unavailable']);
  const cancellationReasons = units.cancellation.nodes.filter(({ node }) => node.type === 'ObjectProperty'
    && node.key?.name === 'message' && node.value.type === 'StringLiteral').map(({ node }) => node.value.value);
  if (cancellationReasons.length !== 2) throw new Error('Cancellation-block preview coverage changed.');
  capture('webhook', 'exports.handleEvolutionWebhook', [
    'Confirmation request expired', 'Reconfirmation already confirmed', 'Order changed during reconfirmation',
    'Order changed during keep-cancelled request', 'Order remains cancelled', 'Email decision already confirmed',
    'Email confirmation — cancellation guidance', 'Email decision already cancelled', 'Account decision already cancelled',
    'Order cancelled after WhatsApp confirmation', 'Later-stage order — confirmation acknowledgement',
    'Later-stage order — cancellation or return guidance', 'WhatsApp already confirmed — cancellation or return guidance',
    'Cancellation unavailable in this message',
  ], { variants: {
    9: [{ label: 'account', bindings: { cancelledFrom: 'your Rozare account' } }, { label: 'email', bindings: { cancelledFrom: 'your email (sa••••@example.test)' } }],
    10: ['processing', 'shipped', 'delivered'].map(orderStatus => ({ label: orderStatus, bindings: { order: { ...sampleOrder, orderStatus } } })),
    11: ['processing', 'shipped', 'delivered'].map(orderStatus => ({ label: orderStatus, bindings: { order: { ...sampleOrder, orderStatus } } })),
    13: cancellationReasons.map((message, index) => ({ label: index ? 'paid order' : 'already shipped', bindings: { cancellationBlock: { message } } })),
  } });

  capture('assistant', 'handleUnlinkedUserOnMainInstance', ['Unlinked shopper connection instructions']);
  capture('assistant', 'handleNonSellerOnSellerInstance', ['Seller-assistant connection instructions'], { variants: { 0: [
    { label: 'linked shopper', assignmentIndex: 0 }, { label: 'unregistered seller', assignmentIndex: 1 },
  ] } });
  capture('assistant', 'processIncomingWhatsAppMessageNow', [
    'Hourly message limit', 'Empty sanitized reply fallback', 'Empty response fallback', 'Processing failure fallback',
  ], { method: 'sendResponse', variants: { 3: [
    { label: 'provider rate limit', bindings: { err: { message: 'rate limit' } } },
    { label: 'credits unavailable', bindings: { err: { message: 'credits' } } },
    { label: 'other failure', bindings: { err: { message: 'Other preview error' } } },
  ] } });
  capture('assistant', 'processIncomingWhatsAppMessageNow', ['Product image text fallback']);
  capture('broadcast', 'dispatchBroadcast', ['Administrator announcement wrapper'], { variants: { 0: [
    { label: 'with action link', note: 'The administrator supplies the title and body; this is the fixed transport wrapper.' },
    { label: 'without action link', bindings: { job: { title: 'A Rozare update', body: 'Preview administrator announcement.', linkTo: '' } },
      note: 'The administrator supplies the title and body; this is the fixed transport wrapper.' },
  ] } });

  // Reconfirmation contexts are source expressions too, not paraphrases.
  const contexts = units.webhook.nodes.filter(({ node }) => node.type === 'VariableDeclarator' && node.id?.name === 'contextMsg');
  if (contexts.length !== 4) throw new Error('Reconfirmation-context coverage changed.');
  const reconfirmSend = sitesFor(units.webhook, 'sendReconfirmPrompt', 'sendButtons')[0];
  const buyerDefinitions = name => units.buyer.nodes.find(({ node }) => node.type === 'AssignmentExpression'
    && node.left?.object?.name === 'exports' && node.left.property?.name === name);
  let oldMap = new Map();
  if (includeBefore) {
    try { oldMap = require('./previousNotificationGallery').oldWhatsAppTemplateByName(sampleOrder, {
      returnNumber: 'RET-PREVIEW', orderId: 'ORD-PREVIEW', reasonDetails: 'The item arrived damaged.',
    }); } catch (_) { /* An unavailable pinned commit is not an old template. */ }
  }
  const pureBuyer = (name, method, payload, activity = 'active') => {
    const definition = buyerDefinitions(method);
    if (!definition) throw new Error(`Missing message-builder export: ${method}`);
    add('Orders', name, units.buyer, { node: definition.node }, payload, { activity, before: oldMap.get(name) || null });
  };
  pureBuyer('COD order: confirm or cancel buttons', 'buildOrderButtonsPayload', buyer.buildOrderButtonsPayload(sampleOrder, { friendly: true }));
  pureBuyer('COD order: interactive list', 'buildOrderListPayload', buyer.buildOrderListPayload(sampleOrder, { friendly: true }));
  pureBuyer('Paid order information', 'buildOrderPlacedInfoMessage', buyer.buildOrderPlacedInfoMessage({ ...sampleOrder, paymentMethod: 'safepay' }));
  pureBuyer('Reconfirm a cancelled COD order', 'buildReconfirmButtonsPayload', buyer.buildReconfirmButtonsPayload(sampleOrder, ''));
  covered.add(siteKey(units.webhook, reconfirmSend));
  const contextNames = ['Email cancellation — reconfirmation', 'Account cancellation — reconfirmation',
    'Cancellation after WhatsApp confirmation — reconfirmation', 'WhatsApp cancellation — reconfirmation'];
  for (const [index, context] of contexts.entries()) {
    for (const cancelledFrom of index === 2 ? ['your Rozare account', 'your email (sa••••@example.test)'] : ['your Rozare account']) {
      const fakeSite = { ...context, node: { ...context.node, arguments: [] } };
      const message = renderExpression(units.webhook, fakeSite, { cancelledFrom }, { expression: context.node.init });
      add('Order decisions', `${contextNames[index]}${index === 2 ? ` — ${cancelledFrom.includes('email') ? 'email' : 'account'}` : ''}`, units.webhook, null,
        buyer.buildReconfirmButtonsPayload(sampleOrder, message), { note: 'The context and interactive message come from their actual source expressions.' });
      entries.at(-1).sourceLine = context.node.loc.start.line;
    }
  }

  for (const site of units.queue.sends) {
    covered.add(siteKey(units.queue, site));
    exclusions.push({ sourcePath: units.queue.sourcePath, sourceLine: site.node.loc.start.line,
      call: callName(site), classification: site.node.arguments[1]?.type === 'MemberExpression'
        ? 'Frozen outbox payload; captured by outbox gallery producers.' : 'Pure message-builder entry above.' });
  }
  for (const site of sitesFor(units.assistant, 'sendResponse')) {
    covered.add(siteKey(units.assistant, site));
    exclusions.push({ sourcePath: units.assistant.sourcePath, sourceLine: site.node.loc.start.line,
      call: callName(site), classification: 'Shared text/chunk delivery transport; dynamic AI replies are excluded.' });
  }

  if (includeLegacy) {
    pureBuyer('COD order: legacy text summary', 'buildOrderConfirmationMessage', buyer.buildOrderConfirmationMessage(sampleOrder), 'legacy');
    for (const status of ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']) {
      pureBuyer(`Buyer order ${status} (retained)`, 'buildOrderStatusUpdateMessage', buyer.buildOrderStatusUpdateMessage(sampleOrder, status), 'legacy');
    }
    pureBuyer('Legacy COD poll (not sent)', 'buildPollPayload', buyer.buildPollPayload(sampleOrder), 'legacy');
    const returnRequest = { returnNumber: 'RET-PREVIEW', orderId: 'ORD-PREVIEW', reasonDetails: 'The item arrived damaged.' };
    const utilityInputs = {
      seller_welcome: ['Atlas Aura'], new_order: [sampleOrder], order_confirmed: [sampleOrder], order_cancelled: [sampleOrder],
      return_requested: [returnRequest], return_settled: [returnRequest, 'Rs1,200.00 PKR'], subscription_activated: ['Rozare Starter', 30],
      subscription_ending_soon: [7], payment_failed: [], payment_recovered: [], plan_change_action_required: [], trial_expiring: [7],
      account_blocked: ['the subscription ended'], product_blocked: [], bonus_expiring: [7], bonus_expired: [],
      downgrade_scheduled: [], upgrade_completed: [], store_verified: [],
    };
    const utilityOldNames = ['Seller welcome', 'New seller order', 'Order confirmed for seller', 'Order cancelled for seller',
      'Seller return request', 'Seller return settlement', 'Subscription activated', 'Subscription ending soon',
      'Subscription payment failed', 'Subscription payment recovered', 'Plan change needs authentication', 'Seller trial expiring',
      'Store unavailable', 'Product listing needs changes', 'Bonus features expiring', 'Bonus features expired',
      'Downgrade scheduled', 'Elite upgrade completed', 'Store verified'];
    for (const [index, [name, args]] of Object.entries(utilityInputs).entries()) {
      const definition = units.seller.nodes.find(({ node }) => node.type === 'ObjectProperty' && node.key?.name === name);
      add('Seller utilities', `Seller utility: ${name}`, units.seller, { node: definition.node }, seller[name](...args), {
        activity: name === 'return_requested' ? 'active' : 'legacy',
        before: oldMap.get(utilityOldNames[index]) || null,
        note: name === 'return_requested' ? 'Used by the active return-request outbox; also present in the outbox gallery.'
          : 'Retained utility with no active runtime caller. Not a claim that this message is sent.',
      });
    }
  }
  const audited = ['buyerOtp', 'sellerOtp', 'changeOtp', 'webhook', 'assistant', 'broadcast', 'queue'];
  for (const key of audited) for (const site of units[key].sends) {
    if (!covered.has(siteKey(units[key], site))) throw new Error(`Unaccounted WhatsApp send site: ${siteKey(units[key], site)}`);
  }
  const result = (includeLegacy ? entries : entries.filter(entry => entry.activity !== 'legacy')).map(entry => ({ ...entry,
    after: { ...entry.after, buttons: [...entry.after.buttons] },
    ...(entry.before ? { before: { ...entry.before, buttons: [...entry.before.buttons] } } : {}),
  }));
  Object.defineProperty(result, 'coverage', { value: exclusions, enumerable: false });
  return result;
}

function auditFixedWhatsAppSendSites() {
  const entries = buildFixedWhatsAppGalleryEntries({ includeBefore: false });
  const mapped = new Set(entries.map(entry => `${entry.sourcePath}:${entry.sourceLine}`));
  const excluded = new Map(entries.coverage.map(site => [`${site.sourcePath}:${site.sourceLine}`, site.classification]));
  // Pure builder declarations have their own provenance; their underlying
  // queue and reconfirm send sites are classified explicitly above.
  return ['buyerOtp', 'sellerOtp', 'changeOtp', 'webhook', 'assistant', 'broadcast', 'queue'].flatMap(key => {
    const unit = currentSource(FILES[key]);
    return unit.sends.map(site => ({ sourcePath: unit.sourcePath, sourceLine: site.node.loc.start.line,
      call: callName(site), owner: site.owner,
      classification: mapped.has(`${unit.sourcePath}:${site.node.loc.start.line}`) ? 'Source-rendered fixed entry'
        : excluded.get(`${unit.sourcePath}:${site.node.loc.start.line}`) || (callName(site) === 'sendButtons' ? 'Pure reconfirmation-builder entry' : 'Unaccounted'),
    }));
  });
}

module.exports = { buildFixedWhatsAppGalleryEntries, auditFixedWhatsAppSendSites, BASELINE, sourceRevision: SOURCE_REVISION };
