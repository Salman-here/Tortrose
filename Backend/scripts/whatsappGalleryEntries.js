'use strict';

// Preview data only. Nothing in this file sends a WhatsApp message.
const buyer = require('../services/whatsapp/messageBuilder');
const seller = require('../services/whatsapp/sellerMessageTemplates');

const sampleOrder = {
  _id: 'preview-only-order', orderId: 'ORD-PREVIEW', currency: 'PKR', paymentMethod: 'cash_on_delivery',
  orderItems: [{ name: 'Travel Mug', price: 1000, lineSubtotal: 1000, quantity: 1,
    selectedOptions: { Color: 'Blue' }, storeName: 'Atlas Aura' }],
  orderSummary: { subtotal: 1000, shippingCost: 200, tax: 0, couponDiscount: 0, totalAmount: 1200 },
  shippingInfo: { fullName: 'Sam Preview', city: 'Example City' },
};
const sampleReturn = { returnNumber: 'RET-PREVIEW', orderId: sampleOrder.orderId,
  reasonDetails: 'The item arrived damaged.' };
const entries = [];

const actual = (group, name, message, { title = '', footer = '', buttons = [], kind = 'Actual template' } = {}) => {
  entries.push({ channel: 'whatsapp', group, name, kind, title, message, footer, buttons });
};
const specimen = (group, name, message, { buttons = [], title = '', footer = '' } = {}) => {
  entries.push({ channel: 'whatsapp', group, name, kind: 'Illustrative notification', title, message, footer, buttons });
};
const link = route => `\n\nView details: https://rozare.com${route}`;

// These calls render the actual buyer-side functions. Buttons are visual
// labels only; no decision IDs or live order token are exposed in the gallery.
const confirm = buyer.buildOrderButtonsPayload(sampleOrder);
actual('Orders', 'COD order: confirm or cancel buttons', confirm.description,
  { title: confirm.title, footer: confirm.footer, buttons: confirm.buttons.map(button => button.displayText) });
const list = buyer.buildOrderListPayload(sampleOrder);
actual('Orders', 'COD order: interactive list', list.description,
  { title: list.title, footer: list.footerText, buttons: list.sections.flatMap(section => section.rows.map(row => row.title)) });
actual('Orders', 'COD order: legacy text summary', buyer.buildOrderConfirmationMessage(sampleOrder),
  { kind: 'Retained template' });
actual('Orders', 'Paid order information', buyer.buildOrderPlacedInfoMessage({ ...sampleOrder, paymentMethod: 'safepay' }));
for (const status of ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled']) {
  actual('Orders', `Buyer order ${status} (retained)`, buyer.buildOrderStatusUpdateMessage(sampleOrder, status),
    { kind: 'Retained template' });
}
const reconfirm = buyer.buildReconfirmButtonsPayload(sampleOrder, 'Hi Sam, this order was cancelled.');
actual('Orders', 'Reconfirm a cancelled COD order', reconfirm.description,
  { title: reconfirm.title, footer: reconfirm.footer, buttons: reconfirm.buttons.map(button => button.displayText) });

// Direct OTP and cross-channel replies live in controllers/webhook handlers.
// Their samples include the exact current purpose, action and expiry language;
// runtime identifiers and codes are deliberately dummy values.
specimen('Verification', 'Buyer WhatsApp code', '*Rozare WhatsApp verification*\n\nYour verification code is: *123456*\n\nThis code expires in 2 minutes.\nDo not share this code with anyone.\n\nEnter this code in Rozare to connect WhatsApp for account messages and chat. If you did not request this, ignore the code.');
specimen('Verification', 'Seller WhatsApp code', '*Rozare seller WhatsApp verification*\n\nYour verification code: *654321*\nExpires in 2 minutes.\n\nEnter this code in Rozare to connect your seller WhatsApp number. Do not share it. If you did not request this, ignore the message.');
specimen('Verification', 'Change seller WhatsApp number', '*Rozare seller WhatsApp change*\n\nYour verification code: *345678*\nExpires in 2 minutes.\n\nEnter this code in Rozare to confirm your new seller WhatsApp number. Do not share it. If you did not request this change, ignore the message.');

specimen('Order decisions', 'Buyer confirmed the order', "Hi Sam,\n\nYour order *#ORD-PREVIEW* is confirmed.\n\nYou'll receive updates as your items are prepared and shipped.\n\nTrack each seller's shipment in your Rozare account. Contact support@rozare.com if you need help.");
specimen('Order decisions', 'Buyer cancelled the order', 'Hi Sam,\n\nOrder *#ORD-PREVIEW* has been cancelled.\n\nIf you paid online, review this order for any applicable refund update.\n\nOpen your Rozare account for the current status or contact support@rozare.com for help.');
specimen('Order decisions', 'Decision already confirmed', 'Hi Sam,\n\nYou already *confirmed* this order. Its latest fulfillment status is in your Rozare account.\n\nOpen the order in Rozare to see available actions or contact support@rozare.com for help.');
specimen('Order decisions', 'Decision already cancelled', 'Hi Sam,\n\nYou already *cancelled* this order.\n\nOpen the order in Rozare to see available actions or contact support@rozare.com for help.');
specimen('Order decisions', 'Typed reply cannot decide', 'Hi Sam,\n\nWe could not record a decision from your text reply for order *#ORD-PREVIEW*.\n\nPlease use the Confirm order or Cancel order buttons from the latest order message. Typed replies are not accepted for order confirmation.');
specimen('Order decisions', 'Confirmation request expired', 'This order confirmation request has expired or was replaced.\nPlease check your Rozare account for the current order status.');
specimen('Order decisions', 'Reconfirmation buttons unavailable', 'Hi Sam, this order was cancelled.\n\nThe confirmation buttons are unavailable right now.\nOpen your Rozare order for its current status or contact support@rozare.com for help.');
specimen('Order decisions', 'Decision already recorded by email', 'Hi Sam,\n\nYou have already confirmed this order via your email.\n\nNo further action is needed. Track the order in your Rozare account.');
specimen('Order decisions', 'Decision already recorded in account', 'Hi Sam,\n\nYou have already cancelled this order from your Rozare account.\n\nNo further action is needed.');
specimen('Order decisions', 'Order already in later stage', 'Hi Sam,\n\nCurrent status of order *#ORD-PREVIEW*: *shipped*.\n\nOpen your Rozare order to check the available cancellation or return options.');
specimen('Order decisions', 'Cancellation unavailable in this message', 'Order #ORD-PREVIEW cannot be cancelled here.\n\nReview the current payment and shipping status in your Rozare account.');

// Retained seller-side utilities. Most are no longer used by the current
// financial outbox, so the badge identifies them as utility previews.
const retained = (name, value) => actual('Seller utilities', name, value, { kind: 'Retained template' });
retained('Seller welcome', seller.seller_welcome('Atlas Aura'));
retained('New seller order', seller.new_order(sampleOrder));
retained('Order confirmed for seller', seller.order_confirmed(sampleOrder));
retained('Order cancelled for seller', seller.order_cancelled(sampleOrder));
actual('Returns', 'Seller return request', seller.return_requested(sampleReturn));
retained('Seller return settlement', seller.return_settled(sampleReturn, 'Rs1,200.00 PKR'));
retained('Subscription activated', seller.subscription_activated('Rozare Starter', 30));
retained('Subscription ending soon', seller.subscription_ending_soon(7));
retained('Subscription payment failed', seller.payment_failed());
retained('Subscription payment recovered', seller.payment_recovered());
retained('Plan change needs authentication', seller.plan_change_action_required());
retained('Seller trial expiring', seller.trial_expiring(7));
retained('Store unavailable', seller.account_blocked('the subscription ended'));
retained('Product listing needs changes', seller.product_blocked());
retained('Bonus features expiring', seller.bonus_expiring(7));
retained('Bonus features expired', seller.bonus_expired());
retained('Downgrade scheduled', seller.downgrade_scheduled());
retained('Elite upgrade completed', seller.upgrade_completed());
retained('Store verified', seller.store_verified());

// Outbox events are shown as clearly labelled specimens. The production
// outbox supplies authoritative money/status snapshots at enqueue time.
for (const [status, detail] of [
  ['confirmed', 'Your order is confirmed. You will receive updates as your items are prepared and shipped.'],
  ['processing', 'Your order is being prepared. Watch for a shipping update.'],
  ['shipped', 'Your order was marked as shipped. Check the order details for each seller’s delivery progress.'],
  ['delivered', 'Your order was marked delivered.'],
  ['cancelled', 'You cancelled this order. Check the order details for any applicable payment or refund update.'],
]) specimen('Order updates', `Buyer aggregate order ${status}`, `*Order ${status}*\n\nOrder: #ORD-PREVIEW\n${detail}\nOrder total: Rs1,200.00 PKR.${link('/user-dashboard/order/detail/preview-only')}`);
for (const [status, detail] of [
  ['confirmed', 'confirmed your items'], ['processing', 'is preparing your items'],
  ['shipped', 'shipped your items'], ['delivered', 'marked your items delivered'],
]) specimen('Order updates', `Buyer seller-shipment ${status}`, `*Seller ${status} your items*\n\nOrder: #ORD-PREVIEW\nStore: Atlas Aura\nItems: Travel Mug (Blue)\nStatus: ${status}\nAtlas Aura ${detail}.\nYour total for this store: Rs1,200.00 PKR.${link('/user-dashboard/order/detail/preview-only')}`);
specimen('Order updates', 'Buyer paid-order receipt', `*Payment received*\n\nOrder: #ORD-PREVIEW\nCharged total: Rs1,200.00 PKR.${link('/user-dashboard/order/detail/preview-only')}`);
specimen('Order updates', 'Seller paid-order receipt', `*Paid order received*\n\nOrder: #ORD-PREVIEW\nYour store total: Rs1,199.02 PKR\nBuyer paid for your items: $4.33 USD\n\nOpen Seller Dashboard to process your part of the order.${link('/seller-dashboard/order/preview-only')}`);
specimen('Order updates', 'Buyer no-charge order', `*Order confirmed*\n\nOrder: #ORD-PREVIEW\nTotal: Rs0.00 PKR\nNo payment was required or charged.${link('/user-dashboard/order/detail/preview-only')}`);
specimen('Order updates', 'Seller no-charge order', `*Order received without a charge*\n\nOrder: #ORD-PREVIEW\nYour store total: Rs0.00 PKR\nBuyer total for your items: Rs0.00 PKR\nNo buyer payment was required or collected.${link('/seller-dashboard/order/preview-only')}`);
specimen('Order updates', 'Seller COD order', `*New cash on delivery order*\n\nOrder: #ORD-PREVIEW\nYour store total: Rs1,200.00 PKR\nBuyer total for your items: Rs1,200.00 PKR\nCash has not been collected. Wait for buyer confirmation before fulfillment.${link('/seller-dashboard/order/preview-only')}`);
for (const status of ['confirmed', 'cancelled']) specimen('Order updates', `Seller COD ${status}`, `*Buyer ${status} order*\n\nOrder: #ORD-PREVIEW\nYour store total: Rs1,200.00 PKR\nNo cash was collected by Rozare.${link('/seller-dashboard/order/preview-only')}`);

specimen('Returns', 'Buyer return refund and liability', `*Return refund completed*\n\nReturn: #RET-PREVIEW\nOrder: #ORD-PREVIEW\nRefund total: Rs1,200.00 PKR\nAvailable Wallet credit: Rs900.00 PKR\nApplied to Wallet liability: Rs300.00 PKR\nRemaining liability: Rs0.00 PKR${link('/user-dashboard/orders')}`);
specimen('Returns', 'Buyer full Wallet refund', `*Return refund completed*\n\nReturn: #RET-PREVIEW\nOrder: #ORD-PREVIEW\nWallet credit: Rs1,200.00 PKR${link('/user-dashboard/orders')}`);
specimen('Returns', 'Seller return cancelled', `*Return request cancelled*\n\nReturn: #RET-PREVIEW\nOrder: #ORD-PREVIEW\nThe buyer cancelled this request.${link('/seller-dashboard/order-management?tab=returns')}`);
specimen('Returns', 'Buyer return cancelled', `*Return cancelled*\n\nReturn: #RET-PREVIEW\nOrder: #ORD-PREVIEW\nReview your return record for current details.${link('/user-dashboard/orders')}`);
specimen('Returns', 'Buyer return status updated', `*Return status updated*\n\nReturn: #RET-PREVIEW\nCheck your return record for the decision and next steps.${link('/user-dashboard/orders')}`);
specimen('Returns', 'Seller return settled', `*Return completed*\n\nReturn: #RET-PREVIEW\nOrder: #ORD-PREVIEW\nRefund processed: Rs1,200.00 PKR\nBuyer Wallet allocation details remain private.${link('/seller-dashboard/order-management?tab=returns')}`);

specimen('Wallet & payouts', 'Buyer Wallet credit', `*Wallet credited*\n\nRs1,200.00 PKR was credited to your Rozare Wallet.${link('/user-dashboard/wallet')}`);
specimen('Wallet & payouts', 'Buyer Wallet liability allocation', `*Wallet credit allocated*\n\nIncoming credit: Rs1,200.00 PKR\nAvailable credit: Rs900.00 PKR\nApplied to liability: Rs300.00 PKR\nRemaining liability: Rs0.00 PKR${link('/user-dashboard/wallet')}`);
specimen('Wallet & payouts', 'Buyer Wallet payment', `*Wallet payment completed*\n\nRs1,200.00 PKR was debited from your Wallet.${link('/user-dashboard/wallet')}`);
specimen('Wallet & payouts', 'Seller withdrawal requested', `*Withdrawal request received*\n\nRequested: Rs2,000.00 PKR\nBank payout: Rs2,000.00 PKR\nStatus: pending${link('/seller-dashboard/payments')}`);
for (const status of ['approved', 'rejected', 'completed']) specimen('Wallet & payouts', `Seller withdrawal ${status}`, `*Withdrawal ${status}*\n\nRequested: Rs2,000.00 PKR\nBank payout: Rs2,000.00 PKR\nReview the saved ${status} status and any admin note.${link('/seller-dashboard/payments')}`);
specimen('Wallet & payouts', 'Admin withdrawal request', `*New seller withdrawal request*\n\nAlex requested Rs2,000.00 PKR. Transfer only to the frozen destination after approval.${link('/admin-dashboard/payments')}`);

for (const [name, heading, detail] of [
  ['Trial ending', 'Seller trial ending soon', 'Your trial ends on 15 October. Subscribe to keep your store visible.'],
  ['Trial ended', 'Store blocked - seller trial ended', 'Your trial ended. The store is hidden until subscription access resumes.'],
  ['Renewal ending soon', 'Subscription ending soon', 'The subscription is scheduled to end on 15 October.'],
  ['Bonus expiring', 'Bonus features expiring', 'Your Starter bonus features expire in seven days.'],
  ['Bonus expired', 'Bonus features expired', 'Your Starter features remain active; the extra bonus period ended.'],
  ['Plan activated', 'Rozare Elite activated', 'Your plan changed to Elite. Review the saved billing date.'],
  ['Plan authentication required', 'Payment authentication required', 'The requested plan change is not active yet. Finish the saved payment attempt.'],
  ['Payment failed', 'Subscription payment failed', 'The payment provider could not collect $9.99 USD. Review your plan and retry.'],
  ['Downgrade scheduled', 'Downgrade to Starter scheduled', 'Starter begins after your Elite period ends.'],
  ['Safepay operation complete', 'Subscription updated', 'Your saved subscription operation completed. Charged now: $0.00 USD.'],
  ['Safepay operation failed', 'Subscription payment was not completed', 'Your subscription payment attempt was not completed. Review the saved attempt.'],
  ['Renewal cancelled', 'Subscription renewal cancelled', 'Renewal is cancelled. Current access remains through the paid period.'],
  ['Renewal resumed', 'Subscription renewal resumed', 'Automatic renewal of the $9.99 USD/month plan is active again.'],
  ['Subscription ended', 'Subscription ended - store blocked', 'Your subscription ended. The store is hidden until you subscribe again.'],
  ['Payment received', 'Subscription payment received', 'Your Starter payment of $9.99 USD was recorded.'],
  ['Payment recovered', 'Subscription payment recovered', 'Your Starter payment of $9.99 USD was recovered.'],
]) specimen('Subscriptions', name, `*${heading}*\n\n${detail}${link('/seller-dashboard/subscription')}`);

for (const [name, heading, detail, route] of [
  ['Seller welcome', 'Welcome to Rozare Seller', 'Your seller account is ready for store setup.', '/seller-dashboard/store-overview'],
  ['Store created', 'Store created', 'Atlas Aura was created. Finish store setup and review visibility.', '/seller-dashboard/store-settings'],
  ['Store verified', 'Store verification approved', 'Atlas Aura now has a verified badge.', '/seller-dashboard/store-settings'],
  ['Store verification rejected', 'Store verification rejected', 'Review the reason and requested changes.', '/seller-dashboard/store-settings'],
  ['Store verification removed', 'Store verification removed', 'The verified badge was removed. Review the saved reason.', '/seller-dashboard/store-settings'],
  ['New store rating', 'New store rating', 'Sam rated Atlas Aura 5 out of 5.', '/seller-dashboard/store-overview'],
  ['Payout account updated', 'Payout account updated', 'Your payout destination for PKR was saved. If unexpected, contact support immediately.', '/seller-dashboard/payments'],
  ['Product blocked', 'Product listing needs changes', 'A product listing is hidden. Review its moderation reason in Product Management.', '/seller-dashboard/product-management'],
  ['Catalog product approved', 'Product content approved', 'The product passed the content checks. Review current publication status.', '/seller-dashboard/product-management'],
  ['Catalog product blocked', 'Product needs changes', 'The product remains hidden while you correct the flagged content.', '/seller-dashboard/product-management'],
  ['Catalog store approved', 'Store content approved', 'Your store content passed the checks. Review current visibility.', '/seller-dashboard/store-settings'],
  ['Catalog store blocked', 'Store needs changes', 'Review the moderation reason and correct the flagged store content.', '/seller-dashboard/store-settings'],
  ['Subdomain paid', 'Subdomain payment received', 'atlas-aura.rozare.com ownership payment: $15.00 USD. Review current access.', '/seller-dashboard/subdomain'],
  ['Subdomain ownership expired', 'Subdomain ownership expired', 'Paid ownership of atlas-aura.rozare.com ended. Review available renewal.', '/seller-dashboard/subdomain'],
  ['Subdomain removed', 'Subdomain removed', 'atlas-aura.rozare.com was released after an inactive-store grace period.', '/seller-dashboard/subdomain'],
]) specimen('Stores & products', name, `*${heading}*\n\n${detail}${link(route)}`);

for (const [name, heading, detail, route] of [
  ['Legacy card refund', 'Card refund completed', 'An earlier card payment was refunded to its original method: Rs1,200.00 PKR. Bank posting can take longer.', '/user-dashboard/order/detail/preview-only'],
  ['Legacy entitlement refund', 'Subscription refund confirmed', 'An earlier subscription refund of $9.99 USD affected current access.', '/seller-dashboard/subscription'],
  ['Legacy entitlement dispute opened', 'Subscription dispute opened', 'An earlier $9.99 USD card charge has an open dispute. Review current access.', '/seller-dashboard/subscription'],
  ['Legacy entitlement dispute won', 'Subscription dispute won', 'A prior dispute was resolved and access was recalculated.', '/seller-dashboard/subscription'],
  ['Legacy entitlement dispute lost', 'Subscription dispute lost', 'A prior dispute reversal changed entitlement access.', '/seller-dashboard/subscription'],
  ['Admin payment risk review', 'Payment risk requires manual review', 'A verified provider event requires admin investigation. No customer outcome has been inferred.', '/admin-dashboard/payments'],
]) specimen('Legacy payment review', name, `*${heading}*\n\n${detail}${link(route)}`);

module.exports = { buildWhatsAppGalleryEntries: () => entries.map(entry => ({ ...entry })) };
