'use strict';

// Offline source inventory. This module never imports runtime producers, opens
// a database, calls a provider, or sends a notification. Only explicitly named
// declarations/call expressions are evaluated, with dummy data and intercepted
// enqueue functions. Missing declarations/templates/money fail closed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { parse } = require('@babel/parser');
const { notificationActionLabel, outboundNotificationUrl, prepareTransactionalEmail } = require('../utils/transactionalEmail');
const { escapeHtml, formatItemOptionsText } = require('../utils/orderPresentation');
const { storefrontNotificationUrl } = require('../utils/storefrontNotificationUrl');
const { buyerOrderMessage } = require('../services/whatsapp/buyerOrderCopy');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_REVISION = process.env.ROZARE_GALLERY_SOURCE_REVISION || '';
if (SOURCE_REVISION && !/^[a-f0-9]{40}$/.test(SOURCE_REVISION)) throw new Error('Historical preview requires an exact Git commit.');
const OLD_EMAIL = process.env.ROZARE_GALLERY_OLD_EMAIL === 'true';
const NOW = new Date('2026-10-12T10:00:00.000Z');
const IDS = { buyer: '000000000000000000000001', seller: '000000000000000000000002',
  order: '000000000000000000000003', store: '000000000000000000000004',
  request: '000000000000000000000005', admin: '000000000000000000000006' };
const blocked = name => { throw new Error(`Offline gallery blocked dependency: ${name}`); };
const sourceCache = new Map();
function source(relative) {
  if (!sourceCache.has(relative)) {
    const filename = path.resolve(ROOT, relative);
    if (!filename.startsWith(`${ROOT}${path.sep}`)) throw new Error('Source path escapes Backend.');
    const text = SOURCE_REVISION
      ? execFileSync('git', ['show', `${SOURCE_REVISION}:Backend/${relative}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000 })
      : fs.readFileSync(filename, 'utf8');
    sourceCache.set(relative, { text, ast: parse(text, { sourceType: 'script' }) });
  }
  return sourceCache.get(relative);
}
function pureSourceModule(relative) {
  if (!SOURCE_REVISION) return require(path.resolve(ROOT, relative));
  if (!['services/whatsapp/messageBuilder.js', 'services/whatsapp/sellerMessageTemplates.js', 'services/safepayRenewalPolicy.js'].includes(relative)) {
    throw new Error('Historical preview module is not an audited pure builder.');
  }
  const localRequire = createRequire(path.resolve(ROOT, relative));
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Date, URL, Object, String, Number, Array, Map, Set, Math, JSON, Intl,
    require: name => ['../../utils/orderPresentation', '../moneyMath', './buyerOrderCopy'].includes(name) ? localRequire(name) : blocked(name) });
  new vm.Script(source(relative).text, { filename: `historical:${relative}` }).runInContext(context, { timeout: 1000 });
  return module.exports;
}
function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function declarations(relative, names, bindings = {}) {
  const file = source(relative), pieces = [], lines = {};
  for (const name of names) {
    const node = file.ast.program.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name)
      || file.ast.program.body.flatMap(entry => entry.type === 'VariableDeclaration' ? entry.declarations : [])
        .find(entry => entry.id.type === 'Identifier' && entry.id.name === name);
    if (!node) throw new Error(`Required production declaration missing: ${relative}:${name}`);
    pieces.push(node.type === 'VariableDeclarator' ? `const ${file.text.slice(node.start, node.end)};` : file.text.slice(node.start, node.end));
    lines[name] = node.loc.start.line;
  }
  const context = vm.createContext({ Date, Object, Array, Map, Set, URL, BigInt, Number, String, Boolean, JSON,
    crypto, escapeHtml, formatItemOptionsText, process: { env: { FRONTEND_URL: 'https://rozare.com' } },
    require: name => blocked(name), ...bindings });
  const result = new vm.Script(`${pieces.join('\n')}\n({${names.join(',')}})`, { filename: `offline:${relative}` }).runInContext(context, { timeout: 1000 });
  return { result, lines };
}
function callExpressions(relative, name) {
  const file = source(relative), matches = [];
  visit(file.ast.program, node => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type === 'Identifier' && callee.name === name
      || callee.type === 'MemberExpression' && !callee.computed && callee.property.name === name) matches.push(node);
  });
  return matches.map(node => ({ code: file.text.slice(node.start, node.end), line: node.loc.start.line, start: node.start, end: node.end }));
}
async function evaluateCall(relative, call, bindings) {
  const context = vm.createContext({ Date, Object, Array, Map, Set, URL, Number, String, Boolean,
    escapeHtml, process: { env: { FRONTEND_URL: 'https://rozare.com' } }, require: name => blocked(name), ...bindings });
  return new vm.Script(`(async()=>(${call.code}))()`, { filename: `offline:${relative}:${call.line}` }).runInContext(context, { timeout: 1000 });
}

const currency = declarations('services/currencyService.js', ['CURRENCIES', 'isSupportedCurrency']).result;
const moneyMath = require('../services/moneyMath');
const snapshot = declarations('services/notificationMoneySnapshotService.js', [
  'notificationMoneyError', 'requireSourceId', 'requireStoredCurrency', 'requireStripeStoredCurrency',
  'requireStoredMinorUnits', 'requireSnapshotMetadata', 'snapshotMinorMoney', 'formatMoneySnapshot',
], { ...currency }).result;
const mongoose = { Types: { ObjectId: class OfflineObjectId {} }, isValidObjectId: value => /^[a-f0-9]{24}$/.test(String(value)) };
const renderer = declarations('services/notificationOutboxService.js', [
  'MONEY_TOKEN', 'FINANCIAL_DATA_KEY', 'outboxError', 'canonicalize', 'canonicalJson', 'assertSafeData',
  'renderMoneyText', 'optionalRenderedText', 'normalizeJsonSnapshot', 'normalizeChannelPayload',
], { mongoose, outboundNotificationUrl, ...snapshot }).result;
const money = (key, amountMinor = 120000, currencyCode = 'PKR') => snapshot.snapshotMinorMoney({ key,
  amountMinor, currency: currencyCode, sourceModel: 'Order', sourceDocumentId: IDS.order, sourcePath: 'orderSummary.totalAmount' });
const MONEY_VALUES = {
  order_total: [120000, 'PKR'], seller_order_total: [120000, 'PKR'], seller_store_total: [120000, 'PKR'],
  refund_total: [120000, 'PKR'], refund: [120000, 'PKR'], deduction: [10440, 'PKR'], amount: [120000, 'PKR'],
  refund_wallet_available: [90000, 'PKR'], refund_liability_applied: [30000, 'PKR'], refund_remaining_liability: [0, 'PKR'],
  refund_amount: [120000, 'PKR'], wallet_amount: [120000, 'PKR'], wallet_available_credit: [90000, 'PKR'],
  wallet_liability_applied: [30000, 'PKR'], wallet_remaining_liability: [0, 'PKR'],
  return_total: [120000, 'PKR'], return_wallet_credit: [90000, 'PKR'], return_liability_applied: [30000, 'PKR'],
  return_remaining_liability: [0, 'PKR'], requested_amount: [200000, 'PKR'], payout_amount: [200000, 'PKR'],
  charged: [2565, 'USD'], monthly: [2565, 'USD'], paid: [1500, 'USD'],
};
function inferredMoney(templates) {
  const keys = [...new Set([...JSON.stringify(templates).matchAll(/\{\{money\.([a-z][a-z0-9_.-]*)\}\}/g)].map(match => match[1]))];
  return keys.map(key => {
    if (!MONEY_VALUES[key]) throw new Error(`Preview dummy money fixture missing: ${key}`);
    return money(key, ...MONEY_VALUES[key]);
  });
}

const COVERAGE = Object.freeze([
  { sourcePath: 'Backend/services/financialNotificationOutboxService.js', scope: 'Order receipts/lifecycle, seller fulfillment, COD decisions, return settlement, Wallet credit/debit, all withdrawal states', activity: 'active' },
  { sourcePath: 'Backend/services/buyerCancellationService.js', scope: 'Buyer/seller COD, Wallet, original-card pending/completed and unsupported-rail review', activity: 'active' },
  { sourcePath: 'Backend/services/safepayRefundService.js', scope: 'Buyer/seller verified card refund', activity: 'active' },
  { sourcePath: 'Backend/services/safepaySafetyRefundService.js', scope: 'Admin refund not-submitted / reconciliation', activity: 'active' },
  { sourcePath: 'Backend/services/cancellationRefundService.js', scope: 'Admin cancellation refund review', activity: 'active' },
  { sourcePath: 'Backend/services/safepayBillingService.js', scope: 'Trial/active/failed operation and renewal failures on days 1, 3, 5 and 7', activity: 'active' },
  { sourcePath: 'Backend/services/safepayBillingLifecycleService.js', scope: 'Cancel/resume/downgrade/cancel downgrade/ended and in-flight cancellation', activity: 'active' },
  { sourcePath: 'Backend/services/subscriptionLifecycleNotificationService.js', scope: 'Shared trial/bonus and Safepay ending warnings, plus retained Stripe-only plan/invoice activation labelled separately', activity: 'active' },
  { sourcePath: 'Backend/services/returnNotificationService.js', scope: 'New request, buyer cancellation, all non-settlement status labels', activity: 'active' },
  { sourcePath: 'Backend/services/sellerOperationalNotificationService.js', scope: 'Seller welcome, store-created moderation states, verification decisions, rating, payout update, product blocked', activity: 'active' },
  { sourcePath: 'Backend/services/catalogModerationNotificationService.js', scope: 'Store/product approved and blocked; pending is inapp/push-only and is not fabricated as email/WhatsApp', activity: 'active' },
  { sourcePath: 'Backend/services/safepaySubdomainService.js', scope: 'Current Safepay ownership receipt', activity: 'active' },
  { sourcePath: 'Backend/services/subdomainLifecycleNotificationService.js', scope: 'Ownership expired and removed', activity: 'active' },
]);
const EXCLUSIONS = Object.freeze([
  'Direct account/broadcast templates are supplied by the existing gallery, not duplicated here.',
  'Retained Stripe-only notices are labelled legacy, never active Safepay templates; dormant direct email exports are supplied by the parent gallery.',
  'AI-generated responses are not fixed message templates.',
  'No fake Old version: these source captures have no verified historical source snapshot.',
  'Business mutations and delivery eligibility are not tested by offline template rendering.',
]);

// Every enqueue/notify call in these source families is explicitly classified.
// New producer functions, new calls in an existing function, or renamed sites
// fail the inventory check instead of disappearing silently from the preview.
const CALL_SITE_MATRIX = Object.freeze({
  'services/financialNotificationOutboxService.js': {
    enqueueOrderLifecycleBuyerNotifications: 1, enqueueOrderSellerFulfillmentBuyerNotifications: 1,
    enqueueOrderStockRefundBuyerNotifications: 1, enqueuePaidOrderBuyerNotifications: 1,
    enqueuePaidOrderSellerNotifications: 1, enqueueNoChargeOrderBuyerNotifications: 1,
    enqueueNoChargeOrderSellerNotifications: 1, enqueueCodOrderSellerNotifications: 1,
    enqueueCodOrderBuyerConfirmationNotification: 1, enqueueCodOrderDecisionSellerNotifications: 1,
    enqueueReturnSettlementNotifications: 2, enqueueWithdrawalRequestedSellerNotifications: 1,
    enqueueWithdrawalStatusSellerNotifications: 1, enqueueWithdrawalRequestedAdminNotifications: 1,
    enqueueWalletTransactionNotification: 1, enqueueSubscriptionPaymentNotification: 1,
    enqueueSubdomainPaymentNotification: 1, enqueueSubscriptionCancellationNotification: 1,
  },
  'services/buyerCancellationService.js': { notifyCancellation: 1 },
  'services/safepayRefundService.js': { notifyRefund: 1 },
  'services/safepaySafetyRefundService.js': { notifyRefundReview: 1 },
  'services/cancellationRefundService.js': { processCancellationRefund: 1 },
  'services/safepayBillingService.js': { notifyOperation: 1, applyOperation: 1, failBillingPayment: 1 },
  'services/safepayBillingLifecycleService.js': { notify: 1, cancel: 1, resume: 1, scheduleDowngrade: 1, cancelDowngrade: 1,
    [source('services/safepayBillingLifecycleService.js').ast.program.body.some(node => node.type === 'FunctionDeclaration'
      && node.id.name === 'finishSubscription') ? 'finishSubscription' : 'closeEndedSubscription']: 1 },
  'services/subscriptionLifecycleNotificationService.js': { enqueueTrialExpiringNotification: 1,
    enqueueTrialBlockedNotification: 1, enqueueSubscriptionEndingNotification: 1, enqueueBonusLifecycleNotification: 1,
    enqueuePlanChangeNotification: 1, enqueueSubscriptionPaymentFailureNotification: 1,
    enqueueSubscriptionActivationNotification: 1, enqueueSubscriptionDowngradeScheduledNotification: 1 },
  'services/returnNotificationService.js': { notifySellerReturnRequested: 1, enqueueReturnCancellationNotifications: 2, notifyBuyerReturnStatus: 1 },
  'services/sellerOperationalNotificationService.js': { enqueueSellerWelcomeNotification: 1, enqueueStoreCreatedNotification: 1,
    enqueueStoreVerificationNotification: 1, enqueueNewStoreReviewNotification: 1, enqueuePayoutAccountUpdatedNotification: 1, enqueueProductBlockedNotification: 1 },
  'services/catalogModerationNotificationService.js': { ensureCatalogModerationNotification: 1 },
  'services/safepaySubdomainService.js': { settle: 1 },
  'services/subdomainLifecycleNotificationService.js': { enqueueSubdomainOwnershipExpiredNotification: 1, enqueueSubdomainRemovedNotification: 1 },
});
function notificationCallSiteInventory() {
  const inventory = [];
  for (const [relative, expected] of Object.entries(CALL_SITE_MATRIX)) {
    const file = source(relative), scopes = [], actual = {};
    visit(file.ast, node => {
      if (node.type === 'FunctionDeclaration') scopes.push({ name: node.id.name, start: node.start, end: node.end });
      if (node.type === 'VariableDeclarator' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
        scopes.push({ name: node.id.name, start: node.start, end: node.end });
      }
    });
    for (const callee of ['enqueueNotificationEvent', 'notifyOperation', 'notify']) for (const call of callExpressions(relative, callee)) {
      const position = call.start;
      const scope = scopes.filter(item => item.start <= position && item.end >= call.end)
        .filter(item => file.text.slice(item.start, item.end).includes(call.code)).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (!scope) throw new Error(`Unmapped notification call scope: ${relative}:${call.line}`);
      actual[scope.name] = (actual[scope.name] || 0) + 1;
      const retained = relative === 'services/financialNotificationOutboxService.js'
        && ['enqueueOrderStockRefundBuyerNotifications', 'enqueueSubscriptionPaymentNotification', 'enqueueSubdomainPaymentNotification', 'enqueueSubscriptionCancellationNotification'].includes(scope.name)
        || relative === 'services/subscriptionLifecycleNotificationService.js'
        && ['enqueuePlanChangeNotification', 'enqueueSubscriptionPaymentFailureNotification', 'enqueueSubscriptionActivationNotification', 'enqueueSubscriptionDowngradeScheduledNotification'].includes(scope.name);
      const builderCapture = relative === 'services/financialNotificationOutboxService.js'
        && ['enqueueOrderLifecycleBuyerNotifications', 'enqueueOrderSellerFulfillmentBuyerNotifications', 'enqueueOrderStockRefundBuyerNotifications',
          'enqueuePaidOrderBuyerNotifications', 'enqueuePaidOrderSellerNotifications', 'enqueueNoChargeOrderBuyerNotifications',
          'enqueueNoChargeOrderSellerNotifications', 'enqueueCodOrderSellerNotifications', 'enqueueCodOrderDecisionSellerNotifications',
          'enqueueReturnSettlementNotifications'].includes(scope.name);
      inventory.push({ sourcePath: `Backend/${relative}`, sourceLine: call.line, functionName: scope.name, callee,
        activity: retained ? 'legacy' : 'active',
        strategy: builderCapture ? 'source-extracted template builder' : 'intercepted producer or exact source notification call' });
    }
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
      throw new Error(`Notification call-site coverage changed: ${relative}; actual=${JSON.stringify(actual)}`);
    }
  }
  return inventory;
}

function runtimeGalleryCounts(entries) {
  const count = activity => ({ email: entries.filter(entry => entry.activity === activity && entry.channel === 'email').length,
    whatsapp: entries.filter(entry => entry.activity === activity && entry.channel === 'whatsapp').length });
  return { active: count('active'), legacy: count('legacy'), reviewRequired: count('review-required'),
    exception: count('exception'),
    sourceCallSites: notificationCallSiteInventory().length };
}

async function buildRuntimeNotificationGalleryEntries({ includeApp = false } = {}) {
  notificationCallSiteInventory();
  const entries = [], captured = [];
  let current = null, activity = 'active';
  const capture = async event => {
    if (!current) throw new Error('Unlabelled notification capture.');
    captured.push({ event, ...current });
    return (event.channels || []).map(channel => ({ channel }));
  };
  const deps = { enqueueNotificationEvent: capture, outboxError: renderer.outboxError,
    stringId: value => String(value?._id || value || ''), id: value => String(value?._id || value || ''),
    safeText: (value, max = 300) => String(value || '').trim().slice(0, max),
    requireEventDate: value => new Date(value), ...snapshot, ...moneyMath,
    tryOrderBuyerPhoneE164: () => '+923001234567' };
  async function run(relative, name, sourceLine, work, mode = 'Captured production producer') {
    current = { sourcePath: `Backend/${relative}`, sourceLine, name, mode, activity };
    const count = captured.length;
    await work();
    if (captured.length === count) throw new Error(`Required template did not enqueue: ${name}`);
    current = null;
  }
  function record(relative, line, name, templates, { role = 'buyer', route, group = 'Orders', money: frozenMoney } = {}) {
    const destination = route || (role === 'seller' ? `/seller-dashboard/order/${IDS.order}` : `/user-dashboard/order/detail/${IDS.order}`);
    captured.push({ sourcePath: `Backend/${relative}`, sourceLine: line, name,
      mode: 'Source-extracted production builder', group, activity,
      event: { channels: ['email', 'whatsapp', ...(includeApp ? ['inapp', 'push'] : [])].filter(channel => templates[channel]), templates,
        recipient: { audienceRole: role }, financial: (frozenMoney || inferredMoney(templates)).length > 0,
        money: frozenMoney || inferredMoney(templates),
        metadata: { category: 'system', channelId: 'general', linkTo: destination, whatsappCategory: role === 'seller' ? 'order_update' : '' } } });
  }

  const financialPath = 'services/financialNotificationOutboxService.js';
  const financialNames = ['ORDER_LIFECYCLE_STATUS_COPY', 'ORDER_CANCELLATION_BUYER_DETAIL', 'orderLifecycleBuyerTemplates',
    'SELLER_FULFILLMENT_STATUS_COPY', 'sellerFulfillmentBuyerTemplates', 'paidBuyerTemplates', 'paidSellerTemplates',
    'noChargeBuyerTemplates', 'noChargeSellerTemplates', 'codSellerPlacedTemplates', 'codSellerDecisionTemplates',
    'returnBuyerTemplates', 'returnSellerTemplates', ...(source(financialPath).text.includes('const warrantySettlementTemplates') ? ['warrantySettlementTemplates'] : [])];
  if (source(financialPath).text.includes('const BUYER_ORDER_HEADLINES')) {
    financialNames.unshift('BUYER_ORDER_HEADLINES', 'BUYER_ORDER_DETAILS', 'BUYER_SHIPMENT_HEADLINES');
  }
  const financial = declarations(financialPath, financialNames, { ...deps, buyerOrderMessage });
  const f = financial.result;
  const buyerPreviewOrder = { user: IDS.buyer, orderId: 'ORD-PREVIEW', shippingInfo: { fullName: 'Sam Preview' },
    orderItems: [{ name: 'Travel Mug', quantity: 2, selectedOptions: { Color: 'Blue' } }] };
  for (const status of Object.keys(f.ORDER_LIFECYCLE_STATUS_COPY)) {
    for (const actorRole of status === 'cancelled' ? ['buyer', 'seller', 'admin', 'system'] : ['buyer']) {
      record(financialPath, financial.lines.orderLifecycleBuyerTemplates, `Buyer order ${status}${status === 'cancelled' ? ` by ${actorRole}` : ''}`,
        f.orderLifecycleBuyerTemplates('ORD-PREVIEW', status, { actorRole, order: buyerPreviewOrder }));
    }
  }
  for (const status of Object.keys(f.SELLER_FULFILLMENT_STATUS_COPY)) {
    record(financialPath, financial.lines.sellerFulfillmentBuyerTemplates, `Seller shipment ${status}`, f.sellerFulfillmentBuyerTemplates({
      orderNumber: 'ORD-PREVIEW', storeName: 'Atlas Aura', status, itemSummary: 'Travel Mug (Color: Blue) × 1', shippingSummary: 'Standard shipping: 5 days.',
      order: buyerPreviewOrder, items: buyerPreviewOrder.orderItems }));
  }
  for (const [builder, name, role] of [['paidBuyerTemplates', 'Buyer paid-order receipt', 'buyer'], ['paidSellerTemplates', 'Seller paid-order receipt', 'seller'],
    ['noChargeBuyerTemplates', 'Buyer no-charge order', 'buyer'], ['noChargeSellerTemplates', 'Seller no-charge order', 'seller'], ['codSellerPlacedTemplates', 'Seller COD order', 'seller']]) {
    const templates = f[builder]('ORD-PREVIEW', { order: buyerPreviewOrder });
    const frozenMoney = inferredMoney(templates).map(value => name.includes('no-charge') ? { ...value, amountMinor: 0 } : value);
    record(financialPath, financial.lines[builder], name, templates, { role, money: frozenMoney });
  }
  for (const decision of ['confirmed', 'reconfirmed', 'cancelled']) {
    for (const actorRole of decision === 'cancelled' ? ['buyer', 'seller', 'admin', 'system'] : ['buyer']) {
      for (const includeMoney of [true, false]) record(financialPath, financial.lines.codSellerDecisionTemplates,
        `Seller COD ${decision}${decision === 'cancelled' ? ` by ${actorRole}` : ''}${includeMoney ? '' : ' — unavailable legacy allocation'}`,
        f.codSellerDecisionTemplates('ORD-PREVIEW', decision, { actorRole, includeMoney }), { role: 'seller' });
    }
  }
  for (const liability of [false, true]) record(financialPath, financial.lines.returnBuyerTemplates,
    `Buyer return refund ${liability ? 'allocated to Wallet liability' : 'full Wallet credit'}`,
    f.returnBuyerTemplates('RET-PREVIEW', 'ORD-PREVIEW', liability), { group: 'Returns', route: `/user-dashboard/order/detail/${IDS.order}?returnId=${IDS.request}` });
  record(financialPath, financial.lines.returnSellerTemplates, 'Seller return settlement', f.returnSellerTemplates('RET-PREVIEW', 'ORD-PREVIEW'),
    { role: 'seller', group: 'Returns', route: `/seller-dashboard/order-management?tab=returns&returnId=${IDS.request}` });
  if (f.warrantySettlementTemplates) {
  for (const liabilityApplied of [false, true]) record(financialPath, financial.lines.warrantySettlementTemplates,
    `Buyer warranty refund ${liabilityApplied ? 'allocated to Wallet liability' : 'full Wallet credit'}`,
    f.warrantySettlementTemplates({ claimNumber: 'WAR-PREVIEW', orderNumber: 'ORD-PREVIEW', liabilityApplied }),
    { group: 'Warranty', route: `/user-dashboard/order/detail/${IDS.order}?warrantyId=${IDS.request}` });
  record(financialPath, financial.lines.warrantySettlementTemplates, 'Seller warranty settlement',
    f.warrantySettlementTemplates({ claimNumber: 'WAR-PREVIEW', orderNumber: 'ORD-PREVIEW', seller: true }),
    { role: 'seller', group: 'Warranty', route: `/seller-dashboard/order-management?tab=warranty&warrantyId=${IDS.request}` });
  }

  const withdrawalDeps = { ...deps,
    withdrawalRequestedSnapshot: () => money('requested_amount', 200000), withdrawalPayoutSnapshot: () => money('payout_amount', 200000) };
  const payouts = declarations(financialPath, ['withdrawalTemplates', 'withdrawalMoney', 'enqueueWithdrawalRequestedSellerNotifications',
    'enqueueWithdrawalStatusSellerNotifications', 'enqueueWithdrawalRequestedAdminNotifications'], withdrawalDeps);
  const withdrawal = { _id: IDS.request, seller: IDS.seller, createdAt: NOW, adminNote: 'Sample transfer note' };
  await run(financialPath, 'Seller withdrawal requested', payouts.lines.enqueueWithdrawalRequestedSellerNotifications,
    () => payouts.result.enqueueWithdrawalRequestedSellerNotifications(withdrawal));
  for (const status of ['pending', 'approved', 'processing', 'manual_review', 'failed', 'paid', 'rejected', 'cancelled']) {
    await run(financialPath, `Withdrawal ${status.replace(/_/g, ' ')}`, payouts.lines.enqueueWithdrawalStatusSellerNotifications,
      () => payouts.result.enqueueWithdrawalStatusSellerNotifications({ ...withdrawal, status,
        adminOperations: [{ operationKey: `preview-${status}`, toStatus: status, appliedAt: NOW }] }));
  }
  await run(financialPath, 'Admin withdrawal request', payouts.lines.enqueueWithdrawalRequestedAdminNotifications,
    () => payouts.result.enqueueWithdrawalRequestedAdminNotifications(withdrawal, [IDS.admin], 'Alex Preview'));

  const walletParts = { total: money('wallet_amount'), available: money('wallet_available_credit', 90000),
    liabilityApplied: money('wallet_liability_applied', 30000), remainingLiability: money('wallet_remaining_liability', 0) };
  let walletLiability = false;
  const wallet = declarations(financialPath, ['enqueueWalletTransactionNotification'], { ...deps,
    walletCreditBreakdownSnapshots: () => ({ ...walletParts, liabilityApplied: money('wallet_liability_applied', walletLiability ? 30000 : 0) }),
    walletTransactionSnapshot: () => money('wallet_amount') });
  for (const variant of ['credit', 'credit liability', 'debit', 'debit balance adjustment']) {
    walletLiability = variant === 'credit liability';
    await run(financialPath, `Wallet ${variant}`, wallet.lines.enqueueWalletTransactionNotification,
      () => wallet.result.enqueueWalletTransactionNotification({ _id: IDS.request, user: IDS.buyer, direction: variant.startsWith('credit') ? 'credit' : 'debit',
        status: 'completed', completedAt: NOW, referenceId: 'TXN-PREVIEW', currency: 'PKR', amount: 1200,
        type: variant === 'debit balance adjustment' ? 'reversal' : variant === 'debit' ? 'order_payment' : 'top_up' }));
  }

  const order = { _id: IDS.order, user: IDS.buyer, orderId: 'ORD-PREVIEW', currency: 'PKR',
    createdAt: NOW, paymentMethod: 'cash_on_delivery', isPaid: false,
    confirmation: { token: 'preview-only-confirmation-token-0000000000' }, orderSummary: { subtotal: 1200, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 1200 },
    shippingInfo: { fullName: 'Sam Preview', email: 'buyer@example.invalid', phone: '+923001234567' },
    sellerPolicies: [{ seller: IDS.seller, storeName: 'Atlas Aura' }], orderItems: [{ seller: IDS.seller, name: 'Travel Mug', price: 1200, lineSubtotal: 1200, quantity: 1, selectedOptions: { Color: 'Blue' } }] };
  // The real interactive builders have no DB/network dependencies; their
  // output is captured and rendered, never submitted.
  const messageBuilder = pureSourceModule('services/whatsapp/messageBuilder.js');
  const cod = declarations(financialPath, ['isValidSnapshotEmail', 'buyerReceiptChannels', 'buyerOrderRecipient', 'enqueueCodOrderBuyerConfirmationNotification'],
    { ...deps, orderTotalSnapshot: () => money('order_total'), buyerOrderMessage, friendlyBuyerOrderCopy: async () => true, ...messageBuilder });
  await run(financialPath, 'Buyer COD confirmation', cod.lines.enqueueCodOrderBuyerConfirmationNotification,
    () => cod.result.enqueueCodOrderBuyerConfirmationNotification(order));

  const cancellationPath = 'services/buyerCancellationService.js';
  const capability = require('../services/safepayRefundCapabilityService');
  const rail = require('../services/safepayPaymentRailService');
  const cancellation = declarations(cancellationPath, ['notifyCancellation'], { ...deps,
    normalizeSafepayPaymentRail: rail.normalizeSafepayPaymentRail,
    externalRefundCapability: capability.externalRefundCapability, originalPaymentLabel: capability.originalPaymentLabel });
  for (const [label, destination, completed, paymentRail, deductionMinor] of [
    ['COD no refund', 'none', false, 'unknown', 0], ['Wallet full refund', 'wallet', true, 'unknown', 0],
    ['Raast cancellation full Wallet refund', 'wallet', true, 'raast', 0],
    ['Card cancellation full Wallet refund', 'wallet', true, 'card', 0],
    ['Card refund pending', 'original_card', false, 'card', 10440], ['Card refund completed', 'original_card', true, 'card', 10440],
    ['Card refund pending — no deduction', 'original_card', false, 'card', 0], ['Card refund completed — no deduction', 'original_card', true, 'card', 0],
    ['Raast original refund requires review', 'original_card', false, 'raast', 0],
    ['Unknown original payment requires review', 'original_card', false, 'unknown', 0],
  ]) {
    activity = ['raast', 'unknown'].includes(paymentRail) && destination === 'original_card' ? 'exception' : 'active';
    await run(cancellationPath, label, cancellation.lines.notifyCancellation, () => cancellation.result.notifyCancellation({
    _id: IDS.request, buyer: IDS.buyer, seller: IDS.seller, currency: 'PKR', refundDestination: destination,
    refundStatus: destination === 'none' ? 'not_required' : completed ? 'completed' : 'pending',
    amountMinor: 120000, refundAmountMinor: destination === 'original_card' ? 120000 - deductionMinor : 120000,
    requestedAt: NOW, refundedAt: NOW, deductionMinor, paymentRail }, order, { completed }));
  }
  activity = 'active';
  await run(cancellationPath, 'Multi-store cancellation full Wallet refund', cancellation.lines.notifyCancellation,
    () => cancellation.result.notifyCancellation({ _id: IDS.request, buyer: IDS.buyer, seller: IDS.seller,
      currency: 'PKR', refundDestination: 'wallet', refundStatus: 'refunded', amountMinor: 120000,
      refundAmountMinor: 120000, requestedAt: NOW, refundedAt: NOW, deductionMinor: 0, paymentRail: 'raast' },
    { ...order, orderItems: [...order.orderItems, { seller: '000000000000000000000009', name: 'Notebook', quantity: 1 }] }, { completed: true }));

  const refundPath = 'services/safepayRefundService.js';
  const refund = declarations(refundPath, ['notifyRefund'], deps);
  for (const sellerId of [null, IDS.seller]) await run(refundPath, `${sellerId ? 'Seller' : 'Buyer'} Safepay card refund confirmed`, refund.lines.notifyRefund,
    () => refund.result.notifyRefund({ payment: { _id: IDS.request, currency: 'PKR' }, order, evidence: { amountMinor: 120000, occurredAt: NOW },
      record: { _id: IDS.request }, sellerIndex: sellerId ? 0 : null, sellerId, amountMinor: 120000 }));

  const adminQuery = { select() { return this; }, lean: async () => [{ _id: IDS.admin }] };
  const safetyPath = 'services/safepaySafetyRefundService.js';
  const safety = declarations(safetyPath, ['notifyRefundReview'], { ...deps,
    require: name => name === '../models/User' ? { find: () => adminQuery } : blocked(name) });
  for (const notSubmitted of [true, false]) await run(safetyPath,
    `Admin Safepay refund ${notSubmitted ? 'not submitted' : 'outcome reconciliation'}`, safety.lines.notifyRefundReview,
    () => safety.result.notifyRefundReview({ _id: IDS.request, amountMinor: 120000, currency: 'PKR', safetyRefund: { requestedAt: NOW } }, { notSubmitted }));
  const cancellationReviewPath = 'services/cancellationRefundService.js';
  const review = callExpressions(cancellationReviewPath, 'enqueueNotificationEvent');
  if (review.length !== 1) throw new Error('Cancellation-review producer inventory changed.');
  await run(cancellationReviewPath, 'Admin cancellation refund needs review', review[0].line, () => evaluateCall(cancellationReviewPath, review[0], {
    ...deps, admin: { _id: IDS.admin }, order, row: { _id: IDS.request, requestedAt: NOW, currency: 'PKR', refundAmountMinor: 109560 },
    refundMinor: () => 109560, session: null,
    require: name => name === './notificationOutboxService' ? { enqueueNotificationEvent: capture }
      : name === './notificationMoneySnapshotService' ? snapshot : blocked(name) }));

  const returnsPath = 'services/returnNotificationService.js';
  const returnLabels = declarations('services/returnPolicyService.js', ['RETURN_STATUS_LABELS'], deps).result.RETURN_STATUS_LABELS;
  const returns = declarations(returnsPath, ['notificationBody', 'buyerReturnLink', 'sellerReturnLink', 'statusNotificationOccurrence',
    ...(source(returnsPath).text.includes('const RETURN_NOTIFICATION_COPY') ? ['RETURN_NOTIFICATION_COPY'] : []),
    ...(source(returnsPath).text.includes('const WARRANTY_NOTIFICATION_COPY') ? ['WARRANTY_NOTIFICATION_COPY'] : []),
    'snapshotPhone', 'snapshotEmail', 'notifySellerReturnRequested', 'enqueueReturnCancellationNotifications', 'notifyBuyerReturnStatus'], {
    ...deps, RETURN_STATUS_LABELS: returnLabels, sellerTemplates: pureSourceModule('services/whatsapp/sellerMessageTemplates.js'),
    enqueueReturnSettlementNotifications: () => blocked('return settlement belongs to captured financial templates') });
  const request = { _id: IDS.request, order: IDS.order, orderId: 'ORD-PREVIEW', seller: IDS.seller, buyer: IDS.buyer,
    returnNumber: 'RET-PREVIEW', createdAt: NOW, requestedAt: NOW, reasonDetails: 'The item arrived damaged.', refund: { totalAmount: 1200 }, currency: 'PKR' };
  await run(returnsPath, 'Seller new return request', returns.lines.notifySellerReturnRequested, () => returns.result.notifySellerReturnRequested(request, order));
  await run(returnsPath, 'Return cancelled by buyer', returns.lines.enqueueReturnCancellationNotifications, () => returns.result.enqueueReturnCancellationNotifications({
    ...request, status: 'cancelled_by_buyer', statusHistory: [{ status: 'cancelled_by_buyer', changedAt: NOW, note: 'I decided to keep the item.' }] }, order));
  for (const status of Object.keys(returnLabels).filter(value => !['returned', 'cancelled_by_buyer'].includes(value))) {
    await run(returnsPath, `Buyer ${returnLabels[status].toLowerCase()}`, returns.lines.notifyBuyerReturnStatus,
      () => returns.result.notifyBuyerReturnStatus({ ...request, status, statusHistory: [{ status, changedAt: NOW, note: 'Sample status update.' }] }, order));
  }
  if (returns.result.WARRANTY_NOTIFICATION_COPY) {
  const claim = { ...request, kind: 'warranty', returnNumber: 'WAR-PREVIEW', appealVersion: 0 };
  await run(returnsPath, 'Seller new warranty claim', returns.lines.notifySellerReturnRequested, () => returns.result.notifySellerReturnRequested(claim, order));
  await run(returnsPath, 'Seller original warranty appeal', returns.lines.notifySellerReturnRequested, () => returns.result.notifySellerReturnRequested({ ...claim, status: 'requested', appealVersion: 1, statusHistory: [{ status: 'requested', changedAt: NOW }] }, order));
  for (const status of Object.keys(returnLabels).filter(value => !['returned', 'cancelled_by_buyer'].includes(value))) await run(returnsPath,
    `Buyer warranty ${status.replace(/_/g, ' ')}`, returns.lines.notifyBuyerReturnStatus,
    () => returns.result.notifyBuyerReturnStatus({ ...claim, status, resolution: 'replacement', statusHistory: [{ status, changedAt: NOW, note: 'Your item will be replaced under the purchased warranty.' }] }, order));
  await run(returnsPath, 'Buyer warranty approved for Wallet refund', returns.lines.notifyBuyerReturnStatus,
    () => returns.result.notifyBuyerReturnStatus({ ...claim, status: 'approved', resolution: 'refund', statusHistory: [{ status: 'approved', changedAt: NOW, note: 'Your original purchase amount will be refunded to Rozare Wallet.' }] }, order));
  await run(returnsPath, 'Warranty cancelled by buyer', returns.lines.enqueueReturnCancellationNotifications,
    () => returns.result.enqueueReturnCancellationNotifications({ ...claim, status: 'cancelled_by_buyer', statusHistory: [{ status: 'cancelled_by_buyer', changedAt: NOW, note: 'I decided to keep the product.' }] }, order));
  }

  const operationalPath = 'services/sellerOperationalNotificationService.js';
  const operational = declarations(operationalPath, ['DEFAULT_CHANNELS', 'requiredText', 'optionalText', 'requiredDate', 'eventDigest', 'sellerRecipient',
    'sellerMetadata', 'requiredPayoutCurrency', 'optionalDestinationLast4', 'enqueueSellerWelcomeNotification', 'enqueueStoreCreatedNotification',
    'VERIFICATION_EVENT', 'enqueueStoreVerificationNotification', 'enqueueNewStoreReviewNotification', 'enqueuePayoutAccountUpdatedNotification', 'enqueueProductBlockedNotification'],
  { ...deps, storefrontNotificationUrl, SUPPORTED_PAYOUT_CURRENCIES: new Set(['PKR', 'USD', 'EUR', 'GBP']) });
  const store = { _id: IDS.store, seller: IDS.seller, storeName: 'Atlas Aura', storeSlug: 'atlas-aura',
    isActive: true, moderationStatus: 'approved', createdAt: NOW };
  for (const storeName of ['', 'Atlas Aura']) await run(operationalPath, `Seller welcome ${storeName ? 'with store' : 'without store'}`,
    operational.lines.enqueueSellerWelcomeNotification, () => operational.result.enqueueSellerWelcomeNotification({ _id: IDS.seller, sellerWelcomeNotice: { occurredAt: NOW, storeName } }));
  for (const moderationStatus of ['approved', 'pending', 'blocked']) await run(operationalPath, `Store created — ${moderationStatus}`,
    operational.lines.enqueueStoreCreatedNotification, () => operational.result.enqueueStoreCreatedNotification({ ...store, moderationStatus }));
  for (const decision of ['approved', 'rejected', 'removed']) await run(operationalPath, `Store verification ${decision}`,
    operational.lines.enqueueStoreVerificationNotification, () => operational.result.enqueueStoreVerificationNotification({ ...store, verification: { reviewedAt: NOW, rejectionReason: 'Update your legal profile.' } }, decision));
  await run(operationalPath, 'Verified-buyer store rating', operational.lines.enqueueNewStoreReviewNotification,
    () => operational.result.enqueueNewStoreReviewNotification({ store, buyerName: 'Sam Preview', review: { _id: IDS.request, store: IDS.store, rating: 5, createdAt: NOW } }));
  for (const accountNumberLast4 of ['', '1234']) await run(operationalPath, `Payout account updated${accountNumberLast4 ? ' — masked destination' : ''}`,
    operational.lines.enqueuePayoutAccountUpdatedNotification, () => operational.result.enqueuePayoutAccountUpdatedNotification({
      account: { _id: IDS.request, seller: IDS.seller, bankName: 'Example Bank', currency: 'PKR', accountNumberLast4 }, occurredAt: NOW, changeFingerprint: 'preview-change-0001' }));
  await run(operationalPath, 'Product listing needs changes', operational.lines.enqueueProductBlockedNotification,
    () => operational.result.enqueueProductBlockedNotification({ _id: IDS.request, seller: IDS.seller,
      moderationNotice: { reviewedAt: NOW, productName: 'Preview product', reason: 'Correct the product details.' } }));

  const moderationPath = 'services/catalogModerationNotificationService.js';
  const moderation = declarations(moderationPath, [
    ...(source(moderationPath).text.includes('const MODERATION_NOTICE_REASONS') ? ['MODERATION_NOTICE_REASONS', 'moderationNoticeReason'] : []),
    'ensureCatalogModerationNotification'], { ...deps,
    require: name => ['../models/Store', '../models/Product'].includes(name) ? { updateOne: async () => ({ modifiedCount: 1 }) } : blocked(name) });
  for (const kind of ['product', 'store']) for (const status of ['approved', 'blocked', ...(includeApp ? ['pending'] : [])]) await run(moderationPath,
    `${kind === 'store' ? 'Store' : 'Product'} content ${status}`, moderation.lines.ensureCatalogModerationNotification,
    () => moderation.result.ensureCatalogModerationNotification(kind, { _id: IDS.request, seller: IDS.seller,
      catalogModeration: { noticeId: 'preview-decision', noticeAt: NOW, noticeStatus: status,
        violations: [{ code: 'profanity' }], noticeReason: 'Correct the flagged wording.' } }));

  const lifecyclePath = 'services/subscriptionLifecycleNotificationService.js';
  const lifecycle = declarations(lifecyclePath, ['stringId', 'safeText', 'requireDate', 'dateLabel', 'eventHash', 'sellerRecipient', 'subscriptionMoney',
    'requirePeriodDays', 'sameInstant', 'enqueueTrialExpiringNotification', 'enqueueTrialBlockedNotification', 'enqueueBonusLifecycleNotification'], deps);
  for (const hasUsedFreePeriod of [false, true]) {
    const sub = { _id: IDS.request, seller: IDS.seller, status: 'trial', trialEndDate: NOW, hasUsedFreePeriod,
      lifecyclePricing: { trialExpiring: { eventAt: NOW, starterFreePeriodDays: 30, starterStandardAmountMinor: 999, starterFounderAmountMinor: 599 } } };
    await run(lifecyclePath, `Seller trial ending — ${hasUsedFreePeriod ? 'intro used' : 'intro available'}`, lifecycle.lines.enqueueTrialExpiringNotification,
      () => lifecycle.result.enqueueTrialExpiringNotification(sub));
    await run(lifecyclePath, `Seller trial ended — ${hasUsedFreePeriod ? 'intro used' : 'intro available'}`, lifecycle.lines.enqueueTrialBlockedNotification,
      () => lifecycle.result.enqueueTrialBlockedNotification({ ...sub, status: 'blocked', blockedReason: 'Trial period expired' }));
    for (const kind of ['expiring', 'expired', 'removed']) {
      const pricingKey = { expiring: 'bonusExpiring', expired: 'bonusExpired', removed: 'bonusRemoved' }[kind];
      await run(lifecyclePath, `Starter bonus ${kind} — ${hasUsedFreePeriod ? 'intro used' : 'intro available'}`, lifecycle.lines.enqueueBonusLifecycleNotification,
        () => lifecycle.result.enqueueBonusLifecycleNotification({ ...sub, lifecyclePricing: { [pricingKey]: { eventAt: NOW, eliteFreePeriodDays: 45, eliteAmountMinor: 2165 } } }, { kind, sourceDate: NOW }));
    }
  }

  const billingPath = 'services/safepayBillingService.js';
  const billing = declarations(billingPath, ['notifyOperation'], { ...deps, minor: value => value });
  const op = { _id: IDS.request, seller: IDS.seller, terms: { dueMinor: 2565 }, appliedAt: NOW };
  const operationCalls = callExpressions(billingPath, 'notifyOperation');
  if (operationCalls.length !== 2) throw new Error('Safepay operation notification inventory changed.');
  for (const trialDays of [0, 45]) await run(billingPath, trialDays ? 'Safepay subscription trial started' : 'Safepay subscription updated', operationCalls[0].line,
    () => evaluateCall(billingPath, operationCalls[0], { notifyOperation: billing.result.notifyOperation, operation: { ...op, terms: { dueMinor: trialDays ? 0 : 2565 } },
      terms: { trialDays, planName: 'Rozare Elite + Meta Ads' }, sub: { status: trialDays ? 'free_period' : 'active' }, session: null }));
  const failureFunction = source(billingPath).ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'failBillingPayment');
  let noticeExpression = null;
  visit(failureFunction, node => { if (node.type === 'VariableDeclarator' && node.id.name === 'notice') noticeExpression = source(billingPath).text.slice(node.init.start, node.init.end); });
  const renewalPolicy = noticeExpression ? pureSourceModule('services/safepayRenewalPolicy.js') : null;
  const failureBindings = (operation, subscription = {}, at = NOW) => ({ notifyOperation: billing.result.notifyOperation,
    op: operation, sub: subscription, at, session: null,
    ...(noticeExpression ? { notice: new vm.Script(`(${noticeExpression})`).runInNewContext({ op: operation, sub: subscription, at, renewalPolicy }) } : {}) });
  await run(billingPath, 'Safepay subscription payment failed', operationCalls[1].line, () => evaluateCall(billingPath, operationCalls[1], failureBindings(op)));
  if (renewalPolicy) for (let attempt = 1; attempt <= 4; attempt += 1) {
    const at = attempt === 1 ? NOW : new Date(NOW.getTime() + (attempt - 1) * 2 * 86400000 - 6 * 3600000);
    const recovery = { rootOperation: IDS.request, startedAt: NOW, cancelAt: renewalPolicy.cancellationDeadline(NOW), attempts: attempt };
    recovery.nextRetryAt = renewalPolicy.nextRetry(recovery, at);
    const subscription = { safepayBilling: { recovery } };
    const operation = { ...op, appliedAt: null, failedAt: at, terms: { ...op.terms, planName: 'Rozare Elite + Meta Ads' }, recoveryNotice: true };
    operation.recoveryNotice = renewalPolicy.failureNotice(subscription, operation, at).snapshot;
    await run(billingPath, `Safepay renewal failure — day ${[1, 3, 5, 7][attempt - 1]}`, operationCalls[1].line,
      () => evaluateCall(billingPath, operationCalls[1], failureBindings(operation, subscription, at)));
  }
  const billingLifecyclePath = 'services/safepayBillingLifecycleService.js';
  const billingLifecycle = declarations(billingLifecyclePath, ['notify'], { ...deps, minor: value => value, date: value => new Date(value) });
  const lifecycleCalls = callExpressions(billingLifecyclePath, 'notify');
  const sub = { _id: IDS.request, seller: IDS.seller, status: 'active', currentPeriodEnd: new Date('2026-10-15T10:00:00.000Z'),
    safepayBilling: { monthlyMinor: 2565, contractId: 'preview-contract', version: 1 }, save: async () => {} };
  for (const call of lifecycleCalls) for (const currentPaymentMayComplete of call.code.includes('currentPaymentMayComplete') ? [false, true] : [false]) for (const unpaid of call.code.includes('unpaid') ? [false, true] : [false]) {
    await run(billingLifecyclePath, `Safepay ${call.code.match(/, '([^']+)',/)[1].replace(/_/g, ' ')}${currentPaymentMayComplete ? ' — payment already in progress' : ''}${unpaid ? ' — unpaid renewal' : ''}`, call.line,
      () => evaluateCall(billingLifecyclePath, call, { notify: billingLifecycle.result.notify, sub, at: NOW, endedAt: NOW,
        date: value => new Date(value), currentPaymentMayComplete, unpaid, session: null }));
  }

  const subdomainPath = 'services/safepaySubdomainService.js';
  const ownershipCalls = callExpressions(subdomainPath, 'enqueueNotificationEvent');
  if (ownershipCalls.length !== 1) throw new Error('Safepay subdomain receipt inventory changed.');
  // title/message declarations are lifted from source, not paraphrased.
  const ownershipFile = source(subdomainPath);
  let ownershipVars;
  visit(ownershipFile.ast, node => {
    if (node.type === 'VariableDeclaration' && node.declarations.some(entry => entry.id.name === 'message')
      && ownershipFile.text.slice(node.start, node.end).includes('grant.resourceKey')) ownershipVars = node;
  });
  if (!ownershipVars) throw new Error('Safepay subdomain receipt message moved.');
  const titleNode = ownershipFile.ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'settle').body.body
    .find(node => node.type === 'VariableDeclaration' && node.declarations.some(entry => entry.id.name === 'title'));
  if (!titleNode) throw new Error('Safepay subdomain receipt title moved.');
  const ownershipContext = { ...deps, payment: { _id: IDS.request, user: IDS.seller, amountMinor: 1500 }, store,
    grant: { _id: IDS.request, resourceKey: 'atlas-aura', grantEnd: new Date('2029-10-12T10:00:00.000Z'), createdAt: NOW }, session: null };
  const ownershipPrefix = `${ownershipFile.text.slice(titleNode.start, titleNode.end)}\n${ownershipFile.text.slice(ownershipVars.start, ownershipVars.end)}`;
  await run(subdomainPath, 'Safepay subdomain ownership receipt', ownershipCalls[0].line, () => {
    const context = vm.createContext({ Date, Object, Array, Number, String, ...ownershipContext });
    return new vm.Script(`(async()=>{${ownershipPrefix};return ${ownershipCalls[0].code}})()`).runInContext(context, { timeout: 1000 });
  });
  const domainLifecyclePath = 'services/subdomainLifecycleNotificationService.js';
  const domain = declarations(domainLifecyclePath, ['stringId', 'requireNoticeSlug', 'requireNoticeDate', 'eventDigest', 'sellerRecipient',
    'enqueueSubdomainOwnershipExpiredNotification', 'enqueueSubdomainRemovedNotification'], deps);
  const domainStore = { ...store, subdomainPurchase: { expiryNotice: { slug: 'atlas-aura', expiresAt: NOW }, removalNotice: { previousSlug: 'atlas-aura', removedAt: NOW } } };
  await run(domainLifecyclePath, 'Subdomain ownership expired', domain.lines.enqueueSubdomainOwnershipExpiredNotification,
    () => domain.result.enqueueSubdomainOwnershipExpiredNotification(domainStore));
  await run(domainLifecyclePath, 'Subdomain removed', domain.lines.enqueueSubdomainRemovedNotification,
    () => domain.result.enqueueSubdomainRemovedNotification(domainStore));

  activity = 'legacy';
  const legacyFinancial = declarations(financialPath, ['orderStockRefundBuyerTemplates', 'enqueueSubscriptionPaymentNotification',
    'enqueueSubdomainPaymentNotification', 'enqueueSubscriptionCancellationNotification'], { ...deps,
    subscriptionCapturedSnapshot: () => money('invoice_paid', 999, 'USD'),
    stripeEntitlementCapturedSnapshot: () => money('subdomain_paid', 1500, 'USD') });
  record(financialPath, legacyFinancial.lines.orderStockRefundBuyerTemplates, 'Retained old-provider stock refund',
    legacyFinancial.result.orderStockRefundBuyerTemplates('ORD-PREVIEW'));
  for (const kind of ['received', 'recovered']) await run(financialPath, `Retained invoice payment ${kind}`,
    legacyFinancial.lines.enqueueSubscriptionPaymentNotification,
    () => legacyFinancial.result.enqueueSubscriptionPaymentNotification({ _id: IDS.request, seller: IDS.seller, createdAt: NOW }, { kind, planName: 'Rozare Starter' }));
  await run(financialPath, 'Retained old-provider subdomain payment', legacyFinancial.lines.enqueueSubdomainPaymentNotification,
    () => legacyFinancial.result.enqueueSubdomainPaymentNotification({ _id: IDS.request, seller: IDS.seller, store: IDS.store,
      entitlementType: 'subdomain', resourceKey: 'atlas-aura', grantEnd: new Date('2029-10-12T10:00:00.000Z'), createdAt: NOW }, store));
  await run(financialPath, 'Retained old-provider subscription ended', legacyFinancial.lines.enqueueSubscriptionCancellationNotification,
    () => legacyFinancial.result.enqueueSubscriptionCancellationNotification({ _id: IDS.request, seller: IDS.seller, planName: 'Rozare Starter',
      stripeSubscriptionId: 'sub_preview', status: 'blocked', cancellationTransition: { stripeSubscriptionId: 'sub_preview', cancelledAt: NOW } }));

  const retainedLifecycle = declarations(lifecyclePath, ['stringId', 'safeText', 'requireDate', 'dateLabel', 'eventHash', 'sellerRecipient',
    'subscriptionMoney', 'enqueueSubscriptionEndingNotification', 'enqueuePlanChangeNotification',
    'enqueueSubscriptionPaymentFailureNotification', 'enqueueSubscriptionActivationNotification', 'enqueueSubscriptionDowngradeScheduledNotification'],
  { ...deps, FOUNDER_PROMOTION: { discountPercent: 30 } });
  const legacySub = { _id: IDS.request, seller: IDS.seller, stripeSubscriptionId: 'sub_preview' };
  for (const kind of ['completed', 'action_required']) await run(lifecyclePath, `Retained plan change ${kind.replace('_', ' ')}`,
    retainedLifecycle.lines.enqueuePlanChangeNotification,
    () => retainedLifecycle.result.enqueuePlanChangeNotification({ ...legacySub,
      planChangeAttempt: { idempotencyToken: 'preview-attempt', state: kind === 'completed' ? 'applied' : 'pending_payment',
        stripeInvoiceId: 'in_preview', targetPlanName: 'Rozare Elite', targetUnitAmountMinor: 2165, completedAt: NOW, startedAt: NOW } },
    { kind, attemptToken: 'preview-attempt', invoiceId: kind === 'action_required' ? 'in_preview' : '' }));
  await run(lifecyclePath, 'Retained invoice payment failed', retainedLifecycle.lines.enqueueSubscriptionPaymentFailureNotification,
    () => retainedLifecycle.result.enqueueSubscriptionPaymentFailureNotification({ ...legacySub, status: 'past_due', paymentRisk: { suspended: true,
      latestFailureInvoiceId: 'in_preview', failureNotification: { invoiceId: 'in_preview', occurredAt: NOW, planName: 'Rozare Starter',
        amountDueMinor: 999, currency: 'USD', stripeSubscriptionId: 'sub_preview' } } }, { invoiceId: 'in_preview' }));
  for (const kind of ['checkout_activation', 'automatic_downgrade']) for (const freePeriodDays of [0, 30]) {
    await run(lifecyclePath, `Retained ${kind.replace('_', ' ')} — ${freePeriodDays ? 'introductory' : 'paid'}`,
      retainedLifecycle.lines.enqueueSubscriptionActivationNotification,
      () => retainedLifecycle.result.enqueueSubscriptionActivationNotification({ ...legacySub, status: freePeriodDays ? 'free_period' : 'active',
        activationNotification: { kind, sourceReference: 'preview-source', stripeSubscriptionId: 'sub_preview', occurredAt: NOW,
          recurringAmountMinor: 999, currency: 'USD', freePeriodDays, planName: 'Rozare Starter' } }));
  }
  for (const founderRateApplied of [false, true]) for (const starterBonusEligible of [false, true]) {
    await run(lifecyclePath, `Retained downgrade scheduled — ${founderRateApplied ? 'founder' : 'standard'} / ${starterBonusEligible ? 'bonus available' : 'bonus used'}`,
      retainedLifecycle.lines.enqueueSubscriptionDowngradeScheduledNotification,
      () => retainedLifecycle.result.enqueueSubscriptionDowngradeScheduledNotification({ ...legacySub, pendingDowngrade: {
        toPlan: 'starter', operationKey: 'preview-operation', sourceStripeSubscriptionId: 'sub_preview', scheduledAt: NOW, stripeScheduledAt: NOW,
        targetUnitAmountMinor: founderRateApplied ? 999 : 1399, targetCurrency: 'usd', founderRateApplied,
        founderDiscountPercent: founderRateApplied ? 30 : 0, starterBonusEligible, targetPlanName: 'Rozare Starter' } }));
  }
  activity = 'active';
  for (const founderActive of [false, true]) await run(lifecyclePath,
    `Safepay subscription ending soon — ${founderActive ? 'founder' : 'standard'}`,
    retainedLifecycle.lines.enqueueSubscriptionEndingNotification,
    () => retainedLifecycle.result.enqueueSubscriptionEndingNotification({ _id: IDS.request, seller: IDS.seller,
      billingProvider: 'safepay', safepayBilling: { contractId: 'preview-safepay-contract', environment: 'sandbox', autoRenew: false },
      status: 'active', cancelledAt: NOW, currentPeriodEnd: new Date('2026-10-15T10:00:00.000Z'),
      founderOffer: { active: founderActive } }, { now: NOW }));
  activity = 'active';

  for (const item of captured) {
    const { event } = item;
    for (const channel of ['email', 'whatsapp', ...(includeApp ? ['inapp', 'push'] : [])]) {
      if (!event.channels.includes(channel)) continue;
      // Render only with the authoritative production pure payload normalizer.
      const metadata = { ...(event.metadata || {}), data: JSON.parse(JSON.stringify(event.metadata?.data || {})) };
      const { payload } = renderer.normalizeChannelPayload({ channel, templates: event.templates, metadata,
        money: event.money || [], financial: event.financial === true, audienceRole: event.recipient.audienceRole });
      let after;
      if (channel === 'email') after = { subject: payload.subject,
        html: OLD_EMAIL ? (payload.html || `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(payload.text)}</pre>`)
          : prepareTransactionalEmail({ subject: payload.subject, html: payload.html, text: payload.text,
            actionUrl: outboundNotificationUrl(payload.linkTo), actionLabel: notificationActionLabel(payload.linkTo) }) };
      else if (channel === 'inapp' || channel === 'push') {
        after = { title: payload.title, message: payload.body, linkTo: payload.linkTo, footer: '', buttons: [] };
      } else {
        after = { message: payload.message, title: '', footer: '', buttons: [] };
        if (payload.whatsappButtonsPayloadJson) {
          const interactive = JSON.parse(payload.whatsappButtonsPayloadJson);
          // COD delivery uses the frozen interactive payload, not the plain
          // outbox text. Preserve its actual product/address body.
          after.message = interactive.description || interactive.text || payload.message;
          after.title = interactive.title || ''; after.footer = interactive.footer || '';
          after.buttons = (interactive.buttons || []).map(button => button.displayText || button.buttonText?.displayText || button.text || '').filter(Boolean);
        }
      }
      if (channel === 'email' && (!after.subject || !after.html) || channel !== 'email' && !after.message) {
        throw new Error(`Empty source preview: ${channel}:${item.name}`);
      }
      const role = event.recipient.audienceRole;
      const name = item.name.includes('Return cancelled') || item.name.includes('Warranty cancelled') || item.name.includes('Card refund') || item.sourcePath.endsWith('buyerCancellationService.js')
        ? `${item.name} — ${role}` : item.name;
      entries.push({ channel, group: item.group || (event.metadata?.category === 'subscription' ? 'Subscriptions'
        : /[Ww]arranty/.test(name) ? 'Warranty' : /[Rr]eturn/.test(name) ? 'Returns' : /withdrawal|wallet/i.test(name) ? 'Wallet & payouts'
          : /[Ss]tore|[Pp]roduct|[Pp]ayout|[Ss]ubdomain|[Ss]eller welcome/.test(name) ? 'Stores & products' : 'Orders'),
        name, kind: 'Current source template', sourcePath: item.sourcePath, sourceLine: item.sourceLine,
        activity: item.activity || 'active', captureMode: item.mode, eventType: event.eventType || 'source.template_builder',
        audienceRole: role,
        after, changed: false, comparison: SOURCE_REVISION ? 'Source snapshot' : 'Current source only',
        ...(item.activity === 'exception' ? { note: 'Exception reference only. New Raast cancellations use the full Rozare Wallet refund; this original-account request is not offered by the normal flow.' } : {}) });
    }
  }
  const keys = entries.map(entry => `${entry.channel}:${entry.name}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate current-source gallery names.');
  return entries;
}

module.exports = { buildRuntimeNotificationGalleryEntries, coverageMatrix: COVERAGE, exclusions: EXCLUSIONS,
  notificationCallSiteInventory, runtimeGalleryCounts, sourceRevision: SOURCE_REVISION, oldEmailMode: OLD_EMAIL };
