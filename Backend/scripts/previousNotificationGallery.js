'use strict';

// Read-only comparison against the commit preceding the local template edits.
// The snapshot is pinned so a later commit cannot silently redefine "Old".
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const { escapeHtml } = require('../utils/transactionalEmail');

const BASELINE = 'e7169e0577ac8b49b2ece10cccdf4247012a06bc';
const root = path.resolve(__dirname, '../..');
const sourceAt = repositoryPath => execFileSync('git', ['show', `${BASELINE}:${repositoryPath}`], {
  cwd: root, encoding: 'utf8', maxBuffer: 2_000_000,
});
const moduleAt = repositoryPath => {
  const absolutePath = path.join(root, repositoryPath);
  const module = { exports: {} };
  const code = sourceAt(repositoryPath);
  const run = new Function('require', 'module', 'exports', 'process', '__dirname', code);
  run(createRequire(absolutePath), module, module.exports, process, path.dirname(absolutePath));
  return module.exports;
};

const htmlLiterals = repositoryPath => [...sourceAt(repositoryPath).matchAll(/const html = `([\s\S]*?)`;/g)]
  .map(match => match[1]);
const renderLiteral = (literal, variables) => {
  const names = Object.keys(variables);
  const values = Object.values(variables);
  return new Function(...names, `return \`${literal}\`;`)(...values);
};

const baselineEmailTemplates = moduleAt('Backend/utils/emailTemplates.js');
const buyerAndSellerCodes = htmlLiterals('Backend/controllers/authController.js');
const passwordMessages = htmlLiterals('Backend/controllers/ResetPasswordController.js');
const emailChangeMessages = htmlLiterals('Backend/controllers/userController.js');
if (buyerAndSellerCodes.length !== 2 || passwordMessages.length !== 2 || emailChangeMessages.length !== 1) {
  throw new Error('The pinned account-email baseline no longer matches the comparison source.');
}

const oldEmailTemplateByName = sampleOrder => {
  const values = new Map([
    ['Buyer signup code', { subject: 'Verify Your Email - Rozare', html: renderLiteral(buyerAndSellerCodes[0], { username: 'Sam', otp: '123456', escapeHtml, Date }) }],
    ['Seller signup code', { subject: 'Verify Your Seller Account - Rozare', html: renderLiteral(buyerAndSellerCodes[1], { username: 'Alex', otp: '654321', escapeHtml, Date }) }],
    ['Seller email-change code', { subject: 'Verify Your New Email - Rozare', html: renderLiteral(emailChangeMessages[0], { user: { username: 'Alex' }, otpCode: '345678', Date }) }],
    ['Password reset', { subject: 'Password reset instructions', html: renderLiteral(passwordMessages[0], { user: { username: 'Sam' }, resetURL: 'https://rozare.com/reset-password/preview-only', Date }) }],
    ['Password changed', { subject: 'Password successfully changed.', html: renderLiteral(passwordMessages[1], { user: { username: 'Sam' }, goToAuthUrl: 'https://rozare.com/auth', Date }) }],
    ['Buyer welcome', baselineEmailTemplates.welcomeEmail('Sam')],
    ['Seller welcome (retained export)', baselineEmailTemplates.sellerAccountCreatedEmail('Alex')],
    ['Announcement', baselineEmailTemplates.broadcastEmail('A Rozare update', 'Here is a sample platform announcement.', 'announcement', '/user-dashboard/notifications')],
    ['Promotion', baselineEmailTemplates.broadcastEmail('A store promotion', 'Here is a sample offer. Actual promotion terms come from the administrator.', 'promo', '/marketplace')],
    ['System update', baselineEmailTemplates.broadcastEmail('Service update', 'Here is a sample service notice.', 'system', '/user-dashboard/notifications')],
    ['Order broadcast', baselineEmailTemplates.broadcastEmail('Order information', 'Here is a sample order-related administrator announcement.', 'order', '/user-dashboard/orders')],
    ['Seller broadcast', baselineEmailTemplates.broadcastEmail('Seller information', 'Here is a sample seller-related administrator announcement.', 'seller', '/seller-dashboard/store-overview')],
    ['Announcement without action link', baselineEmailTemplates.broadcastEmail('A Rozare update', 'Here is a sample platform announcement without a call-to-action link.', 'announcement', '')],
    ['Order receipt (retained export)', baselineEmailTemplates.orderConfirmationEmail(sampleOrder)],
    ['New seller order (retained export)', baselineEmailTemplates.newOrderSellerEmail(sampleOrder, 'Alex')],
    ['Buyer COD decision (retained export)', baselineEmailTemplates.buyerOrderConfirmationRequestEmail(sampleOrder, 'https://rozare.com/orders/confirm/preview-only')],
    ['Buyer confirmed for seller (retained export)', baselineEmailTemplates.sellerOrderConfirmedByBuyerEmail(sampleOrder, 'Alex')],
  ]);
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']) {
    values.set(`Order ${status} (retained export)`, baselineEmailTemplates.orderStatusUpdateEmail(sampleOrder, status));
  }
  return values;
};

const plainParagraph = value => escapeHtml(value).replace(/\n\s*\n/g, '</p><p>').replace(/\n/g, '<br>');
const oldIllustrativeEmail = entry => {
  const earlierText = {
    'Seller paid-order receipt': 'You received paid order #ORD-PREVIEW. Frozen store-currency total: Rs1,199.02 PKR. Buyer checkout equivalent: $4.33 USD. Both values were frozen at checkout; neither is a live-FX bank-payout estimate.',
    'Seller COD order': 'You received cash on delivery order #ORD-PREVIEW. Frozen store-currency total: Rs1,200.00 PKR. Buyer checkout equivalent: Rs1,200.00 PKR. Payment has not been collected.',
    'Product blocked': 'Test Product was blocked because it requires a moderation correction. Customers cannot see it until the listing is corrected.',
    'Buyer order confirmed': 'Order #ORD-PREVIEW: Your order has been confirmed and is being prepared. Frozen order total: Rs1,200.00 PKR.',
    'Buyer order shipped': 'Order #ORD-PREVIEW: Your order has been handed to the courier and is on the way. Frozen order total: Rs1,200.00 PKR.',
    'Buyer order cancelled': 'Order #ORD-PREVIEW: You cancelled this order. This status does not by itself record or promise a refund. Frozen order total: Rs1,200.00 PKR.',
  }[entry.name] || entry.previewBody || '';
  return { subject: entry.subject, html: `<p>${plainParagraph(earlierText)}</p>` };
};

const oldBuyer = moduleAt('Backend/services/whatsapp/messageBuilder.js');
const oldSeller = moduleAt('Backend/services/whatsapp/sellerMessageTemplates.js');
const oldWhatsAppTemplateByName = (sampleOrder, sampleReturn) => {
  const values = new Map();
  const assign = (name, message, extra = {}) => values.set(name, { message, title: '', footer: '', buttons: [], ...extra });
  const buttons = oldBuyer.buildOrderButtonsPayload(sampleOrder);
  assign('COD order: confirm or cancel buttons', buttons.description, { title: buttons.title, footer: buttons.footer, buttons: buttons.buttons.map(row => row.displayText) });
  const list = oldBuyer.buildOrderListPayload(sampleOrder);
  assign('COD order: interactive list', list.description, { title: list.title, footer: list.footerText, buttons: list.sections.flatMap(section => section.rows.map(row => row.title)) });
  assign('COD order: legacy text summary', oldBuyer.buildOrderConfirmationMessage(sampleOrder));
  assign('Paid order information', oldBuyer.buildOrderPlacedInfoMessage({ ...sampleOrder, paymentMethod: 'safepay' }));
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']) {
    assign(`Buyer order ${status} (retained)`, oldBuyer.buildOrderStatusUpdateMessage(sampleOrder, status));
  }
  const reconfirm = oldBuyer.buildReconfirmButtonsPayload(sampleOrder, 'Hi Sam, this order was cancelled.');
  assign('Reconfirm a cancelled COD order', reconfirm.description, { title: reconfirm.title, footer: reconfirm.footer, buttons: reconfirm.buttons.map(row => row.displayText) });
  const sellerInputs = [
    ['Seller welcome', () => oldSeller.seller_welcome('Atlas Aura')],
    ['New seller order', () => oldSeller.new_order(sampleOrder)],
    ['Order confirmed for seller', () => oldSeller.order_confirmed(sampleOrder)],
    ['Order cancelled for seller', () => oldSeller.order_cancelled(sampleOrder)],
    ['Seller return request', () => oldSeller.return_requested(sampleReturn)],
    ['Seller return settlement', () => oldSeller.return_settled(sampleReturn, 'Rs1,200.00 PKR')],
    ['Subscription activated', () => oldSeller.subscription_activated('Rozare Starter', 30)],
    ['Subscription ending soon', () => oldSeller.subscription_ending_soon(7)],
    ['Subscription payment failed', () => oldSeller.payment_failed()],
    ['Subscription payment recovered', () => oldSeller.payment_recovered()],
    ['Plan change needs authentication', () => oldSeller.plan_change_action_required()],
    ['Seller trial expiring', () => oldSeller.trial_expiring(7)],
    ['Store unavailable', () => oldSeller.account_blocked('the subscription ended')],
    ['Product listing needs changes', () => oldSeller.product_blocked('Test Product', 'it looks like placeholder content')],
    ['Bonus features expiring', () => oldSeller.bonus_expiring(7)],
    ['Bonus features expired', () => oldSeller.bonus_expired()],
    ['Downgrade scheduled', () => oldSeller.downgrade_scheduled()],
    ['Elite upgrade completed', () => oldSeller.upgrade_completed()],
    ['Store verified', () => oldSeller.store_verified()],
  ];
  for (const [name, build] of sellerInputs) assign(name, build());
  return values;
};

const oldIllustrativeWhatsApp = entry => {
  const specific = {
    'Buyer WhatsApp code': '*Rozare WhatsApp Verification* 🔐\n\nYour verification code is: *123456*\n\nThis code expires in 2 minutes.\nDo not share this code with anyone.\n\nOnce verified, you can chat with Rozare AI directly on WhatsApp! 🤖💙',
    'Seller WhatsApp code': '*Rozare Verification*\n\nYour verification code is: *654321*\n\nThis code expires in 2 minutes.\nDo not share this code with anyone.',
    'Change seller WhatsApp number': '*Rozare Verification*\n\nYour verification code is: *345678*\n\nThis code expires in 2 minutes.\nDo not share this code with anyone.',
    'Buyer confirmed the order': '🎉 Awesome, Sam!\n\nYour order *#ORD-PREVIEW* is confirmed! ✅\n\nYou’ll get updates here as each seller prepares and ships your items.\n\nNeed anything? Just reply to this chat. Thanks for shopping with Rozare! 💙',
    'Buyer cancelled the order': 'Got it, Sam! 👍\n\nOrder *#ORD-PREVIEW* has been cancelled. ❌\n\nIf you change your mind, you can place a new order at rozare.com.\n\nHope to see you again soon! 💙 — Rozare',
    'Decision already confirmed': 'Hey Sam! 👋\n\nYou already *confirmed* this order — we’re processing it now. ✅\n\nNeed to change something? Contact support. 💙',
    'Typed reply cannot decide': 'Hi Sam 👋\n\nI didn’t quite catch that for order *#ORD-PREVIEW*.\n\nPlease use the Confirm order or Cancel order buttons. Typed replies are not accepted.',
    'Seller paid-order receipt': 'Paid Order Received\n\nOrder: #ORD-PREVIEW\nStore-currency total: Rs1,199.02 PKR\nBuyer checkout equivalent: $4.33 USD\n\nBoth values were frozen at checkout. Open Seller Dashboard to process the order.',
    'Seller COD order': 'New Cash on Delivery Order\n\nOrder: #ORD-PREVIEW\nStore-currency total: Rs1,200.00 PKR\nBuyer checkout equivalent: Rs1,200.00 PKR\nPayment has not been collected.\n\nOpen Seller Dashboard to review your items.',
    'Product blocked': 'Product Blocked\n\nTest Product was blocked because it looks like placeholder content.\n\nCustomers cannot see it until you correct the listing in Product Management.',
  }[entry.name];
  const message = specific || String(entry.message || '').replace(/\n\nView details: https:\/\/rozare\.com[^\n]*$/, '');
  return { message, title: entry.title || '', footer: entry.footer || '', buttons: entry.buttons || [] };
};

module.exports = { BASELINE, oldEmailTemplateByName, oldIllustrativeEmail,
  oldWhatsAppTemplateByName, oldIllustrativeWhatsApp };
