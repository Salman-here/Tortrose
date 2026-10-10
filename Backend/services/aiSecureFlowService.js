'use strict';
// A role-bound handoff is intentional: chat does not collect credentials,
// accept payment mandates or fabricate completion of a secure screen action.
const buyerFlows = {
  wallet_top_up: ['/user-dashboard/wallet', 'Add funds to your personal Wallet through secure Safepay checkout.'],
  payment_methods: ['/user-dashboard/payment-methods', 'Add, remove or select a default Safepay card on the secure card screen.'],
  billing_details: ['/user-dashboard/payment-methods', 'Edit the billing name, phone and country in the secure card setup form.'],
  address_book: ['/user-dashboard/profile', 'Edit your saved delivery address. Existing placed orders retain their original delivery details.'],
  account_security: ['/user-dashboard/profile', 'Use account settings for protected email/password changes. Never send passwords or verification codes in chat.'],
  account_deletion: ['/account-deletion', 'Review the account deletion process and submit it yourself. Opening this page does not delete your account.'],
  whatsapp_link: ['/user-dashboard/whatsapp', 'Link or unlink your WhatsApp number using the verification screen.'],
  blocked_accounts: ['/settings/blocked-accounts', 'Review and manage your blocked accounts.'],
  reviews: ['/user-dashboard/orders', 'Open an eligible completed purchase to review the product or store. No review is posted by this handoff.'],
  digital_download: ['/user-dashboard/orders', 'Open your eligible paid digital purchase to access its protected downloads.'],
  shopping_filters: ['/marketplace', 'Change currency, Global/country selection, price, category and verified-brand filters. Global includes global stores plus country-visible stores for your selected home country.'],
  become_seller: ['/become-seller', 'Complete seller onboarding and verified WhatsApp linking yourself.'],
};
const sellerFlows = {
  payment_methods: ['/seller-dashboard/payment-methods', buyerFlows.payment_methods[1]],
  billing_details: ['/seller-dashboard/payment-methods', buyerFlows.billing_details[1]],
  account_security: ['/seller-dashboard/profile', buyerFlows.account_security[1]],
  whatsapp_link: ['/seller-dashboard/whatsapp-settings', 'Manage your seller WhatsApp connection through the verification screen.'],
  store_creation: ['/seller-dashboard/store-settings', 'Create or edit your store. Country visibility defaults to your country; choose Global only if you can ship internationally.'],
  store_appearance: ['/seller-dashboard/store-settings', 'Edit your store logo, banner, appearance and settings.'],
  subscription: ['/seller-dashboard/subscription', 'Review current plans, trial/renewal terms, paid changes, cancellation, resumption, scheduled downgrades and the Meta add-on. Any payment or renewal agreement must be accepted on this secure screen.'],
  subdomain_purchase: ['/seller-dashboard/subdomain', 'Review your subdomain status and complete a purchase or renewal through secure Safepay checkout.'],
  payout_account: ['/seller-dashboard/payments', 'Edit your matching-currency payout bank details on the protected Payments screen. Requests are paid manually by admin; chat does not send bank transfers.'],
  notification_settings: ['/seller-dashboard/notification-settings', 'Configure your store notification preferences.'],
  product_files: ['/seller-dashboard/product-management', 'Add or edit product images, variants and permitted digital files through the product form.'],
};
function getSecureFlow(feature, user) {
  if (!['user', 'seller'].includes(user?.role)) return { success: false, code: 'AI_COMMERCE_AUTH_REQUIRED', error: 'Sign in with your buyer or seller account.' };
  const flow = user.role === 'seller' && Object.hasOwn(sellerFlows, feature) ? sellerFlows[feature]
    : Object.hasOwn(buyerFlows, feature) ? buyerFlows[feature] : null;
  if (!flow) return { success: false, code: 'AI_SECURE_FLOW_UNAVAILABLE', error: 'That feature is not available for your account role. No action was performed.' };
  return { success: true, requiresSecureAction: true,
    data: { feature, route: flow[0], url: `https://rozare.com${flow[0]}`, noActionPerformed: true },
    message: `${flow[1]} Continue at https://rozare.com${flow[0]}. Opening this page is not confirmation that its action or payment completed.` };
}
module.exports = { getSecureFlow, buyerFlows, sellerFlows };
