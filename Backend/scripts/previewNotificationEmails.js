'use strict';

// Local render samples only. Never sends an email or reads production data.
const fs = require('node:fs');
const path = require('node:path');
const { verificationCodeEmail, passwordResetEmail, passwordChangedEmail } = require('../utils/accountEmailTemplates');
const { prepareTransactionalEmail } = require('../utils/transactionalEmail');
const emailTemplates = require('../utils/emailTemplates');

const folder = path.resolve(__dirname, '../../test-assets/email-preview-2026-09-30');
fs.mkdirSync(folder, { recursive: true });
const examples = {
  'buyer-verification.html': verificationCodeEmail({ name: 'Sam', code: '123456', purpose: 'buyer_signup', expiresMinutes: 10 }).html,
  'seller-verification.html': verificationCodeEmail({ name: 'Alex', code: '654321', purpose: 'seller_signup', expiresMinutes: 10 }).html,
  'password-reset.html': passwordResetEmail({ name: 'Sam', resetUrl: 'https://rozare.com/reset-password/preview-only' }).html,
  'order-notification.html': prepareTransactionalEmail({
    subject: 'Your order is on its way',
    html: '<p>Order <strong>#ORD-PREVIEW</strong> was marked as shipped by Atlas Aura.</p><p>Your total for this store: <strong>Rs1,200.00 PKR</strong>.</p>',
    actionUrl: 'https://rozare.com/user-dashboard/orders',
  }),
  'text-only-notification.html': prepareTransactionalEmail({
    subject: 'Your store is ready for setup',
    text: 'Your seller account has been created.\n\nComplete store setup, add products and configure shipping in your seller dashboard.',
    actionUrl: 'https://rozare.com/seller-dashboard/store-overview',
  }),
};
for (const [filename, html] of Object.entries(examples)) {
  fs.writeFileSync(path.join(folder, filename), html, 'utf8');
}
console.log(`Rendered ${Object.keys(examples).length} local previews in ${folder}`);

// A single offline gallery makes the email styles and wording reviewable.
// Imported templates are rendered by their real functions. Notification
// specimens use documented dummy values in the shared production renderer;
// their badge makes that distinction explicit in the UI.
const sampleOrder = {
  _id: 'preview-only-order', orderId: 'ORD-PREVIEW', currency: 'PKR', paymentMethod: 'safepay',
  orderItems: [{ name: 'Travel Mug', price: 1000, lineSubtotal: 1000, quantity: 1,
    selectedOptions: { Color: 'Blue' } }],
  orderSummary: { subtotal: 1000, shippingCost: 200, tax: 0, couponDiscount: 0, totalAmount: 1200 },
  shippingInfo: { fullName: 'Sam Preview', address: '12 Example Street', city: 'Example City',
    state: 'Example State', postalCode: '12345', country: 'Example Country' },
  confirmation: { confirmedAt: new Date('2026-09-30T09:30:00.000Z') },
};
const entries = [];
const addActual = (group, name, result) => entries.push({ group, name, kind: 'Actual template',
  subject: result.subject, html: result.html });
const addSpecimen = (group, name, subject, body, route) => entries.push({ group, name,
  kind: 'Illustrative notification', subject, previewBody: body,
  html: prepareTransactionalEmail({ subject, text: body,
    actionUrl: route ? `https://rozare.com${route}` : '' }),
});

addActual('Account', 'Buyer signup code', verificationCodeEmail({ name: 'Sam', code: '123456', purpose: 'buyer_signup', expiresMinutes: 10 }));
addActual('Account', 'Seller signup code', verificationCodeEmail({ name: 'Alex', code: '654321', purpose: 'seller_signup', expiresMinutes: 10 }));
addActual('Account', 'Seller email-change code', verificationCodeEmail({ name: 'Alex', code: '345678', purpose: 'email_change', expiresMinutes: 10 }));
addActual('Account', 'Password reset', passwordResetEmail({ name: 'Sam', resetUrl: 'https://rozare.com/reset-password/preview-only' }));
addActual('Account', 'Password changed', passwordChangedEmail({ name: 'Sam', loginUrl: 'https://rozare.com/login' }));
addActual('Account', 'Buyer welcome', emailTemplates.welcomeEmail('Sam'));
addActual('Account', 'Seller welcome (retained export)', emailTemplates.sellerAccountCreatedEmail('Alex'));
addActual('Broadcast', 'Announcement', emailTemplates.broadcastEmail('A Rozare update', 'Here is a sample platform announcement.', 'announcement', '/user-dashboard/notifications'));
addActual('Broadcast', 'Promotion', emailTemplates.broadcastEmail('A store promotion', 'Here is a sample offer. Actual promotion terms come from the administrator.', 'promo', '/marketplace'));
addActual('Broadcast', 'System update', emailTemplates.broadcastEmail('Service update', 'Here is a sample service notice.', 'system', '/user-dashboard/notifications'));
addActual('Broadcast', 'Order broadcast', emailTemplates.broadcastEmail('Order information', 'Here is a sample order-related administrator announcement.', 'order', '/user-dashboard/orders'));
addActual('Broadcast', 'Seller broadcast', emailTemplates.broadcastEmail('Seller information', 'Here is a sample seller-related administrator announcement.', 'seller', '/seller-dashboard/store-overview'));
addActual('Broadcast', 'Announcement without action link', emailTemplates.broadcastEmail('A Rozare update', 'Here is a sample platform announcement without a call-to-action link.', 'announcement', ''));
addActual('Orders', 'Order receipt (retained export)', emailTemplates.orderConfirmationEmail(sampleOrder));
for (const status of ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']) {
  addActual('Orders', `Order ${status} (retained export)`, emailTemplates.orderStatusUpdateEmail(sampleOrder, status));
}
addActual('Orders', 'New seller order (retained export)', emailTemplates.newOrderSellerEmail(sampleOrder, 'Alex'));
addActual('Orders', 'Buyer COD decision (retained export)', emailTemplates.buyerOrderConfirmationRequestEmail(sampleOrder, 'https://rozare.com/orders/confirm/preview-only'));
addActual('Orders', 'Buyer confirmed for seller (retained export)', emailTemplates.sellerOrderConfirmedByBuyerEmail(sampleOrder, 'Alex'));

const buyerOrder = '/user-dashboard/order/detail/preview-only';
const sellerOrder = '/seller-dashboard/order/preview-only';
const buyerReturn = '/user-dashboard/orders';
const sellerReturn = '/seller-dashboard/order-management?tab=returns';
const subscription = '/seller-dashboard/subscription';
const payments = '/seller-dashboard/payments';
const wallet = '/user-dashboard/wallet';

for (const [status, detail] of [
  ['confirmed', 'Your order is confirmed. You will receive updates as your items are prepared and shipped.'],
  ['processing', 'Your order is being prepared. Watch for a shipping update.'],
  ['shipped', 'Your order was marked as shipped. Check the order details for each seller’s delivery progress.'],
  ['delivered', 'Your order was marked delivered.'],
  ['cancelled', 'You cancelled this order. Check the order details for any applicable payment or refund update.'],
]) addSpecimen('Orders', `Buyer order ${status}`, `Order ${status} - ORD-PREVIEW`, `Order #ORD-PREVIEW: ${detail}\n\nOrder total: Rs1,200.00 PKR.`, buyerOrder);
for (const [status, detail] of [
  ['confirmed', 'confirmed and accepted your items'],
  ['processing', 'is preparing your items'],
  ['shipped', 'shipped your items'],
  ['delivered', 'marked your items delivered'],
]) addSpecimen('Orders', `Seller shipment ${status}`, `Seller ${status} your items - ORD-PREVIEW`,
  `Order #ORD-PREVIEW: Atlas Aura ${detail}: Travel Mug (Blue).\n\nStandard shipping: 5 days. Your total for this store is Rs1,200.00 PKR.`, buyerOrder);
addSpecimen('Orders', 'Buyer paid-order receipt', 'Payment received for order ORD-PREVIEW',
  'Your payment for order #ORD-PREVIEW was successful. Charged total: Rs1,200.00 PKR.', buyerOrder);
addSpecimen('Orders', 'Seller paid-order receipt', 'Paid order received - ORD-PREVIEW',
  'You received paid order #ORD-PREVIEW. Your store total: Rs1,199.02 PKR. The buyer paid $4.33 USD for your items. Open Seller Dashboard to process your part of the order.', sellerOrder);
addSpecimen('Orders', 'Buyer no-charge order', 'Order confirmed - ORD-PREVIEW',
  'Order #ORD-PREVIEW is confirmed. Order total: Rs0.00 PKR. No payment was required or charged.', buyerOrder);
addSpecimen('Orders', 'Seller no-charge order', 'No-charge order received - ORD-PREVIEW',
  'Order #ORD-PREVIEW is confirmed. Your store total: Rs0.00 PKR. Buyer total for your items: Rs0.00 PKR. No buyer payment was required or collected.', sellerOrder);
addSpecimen('Orders', 'Seller COD order', 'New cash on delivery order - ORD-PREVIEW',
  'You received cash on delivery order #ORD-PREVIEW. Your store total: Rs1,200.00 PKR. Buyer total for your items: Rs1,200.00 PKR. Cash has not been collected. Wait for buyer confirmation before fulfillment.', sellerOrder);
addSpecimen('Orders', 'Buyer COD confirmation', 'Confirm cash on delivery order ORD-PREVIEW',
  'Review cash on delivery order #ORD-PREVIEW. Order total: Rs1,200.00 PKR. The delivered email has guarded Confirm Order and Cancel Order buttons.', buyerOrder);
for (const [status, message] of [
  ['confirmed', 'The buyer confirmed the cash on delivery order. No cash has been collected yet.'],
  ['cancelled', 'The buyer cancelled the cash on delivery order. Review your items for the saved cancellation state.'],
]) addSpecimen('Orders', `Seller COD ${status}`, `Buyer ${status} order - ORD-PREVIEW`,
  `Order #ORD-PREVIEW. Your store total: Rs1,200.00 PKR. Buyer total for your items: Rs1,200.00 PKR. ${message}`, sellerOrder);
addSpecimen('Orders', 'Legacy card stock refund', 'Card refund completed - ORD-PREVIEW',
  'Order #ORD-PREVIEW was cancelled because inventory was unavailable. The previous payment provider completed the Rs1,200.00 PKR refund to the original payment method. Bank posting times may vary.', buyerOrder);

addSpecimen('Returns', 'Seller new return request', 'New return request for order #ORD-PREVIEW',
  'Return #RET-PREVIEW was requested for order #ORD-PREVIEW. Sign in to review the affected items and respond.', sellerReturn);
addSpecimen('Returns', 'Seller return cancelled', 'Return #RET-PREVIEW was cancelled',
  'The buyer cancelled return #RET-PREVIEW for order #ORD-PREVIEW. Review the saved return record.', sellerReturn);
addSpecimen('Returns', 'Buyer return cancelled', 'Return #RET-PREVIEW cancelled',
  'Return #RET-PREVIEW was cancelled. Open your order to review its current status.', buyerReturn);
addSpecimen('Returns', 'Buyer return status updated', 'Return status updated: #RET-PREVIEW',
  'The status of return #RET-PREVIEW changed. Check the return record for the decision and next steps.', buyerReturn);
addSpecimen('Returns', 'Buyer refund and liability', 'Return refund completed - RET-PREVIEW',
  'Return #RET-PREVIEW for order #ORD-PREVIEW is complete. Refund total: Rs1,200.00 PKR. Available Wallet credit: Rs900.00 PKR. Applied to outstanding Wallet liability: Rs300.00 PKR. Remaining liability: Rs0.00 PKR.', buyerReturn);
addSpecimen('Returns', 'Buyer full Wallet refund', 'Return refund completed - RET-PREVIEW',
  'Return #RET-PREVIEW for order #ORD-PREVIEW is complete. Wallet credit: Rs1,200.00 PKR.', buyerReturn);
addSpecimen('Returns', 'Seller return settlement', 'Return completed - RET-PREVIEW',
  'Refund Rs1,200.00 PKR was processed for return #RET-PREVIEW, order #ORD-PREVIEW. Buyer Wallet allocation details remain private.', sellerReturn);

addSpecimen('Wallet & payouts', 'Wallet credit with liability', 'Wallet credit allocated',
  'Incoming credit: Rs1,200.00 PKR. Available Wallet credit: Rs900.00 PKR. Applied to outstanding Wallet liability: Rs300.00 PKR. Remaining liability: Rs0.00 PKR.', wallet);
addSpecimen('Wallet & payouts', 'Wallet credit', 'Wallet credited',
  'Rs1,200.00 PKR was credited to your Rozare Wallet. Reference: TXN-PREVIEW.', wallet);
addSpecimen('Wallet & payouts', 'Wallet payment', 'Wallet payment completed',
  'Rs1,200.00 PKR was debited from your Rozare Wallet. Reference: TXN-PREVIEW.', wallet);
addSpecimen('Wallet & payouts', 'Seller withdrawal requested', 'Withdrawal request received',
  'Requested: Rs2,000.00 PKR. Bank payout: Rs2,000.00 PKR. Status: Pending. Approval is not a completed transfer.', payments);
for (const [status, meaning] of [
  ['approved', 'The request is approved for manual transfer; this does not mean the bank transfer completed.'],
  ['rejected', 'The request was rejected. Review the note and your available balance.'],
  ['completed', 'The manual bank transfer was marked completed. Review its reference.'],
]) addSpecimen('Wallet & payouts', `Withdrawal ${status}`, `Withdrawal ${status}`,
  `Requested: Rs2,000.00 PKR. Bank payout: Rs2,000.00 PKR. Status: ${status}. ${meaning}`, payments);
addSpecimen('Wallet & payouts', 'Admin withdrawal request', 'New seller withdrawal request',
  'Alex requested Rs2,000.00 PKR. If approved, transfer exactly Rs2,000.00 PKR only to the frozen payout destination on this request.', '/admin-dashboard/payments');

const billingCases = [
  ['Seller trial ending', 'Seller trial ending soon', 'Your seller trial ends on 15 October. Subscribe to keep your store visible. Review the actual Starter price before checkout.'],
  ['Seller trial ended', 'Store blocked - seller trial ended', 'Your seller trial ended and your store is hidden until you subscribe.'],
  ['Subscription ending soon', 'Subscription ending soon', 'Your subscription is scheduled to end on 15 October. Your store stays available through the current access period.'],
  ['Bonus features expiring', 'Bonus features expiring', 'Your Starter bonus features expire in seven days. Review the saved Elite price before changing plans.'],
  ['Bonus features expired', 'Bonus features expired', 'Your Starter bonus features period ended. Starter plan features remain active.'],
  ['Plan change completed', 'Rozare Elite activated', 'The plan change completed. Review the new monthly price and next billing date in Subscription.'],
  ['Plan change authentication required', 'Payment authentication required', 'The requested plan change has not been activated. Complete the saved payment attempt in Rozare.'],
  ['Subscription payment failed', 'Subscription payment failed', 'The payment provider could not collect $9.99 USD for your Starter subscription. Review the current access state and retry the saved attempt.'],
  ['Subscription activated', 'Rozare Starter activated', 'Your Starter plan is in its introductory period. The saved recurring rate is $9.99 USD/month after it ends.'],
  ['Downgrade scheduled', 'Downgrade to Starter scheduled', 'Your downgrade is scheduled for the end of the current Elite period. The saved Starter recurring price is $9.99 USD/month.'],
  ['Safepay operation completed', 'Subscription payment received', 'Your Starter subscription operation completed. Charged now: $0.00 USD. Review your next billing date.'],
  ['Safepay operation failed', 'Subscription payment was not completed', 'The saved subscription attempt was not completed. Charged now: $0.00 USD. Review the same attempt in Subscription.'],
  ['Renewal cancelled', 'Subscription renewal cancelled', 'Renewal of your $9.99 USD/month plan is cancelled. Current access remains until the period ends.'],
  ['Renewal resumed', 'Subscription renewal resumed', 'Automatic renewal of your $9.99 USD/month plan is active again.'],
  ['Subscription ended', 'Subscription ended - store blocked', 'Your Starter subscription ended. Your store is hidden until you subscribe again.'],
  ['Payment received', 'Subscription payment received', 'Starter plan payment received: $9.99 USD. Review the active plan and next billing date.'],
  ['Payment recovered', 'Subscription payment recovered', 'Starter plan payment recovered: $9.99 USD. Review current access in Subscription.'],
];
for (const [name, subject, body] of billingCases) addSpecimen('Subscriptions', name, subject, body, subscription);

const storeCases = [
  ['Seller account created', 'Your Rozare seller account is ready', 'Your seller account has been created. Complete store setup, products and shipping in your dashboard.', '/seller-dashboard/store-overview'],
  ['Store created', 'Your store Atlas Aura was created', 'Atlas Aura was created. Review Store Settings to finish setup. Visibility follows your current account and subscription state.', '/seller-dashboard/store-settings'],
  ['Store verified', 'Store verification approved - Atlas Aura', 'Atlas Aura verification was approved. Review your verified badge and store status.', '/seller-dashboard/store-settings'],
  ['Store verification rejected', 'Store verification rejected - Atlas Aura', 'Atlas Aura verification was rejected. Review the saved reason and required changes.', '/seller-dashboard/store-settings'],
  ['Store verification removed', 'Store verification removed - Atlas Aura', 'The verified badge was removed from Atlas Aura. Review the saved reason and guidance.', '/seller-dashboard/store-settings'],
  ['Verified-buyer rating', 'New verified-buyer rating for Atlas Aura', 'Sam rated Atlas Aura 5 out of 5. Review the store rating.', '/seller-dashboard/store-overview'],
  ['Payout account updated', 'Your Rozare payout account was updated', 'Your payout destination for PKR payouts was saved. If you did not make this change, contact Rozare support immediately.', payments],
  ['Product blocked', 'Product listing needs changes', 'A product listing needs changes and is hidden from customers. Review the reason in Product Management, then update the affected details.', '/seller-dashboard/product-management'],
  ['Product content approved', 'Product content approved', 'Your product passed the content checks. Review its current publication status in Product Management.', '/seller-dashboard/product-management'],
  ['Product content blocked', 'Product needs changes', 'The product is hidden. Review the safe moderation reason in Product Management and submit corrected content for automatic checks.', '/seller-dashboard/product-management'],
  ['Store content approved', 'Store content approved', 'Your store content passed the checks. Review its current visibility in Store Settings.', '/seller-dashboard/store-settings'],
  ['Store content blocked', 'Store needs changes', 'The store is hidden. Review the moderation reason in Store Settings and update the flagged content.', '/seller-dashboard/store-settings'],
  ['Subdomain payment', 'Subdomain ownership payment received', 'Payment received for atlas-aura.rozare.com: $15.00 USD. Original paid ownership period through 2029-09-30; later refunds or disputes may change current access.', '/seller-dashboard/subdomain'],
  ['Subdomain ownership expired', 'Subdomain ownership expired - renewal available', 'Paid ownership of atlas-aura.rozare.com ended on 30 September. Review the current renewal price in Subdomain.', '/seller-dashboard/subdomain'],
  ['Subdomain removed', 'Your Rozare subdomain was removed', 'atlas-aura.rozare.com was released after an inactive-store grace period. Reactivate the store before choosing an available replacement.', '/seller-dashboard/subdomain'],
];
for (const [name, subject, body, route] of storeCases) addSpecimen('Stores & products', name, subject, body, route);

for (const [name, subject, body, route] of [
  ['Old-provider card refund', 'Card refund completed - ORD-PREVIEW', 'A verified earlier card payment was refunded to the original payment method. Refund: Rs1,200.00 PKR. Bank posting times may vary.', buyerOrder],
  ['Old-provider subscription refund', 'Subscription refund confirmed', 'Refund allocated to this earlier subscription: $9.99 USD. Current access was recalculated from remaining funded time.', subscription],
  ['Old-provider subscription dispute', 'Subscription dispute opened', 'A $9.99 USD dispute was recorded on an earlier payment. Review current access and contact support if needed.', subscription],
  ['Old-provider subdomain dispute', 'Subdomain dispute lost', 'A finalized reversal affected an earlier subdomain payment. Review current ownership in Subdomain.', '/seller-dashboard/subdomain'],
  ['Admin payment risk review', 'Payment risk requires manual review', 'A provider event requires internal review. No customer or seller outcome has been inferred.', '/admin-dashboard/payments'],
]) addSpecimen('Legacy payment review', name, subject, body, route);

const { renderGallery } = require('./notificationGalleryShell');
const { buildRuntimeNotificationGalleryEntries, coverageMatrix, exclusions, notificationCallSiteInventory } = require('./runtimeNotificationGallery');
const { buildFixedWhatsAppGalleryEntries, auditFixedWhatsAppSendSites } = require('./whatsappFixedGalleryEntries');
const { oldEmailTemplateByName } = require('./previousNotificationGallery');
const { attachHistoricalComparisons } = require('./notificationGalleryHistoricalSource');
const oldEmails = oldEmailTemplateByName(sampleOrder);
// Historical hand-written specimens remain above as drafting references only.
// The visible gallery now contains actual source renders, not approximations.
const directEmailEntries = entries.filter(entry => entry.kind === 'Actual template').map(entry => {
  const before = oldEmails.get(entry.name) || null;
  const { html, subject, previewBody, ...details } = entry;
  const retained = entry.name.includes('(retained export)');
  const accountSource = ['Buyer signup code', 'Seller signup code', 'Seller email-change code', 'Password reset', 'Password changed'].includes(entry.name);
  return { ...details, channel: 'email', activity: retained ? 'legacy' : 'active',
    kind: retained ? 'Retained email export' : 'Current source template', before, after: { subject, html },
    sourcePath: accountSource ? 'Backend/utils/accountEmailTemplates.js' : 'Backend/utils/emailTemplates.js',
    changed: !!before && (before.subject !== subject || before.html !== html),
    comparison: before ? 'Source snapshot' : 'Current source only',
    ...(before ? { sourceBaseline: require('./previousNotificationGallery').BASELINE } : {}) };
});

async function buildGallery() {
  const runtime = await buildRuntimeNotificationGalleryEntries({ includeApp: true });
  const fixedWhatsApp = buildFixedWhatsAppGalleryEntries();
  // The return-request helper is already rendered through its real outbox.
  const directWhatsApp = fixedWhatsApp.filter(entry => entry.name !== 'Seller utility: return_requested');
  const roleFor = entry => entry.audienceRole || (entry.sourcePath?.includes('sellerMessageTemplates') || /Seller|seller|Payout|Withdrawal/.test(entry.name) ? 'seller'
    : /Buyer|buyer|Password|shopper|order:|Paid order|Reconfirm|confirmation|cancelled|decision/.test(entry.name) ? 'buyer' : 'general');
  const all = await attachHistoricalComparisons([...directEmailEntries, ...runtime, ...directWhatsApp].map(entry => ({ ...entry, audienceRole: roleFor(entry) })));
  const emailEntries = all.filter(entry => entry.channel === 'email');
  const whatsappEntries = all.filter(entry => entry.channel === 'whatsapp');
  const inboxEntries = all.filter(entry => entry.channel === 'inapp');
  const pushEntries = all.filter(entry => entry.channel === 'push');
  const ordered = [...emailEntries, ...whatsappEntries, ...inboxEntries, ...pushEntries];
  const ids = ordered.map(entry => `${entry.channel}:${entry.name}`);
  if (new Set(ids).size !== ids.length) throw new Error('The gallery contains duplicate message names.');
  const coverage = { generatedAt: '2026-10-12', sourceFamilies: coverageMatrix,
    fixedWhatsAppSendSites: auditFixedWhatsAppSendSites(), notificationCallSites: notificationCallSiteInventory(), exclusions,
    historicalCoverage: all.historicalCoverage,
    counts: { email: emailEntries.length, whatsapp: whatsappEntries.length, inapp: inboxEntries.length, push: pushEntries.length,
      activeEmail: emailEntries.filter(entry => entry.activity === 'active').length,
      activeWhatsApp: whatsappEntries.filter(entry => entry.activity === 'active').length } };
  const galleryHtml = renderGallery(ordered, emailEntries.length, coverage);
  const galleryPath = path.resolve(__dirname, '../../EMAIL_TEMPLATE_GALLERY_2026-09-30.html');
  fs.writeFileSync(galleryPath, galleryHtml, 'utf8');
  console.log(`Rendered ${emailEntries.length} emails, ${whatsappEntries.length} WhatsApp, ${inboxEntries.length} inbox and ${pushEntries.length} push previews in ${galleryPath}`);
  console.log(`Verified Old comparisons: ${all.historicalCoverage.recovered} recovered, ${all.historicalCoverage.preserved} preserved, ${all.historicalCoverage.unavailable} unavailable.`);
}
buildGallery().catch(error => { console.error(`Local gallery generation failed: ${error.message}`); process.exitCode = 1; });
