'use strict';
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
} });
const reference = { type: 'string', description: 'Public order/return number or internal reference from a previous owned tool result. Never ask the person for database IDs.' };
const confirm = { type: 'boolean', description: 'True ONLY in a subsequent message after the person reviews the server preview and explicitly confirms. The server independently verifies the latest saved chat and preview.' };
const status = { type: 'string', description: 'Optional exact status filter. Omit for all statuses.' };
const returnReference = { returnId: reference, view: { type: 'string', enum: ['buyer', 'seller'] } };
const BUYER_COMMERCE_TOOLS = [
  tool('get_payment_options', 'Read Rozare\'s CURRENT Safepay environment and enabled web/mobile checkout, supported currencies and method restrictions. Use before stating Sandbox vs live or available online methods; no credentials or customer records are returned. Configuration is not proof of a successful payment.'),
  tool('get_wallet_balance', 'Read only this authenticated buyer\'s actual Wallet balances separately in USD, PKR, EUR and GBP, restrictions and recent transaction outcomes. A seller can use this for their personal buyer Wallet, not their store earnings. Never merge currencies or claim locked/restricted balances are spendable.'),
  tool('get_saved_payment_methods', 'Read only this account\'s CURRENT-environment Safepay saved cards. Returns masked last four digits, expiry, usability and default selection, never card tokens, PAN or security codes. Sandbox and live cards are separate. Adding, removing or choosing a card happens on the secure Payment Methods screen.'),
  tool('get_secure_flow', 'Resolve the exact role-appropriate secure page for a platform feature. Use for wallet top-ups; saved cards; billing/address editing; account security/deletion; WhatsApp linking; blocked accounts; reviews/digital downloads; shopping filters; seller onboarding/store creation; subscriptions, plan changes, renewals and add-ons; subdomain purchases; payout-bank editing; notification settings; product images/files and store appearance. Then navigate to the returned route when the person asks to open it. This tool performs NO payment, subscription change, bank edit, account deletion, review or upload. Never collect card numbers, CVCs, bank passwords or OTPs in chat.', {
    feature: { type: 'string', enum: ['wallet_top_up', 'payment_methods', 'billing_details', 'address_book', 'account_security', 'account_deletion', 'whatsapp_link', 'blocked_accounts', 'reviews', 'digital_download', 'shopping_filters', 'become_seller', 'store_creation', 'subscription', 'subdomain_purchase', 'payout_account', 'notification_settings', 'product_files', 'store_appearance'] },
  }, ['feature']),
  tool('get_purchase_orders', 'List this account\'s personal purchases, including when the account is also a seller. Never confuse purchases with received store orders.', { status, limit: { type: 'integer', minimum: 1, maximum: 40 } }),
  tool('get_purchase_order_detail', 'Get this buyer\'s exact order, all its seller shipments, frozen payment/fees, cancellation status and item-level return eligibility. A seller buying as a customer can use this; it never grants seller control of other stores.', { orderId: reference }, ['orderId']),
  tool('get_return_eligibility', 'Read the frozen item return policies, eligible quantities and deadlines of the buyer\'s own delivered seller portions. Use this before asking which item to return; no return is submitted.', { orderId: reference }, ['orderId']),
  tool('get_my_returns', 'List this account\'s own return requests as a buyer, their real statuses, frozen refund and funding outcomes.', { status, orderId: reference, limit: { type: 'integer', minimum: 1, maximum: 40 } }),
  tool('get_return_detail', 'Inspect one owned return by its public return number or reference. Seller view is only for the actor\'s own store requests; buyer view is only their own purchases. Includes allowed next steps and funding source.', returnReference, ['returnId']),
  tool('request_return', 'Preview a return for selected quantities from ONE seller using frozen policies, then wait for the buyer\'s next explicit confirmation before calling again with confirm=true. Get eligibility first; resolve friendly names/options to returned orderItemId. A request is not a completed refund. Ask for an actual reason (at least 10 characters); never invent it.', {
    orderId: reference, sellerId: { type: 'string' }, storeName: { type: 'string' },
    items: { type: 'array', minItems: 1, items: { type: 'object', properties: { orderItemId: { type: 'string' }, itemName: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['quantity'] } },
    reasonCategory: { type: 'string', enum: ['damaged', 'defective', 'wrong_item', 'not_as_described', 'size_or_fit', 'changed_mind', 'other'] },
    reasonDetails: { type: 'string' }, confirm,
  }, ['orderId', 'items', 'reasonCategory', 'reasonDetails']),
  tool('cancel_return', 'Preview cancellation of the buyer\'s own still-cancellable return request; obtain a subsequent explicit confirmation. This cancels the RETURN request, not the purchase, and does not create a money refund.', { returnId: reference, note: { type: 'string' }, confirm }, ['returnId']),
];
const SELLER_COMMERCE_TOOLS = [
  tool('get_my_withdrawals', 'Read only this seller\'s existing withdrawal requests and recorded admin statuses, separately by original earned currency. Pending or approved is NOT a bank transfer. Use before a retry or another request; never resubmit a previous request because a response was lost.', { limit: { type: 'integer', minimum: 1, maximum: 40 } }),
  tool('get_subdomain_status', 'Read this seller\'s own subdomain, active/blocked status, paid ownership expiry and payment-risk status. Purchase/renewal uses get_secure_flow; do not claim paid ownership from a checkout page or stale conversation.'),
  tool('get_verification_status', 'Read the actual verification badge/application status and any rejection reason of this seller\'s own store. Do not promise approval or invent an admin decision.'),
  tool('get_seller_returns', 'List only this seller\'s store return requests. Show status, frozen refund currency/amount and whether held order funds or COD funding is required.', { status, orderId: reference, limit: { type: 'integer', minimum: 1, maximum: 40 } }),
  tool('update_return_status', 'Preview a permitted logistics/review transition on the seller\'s own return, then obtain a subsequent confirmation. Never skip approval, pickup, transit, receipt or review. Rejection requires the seller\'s actual reason. Final refund/replacement uses accept_return, not this tool.', {
    returnId: reference, status: { type: 'string', enum: ['approved', 'pickup_scheduled', 'picked_up', 'in_transit_to_seller', 'received_by_seller', 'under_review', 'rejected'] }, note: { type: 'string' }, confirm,
  }, ['returnId', 'status']),
  tool('accept_return', 'Preview final acceptance of a reviewed return owned by this seller, then wait for subsequent confirmation. Paid Safepay/Wallet returns use held order funds automatically; never charge the seller again. Replacement-only returns move no refund money. COD refunds use seller_balance or send the seller to secure Safepay funding; a payment page is not a completed refund.', {
    returnId: reference, fundingSource: { type: 'string', enum: ['held_order', 'seller_balance', 'safepay'] }, confirm,
  }, ['returnId']),
  tool('request_withdrawal', 'Preview an exact same-currency withdrawal request to the seller\'s already saved matching-currency bank account. First read get_seller_payments. Never use gross earnings or held funds as availability. Show amount/currency, masked destination and no second processing fee, then wait for a subsequent explicit confirmation. Submission reserves funds for admin review; it is NOT a transfer or payout. Ask for a currency if several balances exist; never collect bank credentials in chat.', {
    amount: { type: 'number', exclusiveMinimum: 0 }, currency: { type: 'string', enum: ['USD', 'PKR', 'EUR', 'GBP'] }, confirm,
  }, ['amount', 'currency']),
];
const NEW_COMMERCE_TOOL_NAMES = new Set([...BUYER_COMMERCE_TOOLS, ...SELLER_COMMERCE_TOOLS].map(item => item.function.name));
const REVIEWED_COMMERCE_ACTIONS = new Set(['cancel_order', 'request_return', 'cancel_return', 'update_return_status', 'accept_return', 'request_withdrawal', 'update_order_status']);
module.exports = { BUYER_COMMERCE_TOOLS, SELLER_COMMERCE_TOOLS, NEW_COMMERCE_TOOL_NAMES, REVIEWED_COMMERCE_ACTIONS };
