'use strict';
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Return = require('../models/ReturnRequest');
const Bank = require('../models/SellerPaymentAccount');
const WalletTransaction = require('../models/WalletTransaction');
const Cancellation = require('../models/OrderCancellation');
const { resolveOrderReference } = require('./orderReferenceService');
const { toMinorUnits, fromMinorUnits, roundMoney } = require('./moneyMath');
const { parseStrictFiniteNumber } = require('./numericInputService');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const { executeReviewedCommerceAction } = require('./aiCommercePreviewService');
const { REVIEWED_COMMERCE_ACTIONS } = require('./aiCommerceTools');
const { RETURN_STATUS_TRANSITIONS, RETURN_STATUS_LABELS } = require('./returnPolicyService');
const id = value => String(value?._id || value || '');
const returns = () => require('./returnService');
const cancellation = () => require('./buyerCancellationService');
const payments = () => require('../controllers/PaymentController');
const fail = (message, code = 'AI_COMMERCE_INPUT_REQUIRED', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const money = (amount, currency) => `${Number(amount).toFixed(2)} ${currency}`;
const limit = value => Number.isInteger(value) && value > 0 ? Math.min(value, 40) : 20;
const orderStatuses = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
const clean = (value, max = 1500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function actor(user, sellerOnly = false) {
  if (!mongoose.isValidObjectId(id(user?._id || user?.id)) || !['user', 'seller'].includes(user?.role)) throw fail('Sign in with your buyer or seller account.', 'AI_COMMERCE_AUTH_REQUIRED', 403);
  if (sellerOnly && user.role !== 'seller') throw fail('Only the owner of this store can perform this action.', 'AI_COMMERCE_SELLER_REQUIRED', 403);
  return { id: id(user._id || user.id), role: user.role };
}
async function purchase(reference, user) {
  const owned = await resolveOrderReference({ reference: clean(reference, 160), scope: { user: actor(user).id } });
  if (!owned) throw fail('This purchase was not found in your account.', 'ORDER_NOT_FOUND', 404);
  return owned;
}
async function sellerOrder(reference, user) {
  const sellerId = actor(user, true).id;
  const productIds = (await Product.find({ seller: sellerId }).select('_id').lean()).map(row => row._id);
  const scope = { $or: [{ orderItems: { $elemMatch: { seller: sellerId } } },
    { orderItems: { $elemMatch: { seller: null, productId: { $in: productIds } } } }], awaitingPayment: { $ne: true } };
  const order = await resolveOrderReference({ reference: clean(reference, 160), scope });
  if (!order) throw fail('This order does not contain your store items.', 'ORDER_NOT_FOUND', 404);
  await require('./orderFulfillmentService').ensureOrderSellerFulfillment(order);
  return order;
}
async function ownedReturn(reference, user, view = 'buyer') {
  const owner = actor(user, view === 'seller');
  const value = clean(reference, 160);
  if (!value) throw fail('Tell me which return request you mean.');
  const scope = { [view === 'seller' ? 'seller' : 'buyer']: owner.id };
  const rows = await Return.find({ ...scope, ...(mongoose.isValidObjectId(value) ? { _id: value } : { returnNumber: value }) }).limit(2);
  if (rows.length !== 1) throw fail(rows.length ? 'This return reference is ambiguous. Choose the return from your list.' : 'Return request not found in your account.', 'RETURN_NOT_FOUND', 404);
  return rows[0];
}
function presentReturn(request) {
  const doc = request?.toObject ? request.toObject() : request;
  return { returnId: id(doc), returnNumber: doc.returnNumber, orderId: doc.orderId, sellerId: id(doc.seller),
    status: doc.status, statusLabel: RETURN_STATUS_LABELS[doc.status] || doc.status,
    currency: doc.currency, refund: doc.refund, refundType: doc.policySnapshot?.refundType,
    items: (doc.items || []).map(item => ({ orderItemId: id(item.orderItemId), name: item.name, quantity: item.quantity,
      selectedColor: item.selectedColor, selectedOptions: item.selectedOptions })),
    reasonCategory: doc.reasonCategory, reasonDetails: doc.reasonDetails, sellerNote: doc.sellerNote,
    settlement: { fundingSource: doc.settlement?.fundingSource, status: doc.settlement?.status,
      settledAt: doc.settlement?.settledAt, walletCredited: false,
      walletCreditRecorded: doc.status === 'returned' && doc.settlement?.status === 'completed'
        && Boolean(doc.settlement?.walletTransaction), paymentReviewRequired: Boolean(doc.settlement?.riskPending) },
    nextStatuses: RETURN_STATUS_TRANSITIONS[doc.status] || [],
    canCancelRequest: returns().BUYER_CANCELLABLE_STATUSES.includes(doc.status),
    canAccept: ['under_review', 'accepted_pending_payment'].includes(doc.status), createdAt: doc.createdAt };
}
async function verifiedReturn(request) {
  const result = presentReturn(request);
  if (result.settlement.walletCreditRecorded) {
    const doc = request?.toObject ? request.toObject() : request;
    const transaction = await WalletTransaction.findOne({ _id: doc.settlement.walletTransaction,
      user: doc.buyer, type: 'return_refund', direction: 'credit', status: 'completed',
      referenceType: 'return_request', referenceId: id(doc), currency: doc.currency,
      amount: doc.refund.totalAmount, idempotencyKey: `return-refund:${id(doc)}` }).lean();
    result.settlement.walletCredited = Boolean(transaction) && !result.settlement.paymentReviewRequired;
    if (transaction) {
      const facts = require('./walletService').serializeWalletTransaction(transaction);
      result.settlement.walletBalanceCredit = facts.creditedAmount;
      result.settlement.appliedToLiability = facts.appliedToLiability;
      result.settlement.remainingLiability = facts.remainingLiability;
    }
  }
  if (result.status === 'returned' && !result.settlement.walletCredited) {
    result.statusLabel = result.refundType === 'replacement_only'
      ? 'Return completed for replacement; no money refund'
      : 'Return completed; Wallet refund not yet verified';
  }
  return result;
}
function basicOrder(order) {
  return { _id: id(order), orderId: order.orderId, status: order.orderStatus, currency: order.currency,
    total: order.orderSummary?.totalAmount, paymentMethod: order.paymentMethod,
    paymentRail: order.paymentMethod === 'safepay' ? order.safepayPaymentRail || 'unknown' : undefined,
    originallyPaid: order.isPaid === true, awaitingPayment: order.awaitingPayment === true, date: order.createdAt,
    shipments: (order.sellerFulfillment || []).map(row => ({ sellerId: id(row.seller), status: row.status,
      deliveredAt: row.deliveredAt, cancellable: ['pending', 'confirmed', 'processing'].includes(row.status), cancellation: row.cancellation })) };
}

async function readCommerceTool(name, args, user) {
  const owner = actor(user, ['get_seller_returns', 'get_my_withdrawals', 'get_subdomain_status', 'get_verification_status'].includes(name));
  if (name === 'get_secure_flow') return require('./aiSecureFlowService').getSecureFlow(args.feature, user);
  if (name === 'get_saved_payment_methods') {
    const result = await require('./safepayCustomerService').listCards(owner.id);
    return { success: true, data: { provider: 'safepay', environment: result.environment,
      billingProfileReady: result.billingProfileReady === true,
      cards: (result.cards || []).map(card => ({ brand: card.brand, last4: card.last4,
        expMonth: card.expMonth, expYear: card.expYear, usable: card.usable === true,
        isDefault: card.id === result.defaultPaymentMethodId })) },
      message: `Found ${(result.cards || []).length} saved Safepay card(s) in ${result.environment}. Card entry and changes happen only on the secure Payment Methods screen. No card was added, deleted or charged.` };
  }
  if (name === 'get_my_withdrawals') {
    const requests = await require('../models/SellerWithdrawalRequest').find({ seller: owner.id })
      .select('amount currency requestedAmount requestedCurrency status createdAt updatedAt rejectionReason failureReason paidAt')
      .sort({ createdAt: -1 }).limit(limit(args.limit)).lean();
    return { success: true, data: { requests, count: requests.length },
      message: `Showing ${requests.length} existing withdrawal request(s). Amounts retain their original currencies. Only the recorded paid status indicates an admin-recorded payout; pending, approved and processing do not mean money has reached your bank. No new request or transfer was made.` };
  }
  if (['get_subdomain_status', 'get_verification_status'].includes(name)) {
    const store = await require('../models/Store').findOne({ seller: owner.id })
      .select('storeName storeSlug isActive moderationStatus verification subdomainPurchase').lean();
    if (!store) throw fail('Create your store before checking its settings.', 'STORE_NOT_FOUND', 404);
    if (name === 'get_verification_status') return { success: true, data: { storeName: store.storeName, verification: store.verification },
      message: `Store verification: ${store.verification?.isVerified ? 'verified' : store.verification?.status || 'not requested'}. No verification decision was changed.` };
    const paid = store.subdomainPurchase;
    const activeOwnership = Boolean(paid?.isPurchased && paid.expiresAt && new Date(paid.expiresAt).getTime() > Date.now());
    return { success: true, data: { storeName: store.storeName, slug: store.storeSlug,
      url: store.storeSlug ? `https://${store.storeSlug}.rozare.com/` : null,
      storeActive: store.isActive !== false, moderationStatus: store.moderationStatus,
      purchasedOwnershipActive: activeOwnership, expiresAt: paid?.expiresAt || null,
      paymentRiskState: paid?.paymentRiskState || 'none', removalScheduledAt: paid?.removalScheduledAt || null },
      message: `Your subdomain is ${store.storeSlug}.rozare.com. Purchased ownership is ${activeOwnership ? 'currently recorded as active' : 'not currently active'}; store availability and payment-risk restrictions are separate. No subdomain was bought or renewed.` };
  }
  if (name === 'get_wallet_balance') {
    const summary = await require('./walletService').getWalletSummary(owner.id, { limit: 10 });
    const restricted = summary.wallet.status !== 'active' || summary.wallet.paymentRisk.restricted;
    const notice = `Your personal Wallet balances: ${Object.entries(summary.wallet.balances).map(([currency, amount]) => money(amount, currency)).join('; ')}. `
      + (restricted ? 'The Wallet is restricted/locked; do not treat these balances as spendable. Check Wallet for the required resolution.' : 'Each currency is separate and never automatically converted.');
    return { success: true, message: notice, requiredDisclosure: notice, data: { balances: summary.wallet.balances, status: summary.wallet.status,
      restricted, lockedReason: summary.wallet.lockedReason, transactions: summary.transactions.map(row => ({ type: row.type,
        status: row.status, amount: row.amount, currency: row.currency, creditedAmount: row.creditedAmount,
        appliedToLiability: row.appliedToLiability, remainingLiability: row.remainingLiability, createdAt: row.createdAt })) } };
  }
  if (name === 'get_purchase_orders') {
    if (args.status && args.status !== 'all' && !orderStatuses.has(args.status)) throw fail('Choose a valid order status.');
    const filter = { user: owner.id, awaitingPayment: { $ne: true },
      ...(args.status && args.status !== 'all' ? { orderStatus: args.status } : {}) };
    const [orders, totalCount] = await Promise.all([Order.find(filter).sort({ createdAt: -1 }).limit(limit(args.limit)).lean(), Order.countDocuments(filter)]);
    return { success: true, data: { orders: orders.map(basicOrder), count: orders.length, totalCount, scope: 'personal-purchases' },
      message: `Found ${totalCount} personal purchases (showing ${orders.length}). These are not your store's received orders.` };
  }
  if (['get_purchase_order_detail', 'get_return_eligibility'].includes(name)) {
    const order = await purchase(args.orderId, user);
    const groups = await returns().buildOrderReturnEligibility(order);
    if (name === 'get_return_eligibility') return { success: true, data: { orderId: order.orderId, groups },
      message: 'These are the frozen item policies, remaining returnable quantities and deadlines. No return has been submitted.' };
    const receipt = await require('./orderReceiptService').getOwnedOrderReceipt({ reference: id(order), buyerId: owner.id });
    return { success: true, data: { ...basicOrder(order), paymentStatus: receipt?.paymentStatus || 'review_required',
      isPaid: receipt?.isPaid === true, orderPlaced: receipt?.orderPlaced === true, summary: order.orderSummary,
      deliveryAddress: { address: order.shippingInfo?.address, city: order.shippingInfo?.city,
        state: order.shippingInfo?.state, postalCode: order.shippingInfo?.postalCode, country: order.shippingInfo?.country },
      items: (order.orderItems || []).map(item => ({ orderItemId: id(item), sellerId: id(item.seller),
        name: item.name, quantity: item.quantity, price: item.price, selectedColor: item.selectedColor, selectedOptions: item.selectedOptions })),
      returnGroups: groups }, message: `Purchase ${order.orderId}: ${order.orderStatus}. Payment status: ${receipt?.paymentStatus || 'needs review'}.` };
  }
  if (['get_my_returns', 'get_seller_returns'].includes(name)) {
    const scope = name === 'get_seller_returns' ? 'seller' : 'buyer';
    const filter = { [scope]: owner.id, ...(args.status && args.status !== 'all' ? { status: args.status } : {}) };
    if (args.orderId) {
      const order = scope === 'seller' ? await sellerOrder(args.orderId, user) : await purchase(args.orderId, user);
      filter.order = order._id;
    }
    const [requests, totalCount] = await Promise.all([Return.find(filter).sort({ createdAt: -1 }).limit(limit(args.limit)).lean(), Return.countDocuments(filter)]);
    return { success: true, data: { returns: await Promise.all(requests.map(verifiedReturn)), count: requests.length, totalCount, scope },
      message: `Found ${totalCount} ${scope === 'seller' ? 'store' : 'personal'} return requests (showing ${requests.length}). Only completed settlement proves a Wallet refund.` };
  }
  const view = args.view === 'buyer' ? 'buyer' : user.role === 'seller' ? 'seller' : 'buyer';
  const request = await ownedReturn(args.returnId, user, view);
  return { success: true, data: await verifiedReturn(request), message: `Return ${request.returnNumber}: ${RETURN_STATUS_LABELS[request.status] || request.status}. Check the verified settlement outcome before claiming a Wallet refund.` };
}

function resolveOwnedStoreGroup(selector, groups) {
  const value = clean(selector, 160).toLowerCase();
  const candidates = value ? groups.filter(group => [id(group.seller), id(group.store?._id),
    String(group.store?.storeName || '').trim()].some(reference => reference.toLowerCase() === value)) : [];
  if (candidates.length !== 1) throw fail('Choose the store from this order: ' + groups.map(group => group.store?.storeName || 'Unnamed store').join(', ') + '. No portion was cancelled.', 'AI_COMMERCE_STORE_AMBIGUOUS');
  return candidates[0];
}
function requestedSellers(args, groups) {
  const named = args.storeName ? resolveOwnedStoreGroup(args.storeName, groups) : null;
  if (args.sellerIds !== undefined) {
    if (!Array.isArray(args.sellerIds) || !args.sellerIds.length) throw fail('Choose a store portion from this order.', 'AI_COMMERCE_STORE_AMBIGUOUS');
    const resolved = args.sellerIds.map(selector => id(resolveOwnedStoreGroup(selector, groups).seller));
    if (named && resolved.some(seller => seller !== id(named.seller))) throw fail('The store name and selected portions disagree. Review the exact store again.', 'AI_COMMERCE_STORE_AMBIGUOUS');
    return resolved;
  }
  return named ? [id(named.seller)] : undefined;
}
async function prepare(action, args, user) {
  const owner = actor(user, ['update_return_status', 'accept_return', 'request_withdrawal', 'update_order_status'].includes(action));
  if (action === 'cancel_order') {
    const order = await purchase(args.orderId, user);
    if (order.awaitingPayment === true) {
      return { title: 'Cancel unpaid checkout', input: { orderId: id(order), reason: clean(args.reason, 300) },
        contract: { orderId: id(order), publicOrderId: order.orderId, status: order.orderStatus, awaitingPayment: true, originallyPaid: order.isPaid === true },
        notice: `Request cancellation of unpaid checkout ${order.orderId}. No refund is promised. Closing or cancelling checkout does not permanently expire a Safepay link; Rozare still verifies any later payment.` };
    }
    const groups = await returns().buildOrderReturnEligibility(order);
    const sellerIds = requestedSellers(args, groups);
    const quote = await cancellation().previewBuyerCancellation({ orderId: order._id, buyerId: owner.id, sellerIds });
    const enabledOptions = quote.options.filter(option => option.available);
    const selected = enabledOptions.length === 1 ? enabledOptions[0].destination : args.refundDestination || null;
    if (selected && !quote.options.some(option => option.destination === selected && option.available)) throw fail('That refund destination is unavailable. Choose the full Wallet option.', 'REFUND_DESTINATION_INVALID');
    const options = quote.options.filter(option => option.available).map(option => ({ destination: option.destination,
      label: option.label, amount: fromMinorUnits(option.amountMinor), currency: quote.currency,
      deduction: fromMinorUnits(option.deductionMinor) }));
    const portions = quote.activeSellerIds.map(seller => {
      const name = (order.sellerPolicies || []).find(row => id(row.seller) === seller)?.storeName || 'Selected store';
      const items = order.orderItems.filter(item => id(item.seller) === seller)
        .map(item => `${item.quantity} × ${item.name}${item.selectedColor ? ` (${item.selectedColor})` : ''}`).join(', ');
      return `${name}: ALL its selected-store items (${items}).`;
    }).join('\n');
    const notice = `Cancel only the selected unshipped store portion(s) of ${order.orderId}. Cancellation is per store portion, not an individual product line.\n${portions}\nShipped/delivered portions remain unchanged. Frozen cancelled purchase amount: ${money(fromMinorUnits(quote.grossMinor), quote.currency)}.\n`
      + options.map(option => option.destination === 'none' ? 'COD: no money refund is needed.'
        : `${option.label}: ${money(option.amount, option.currency)} refund; processing deduction ${money(option.deduction, option.currency)}.`).join('\n')
      + (options.length > 1 && !selected ? '\nChoose Wallet or the original card; neither is submitted yet.' : '');
    return { title: 'Review cancellation', input: { orderId: id(order), sellerIds: quote.sellerIds, ...(selected ? { refundDestination: selected } : {}) },
      contract: { ...quote, publicOrderId: order.orderId }, notice, options, data: { cancellationQuote: quote } };
  }
  if (action === 'request_return') {
    const order = await purchase(args.orderId, user);
    const groups = await returns().buildOrderReturnEligibility(order);
    let group = args.sellerId ? resolveOwnedStoreGroup(args.sellerId, groups) : null;
    if (!group && args.storeName) {
      const matches = groups.filter(row => String(row.store?.storeName || '').toLowerCase() === clean(args.storeName).toLowerCase());
      if (matches.length === 1) group = matches[0];
    }
    if (!group && groups.length === 1 && !args.sellerId && !args.storeName) group = groups[0];
    if (!group) throw fail('Choose which store portion to return. Requests are seller-specific.', 'AI_COMMERCE_STORE_AMBIGUOUS');
    if (!Array.isArray(args.items) || !args.items.length) throw fail('Choose the exact items and quantities to return.');
    const items = args.items.map(selection => {
      if (selection.orderItemId) return { orderItemId: String(selection.orderItemId), quantity: selection.quantity };
      const candidates = group.items.filter(item => clean(item.name).toLowerCase() === clean(selection.itemName).toLowerCase());
      if (candidates.length !== 1) throw fail('Choose the exact order item and its variant from the eligibility list.', 'AI_COMMERCE_ITEM_AMBIGUOUS');
      return { orderItemId: id(candidates[0].orderItemId), quantity: selection.quantity };
    });
    const input = { orderId: id(order), sellerId: id(group.seller), items, reasonCategory: args.reasonCategory, reasonDetails: clean(args.reasonDetails) };
    const quote = await returns().previewReturnRequest({ ...input, buyerId: owner.id, requestKey: 'ai-preview-request' });
    return { title: 'Review return request', input,
      contract: quote, data: { returnPreview: quote },
      notice: `Request a return from ${quote.storeName} for ${order.orderId}: ${quote.items.map(item => `${item.quantity} × ${item.name}`).join(', ')}.\nReason: ${quote.reasonDetails}.\n`
        + (quote.policy.refundType === 'replacement_only' ? 'Resolution: replacement only; no money refund.'
          : `Frozen potential Wallet refund: ${money(quote.refund.totalAmount, quote.currency)} after the return is reviewed and accepted. A request alone does not refund money.`) };
  }
  if (action === 'request_withdrawal') {
    if (!isSupportedCurrency(args.currency)) throw fail('Choose one earned balance currency: USD, PKR, EUR or GBP. No conversion is available.', 'WITHDRAWAL_CURRENCY_REQUIRED');
    const currency = normalizeCurrency(args.currency);
    const amount = parseStrictFiniteNumber(args.amount);
    if (amount === null || amount <= 0 || roundMoney(amount) !== amount) throw fail('Enter a positive withdrawal amount with no more than two decimal places.', 'WITHDRAWAL_AMOUNT_INVALID');
    const summary = await payments().buildSellerPaymentSummary(owner.id, { displayCurrency: currency });
    const balance = summary.balanceByCurrency[currency];
    const account = summary.paymentAccount;
    const bank = await Bank.findOne({ seller: owner.id, isActive: true }).select('_id updatedAt currency').lean();
    if (!account || !bank) throw fail('Add your bank details in Seller Dashboard > Payments before requesting a withdrawal.', 'WITHDRAWAL_BANK_REQUIRED');
    if (account.currency !== currency || bank.currency !== currency) throw fail('Your saved bank account must accept the selected balance currency. Change bank details in Payments; balances are not converted.', 'WITHDRAWAL_BANK_CURRENCY_MISMATCH');
    if (summary.paymentRiskPending || summary.legacyWithdrawalHold) throw fail('A payment or payout reconciliation hold prevents withdrawal. Check Payments for details.', 'SELLER_PAYMENT_RISK_PENDING', 423);
    if (!balance || amount < balance.minimumWithdrawal) throw fail(`The minimum withdrawal is ${money(balance?.minimumWithdrawal || 0, currency)}.`, 'WITHDRAWAL_MINIMUM_NOT_MET');
    if (toMinorUnits(amount) > toMinorUnits(balance.withdrawableBalance)) throw fail(`You can withdraw at most ${money(balance.withdrawableBalance, currency)}. Pending/return-held funds are unavailable.`, 'INSUFFICIENT_SELLER_BALANCE');
    const accountVersion = new Date(bank.updatedAt).toISOString();
    const similar = summary.withdrawals.filter(row => (row.requestedCurrency || row.currency) === currency
      && (row.requestedAmount ?? row.amount) === amount
      && (['pending', 'approved', 'processing', 'manual_review'].includes(row.status)
        || new Date(row.createdAt).getTime() > Date.now() - 10 * 60000));
    return { title: 'Review withdrawal request', input: { amount, currency },
      contract: { amount, currency, bankId: id(bank), accountVersion, similarRequestIds: similar.map(id).sort() },
      data: { anotherRequestRequired: similar.length > 0 },
      notice: `Request ${money(amount, currency)} from your net withdrawable balance to ${account.bankName || 'your saved bank'} ${account.maskedIban || account.maskedAccountNumber || '(masked account)'}.\nNo additional checkout fee is deducted for this withdrawal. This reserves the amount for admin review; it does not send money. The admin pays manually in the same currency.`
        + (similar.length ? `\nThere are already ${similar.length} recent or active requests for this same amount and currency. This would create ANOTHER NEW request, not retry the previous one. Explicitly confirm another new request only if that is what you intend.` : '') };
  }
  if (action === 'update_order_status') {
    const order = await sellerOrder(args.orderId, user);
    const fulfillment = order.sellerFulfillment.find(row => id(row.seller) === owner.id);
    if (!['confirmed', 'processing', 'shipped', 'delivered'].includes(args.newStatus)) throw fail('Choose confirmed, processing, shipped or delivered. Sellers cannot cancel through a status change.');
    return { title: 'Review shipment update', input: { orderId: id(order), newStatus: args.newStatus },
      contract: { orderId: id(order), publicOrderId: order.orderId, sellerId: owner.id, from: fulfillment?.status, to: args.newStatus, version: order.returnVersion || 0,
        awaitingPayment: order.awaitingPayment === true, isPaid: order.isPaid === true },
      notice: `Change only your store's portion of ${order.orderId} from ${fulfillment?.status} to ${args.newStatus}. Other sellers' shipments will not change. Only confirm if this reflects the actual fulfilment state.` };
  }
  const view = action === 'cancel_return' ? 'buyer' : 'seller';
  const request = await ownedReturn(args.returnId, user, view);
  const input = { returnId: id(request), ...(args.note ? { note: clean(args.note, 1000) } : {}) };
  const contract = { returnId: id(request), returnNumber: request.returnNumber, status: request.status, updatedAt: request.updatedAt,
    refund: request.refund, currency: request.currency, settlementStatus: request.settlement?.status };
  if (action === 'cancel_return') {
    if (!returns().BUYER_CANCELLABLE_STATUSES.includes(request.status)) throw fail('This return can no longer be cancelled because pickup or review has begun.', 'RETURN_CANCELLATION_UNAVAILABLE', 409);
    return { title: 'Cancel return request', input, contract,
      notice: `Cancel return ${request.returnNumber}. This does not cancel the purchase or issue a money refund.` };
  }
  if (action === 'update_return_status') {
    if (!(RETURN_STATUS_TRANSITIONS[request.status] || []).includes(args.status)) throw fail(`The return cannot move from ${request.status} to ${args.status}. Complete the required steps in order.`, 'INVALID_RETURN_STATUS_TRANSITION', 409);
    if (args.status === 'rejected' && clean(args.note).length < 5) throw fail('Provide your actual rejection reason before rejecting this return.', 'RETURN_REJECTION_REASON_REQUIRED');
    return { title: 'Review return status', input: { ...input, status: args.status }, contract: { ...contract, to: args.status },
      notice: `Move your store return ${request.returnNumber} from ${RETURN_STATUS_LABELS[request.status]} to ${RETURN_STATUS_LABELS[args.status]}.${args.note ? `\nYour note: ${clean(args.note, 1000)}` : ''}\nThis status step does not credit a refund.` };
  }
  if (!['under_review', 'accepted_pending_payment'].includes(request.status)) throw fail('Final acceptance is available only after the item is received and reviewed. Inspect the return for its next allowed step.', 'RETURN_ACCEPTANCE_UNAVAILABLE', 409);
  const order = await Order.findById(request.order);
  if (!order) throw fail('The original return order is unavailable.', 'RETURN_ORDER_MISSING', 409);
  const replacement = request.policySnapshot?.refundType === 'replacement_only';
  const held = ['wallet', 'safepay'].includes(order.paymentMethod) && order.isPaid === true;
  const fundingSource = replacement ? 'replacement' : held ? 'held_order' : args.fundingSource;
  if (!replacement && !held && !['seller_balance', 'safepay'].includes(fundingSource)) throw fail('This is a COD return. Choose available seller balance or secure Safepay funding.', 'RETURN_FUNDING_CHOICE_REQUIRED');
  return { title: 'Review return acceptance', input: { ...input, fundingSource }, contract: { ...contract, fundingSource, paymentMethod: order.paymentMethod, originallyPaid: order.isPaid === true },
    notice: `Accept reviewed return ${request.returnNumber}. ` + (replacement ? 'Approve the replacement; no money refund.'
      : `Buyer Wallet refund: ${money(request.refund.totalAmount, request.currency)}. ` + (held ? 'Use this order\'s held online money; do not charge the seller again.'
        : fundingSource === 'seller_balance' ? 'Debit your available same-currency seller balance and credit the buyer Wallet only if the transaction succeeds.'
          : 'Continue to the secure Safepay funding screen. Opening that screen is not a payment or completed Wallet refund.')) };
}

async function controllerCall(controller, user, body, params = {}) {
  let status = 200, response;
  const res = { status(code) { status = code; return this; }, json(value) { response = value; return this; }, set() { return this; } };
  await controller({ user: { id: id(user._id || user.id), role: user.role }, params, body, query: {}, get: key => key.toLowerCase() === 'idempotency-key' ? body.idempotencyKey : undefined }, res);
  if (status >= 500 || !response) return { success: false, uncertain: true };
  if (status >= 400 || response.success === false) return { success: false, code: response.code || 'AI_COMMERCE_REJECTED', error: response.msg || 'The action was not accepted.' };
  return { success: true, data: response, message: response.msg || 'The action completed.' };
}
async function execute(action, input, user, preview) {
  const owner = actor(user);
  const requestKey = 'ai-commerce:' + preview.token.slice(5);
  if (action === 'request_withdrawal') {
    const result = await controllerCall(payments().createWithdrawalRequest, user, { requestedAmount: input.amount, requestedCurrency: input.currency,
      idempotencyKey: requestKey, expectedPaymentAccountId: preview.contract.bankId, expectedPaymentAccountUpdatedAt: preview.contract.accountVersion });
    if (result.success) result.message = `Withdrawal request submitted for ${money(input.amount, input.currency)}. It is awaiting admin processing, not paid. This amount is reserved; no additional checkout fee was deducted.`;
    return result;
  }
  if (action === 'cancel_order') {
    const order = await purchase(input.orderId, user);
    if (order.awaitingPayment === true) {
      const result = await require('./orderCancellationService').cancelOrderSafely({ orderId: order._id,
        reason: 'Buyer cancelled an unpaid checkout through Rozare AI.', cancellationActorRole: 'buyer' });
      return { success: true, data: { orderId: order.orderId, status: result.status },
        message: result.status === 'cancelled' ? `Unpaid checkout ${order.orderId} cancelled locally. No refund was issued; Safepay still verifies any later payment through its live link.`
          : `The payment is being verified. Cancellation is not confirmed yet for ${order.orderId}.` };
    }
    const quote = preview.contract;
    const available = quote.options.filter(option => option.available);
    const destination = input.refundDestination || (available.length === 1 ? available[0].destination : null);
    if (!destination) return { success: false, code: 'REFUND_CHOICE_REQUIRED', error: 'Choose Wallet or the original card before confirming cancellation.' };
    const cancelled = await cancellation().cancelBuyerOrder({ orderId: order._id, buyerId: owner.id,
      sellerIds: input.sellerIds, refundDestination: destination, quoteId: quote.quoteId,
      acceptDeduction: destination === 'original_card' });
    const selected = cancelled.sellerFulfillment.filter(row => input.sellerIds.includes(id(row.seller)));
    const results = selected.map(row => ({ sellerId: id(row.seller), status: row.status, cancellation: row.cancellation }));
    const credited = results.every(row => row.cancellation?.refundStatus === 'refunded');
    let walletCredit, liabilityApplied;
    if (destination === 'wallet' && credited) {
      const rows = await Cancellation.find({ order: order._id, buyer: owner.id, seller: { $in: quote.activeSellerIds },
        refundDestination: 'wallet', refundStatus: 'refunded' }).lean();
      if (rows.length !== quote.activeSellerIds.length || rows.reduce((sum, row) => sum + (row.refundAmountMinor ?? row.amountMinor), 0) !== quote.grossMinor) {
        throw fail('The exact Wallet refund allocation needs reconciliation. No repeat refund will be attempted.', 'AI_COMMERCE_ACTION_PENDING', 503);
      }
      walletCredit = 0; liabilityApplied = 0;
      for (const row of rows) {
        const transaction = await WalletTransaction.findOne({ _id: row.walletTransaction, user: owner.id, type: 'return_refund',
          direction: 'credit', status: 'completed', referenceType: 'order_cancellation', referenceId: id(row), currency: quote.currency,
          idempotencyKey: `order-cancellation:${id(row)}:wallet`, amount: fromMinorUnits(row.refundAmountMinor ?? row.amountMinor) }).lean();
        if (!transaction) throw fail('The Wallet refund record needs reconciliation. Do not submit another cancellation.', 'AI_COMMERCE_ACTION_PENDING', 503);
        const facts = require('./walletService').serializeWalletTransaction(transaction);
        walletCredit += toMinorUnits(facts.creditedAmount); liabilityApplied += toMinorUnits(facts.appliedToLiability);
      }
    }
    return { success: true, data: { orderId: cancelled.orderId, portions: results, currency: quote.currency, refundDestination: destination },
      message: destination === 'none' ? `Selected unshipped portions of ${cancelled.orderId} cancelled. ${order.paymentMethod === 'cash_on_delivery' ? 'COD: no refund was required.' : 'No new money refund was required.'}`
        : destination === 'wallet' && credited ? `Selected unshipped portions of ${cancelled.orderId} cancelled and ${money(fromMinorUnits(quote.grossMinor), quote.currency)} credited to Rozare Wallet with no buyer processing deduction.`
          + (liabilityApplied > 0 ? ` Wallet balance credit: ${money(fromMinorUnits(walletCredit), quote.currency)}; ${money(fromMinorUnits(liabilityApplied), quote.currency)} applied to your outstanding Wallet liability. Check Wallet restrictions before spending.` : '')
          : `Selected unshipped portions of ${cancelled.orderId} cancelled. Refund destination: ${destination === 'wallet' ? 'Wallet' : 'original card'}. Check the returned refund status; submission is not confirmed refund delivery.` };
  }
  if (action === 'request_return') {
    const request = await returns().createReturnRequest({ ...input, buyerId: owner.id, requestKey });
    return { success: true, data: presentReturn(request), message: `Return ${request.returnNumber} requested. The seller must process and review it; no refund has been credited yet.` };
  }
  if (action === 'update_order_status') {
    const order = await sellerOrder(input.orderId, user);
    const { order: updated } = await require('./orderStatusTransitionService').transitionOrderFulfillment({ orderId: order._id,
      actorRole: 'seller', actorId: owner.id, sellerIds: order.sellerFulfillment.map(row => id(row.seller)), newStatus: input.newStatus });
    const status = updated.sellerFulfillment.find(row => id(row.seller) === owner.id)?.status;
    return { success: true, data: { orderId: updated.orderId, status, aggregateOrderStatus: updated.orderStatus },
      message: `Your store portion of ${updated.orderId} is ${status}. Other sellers' portions were not changed.` };
  }
  if (action === 'cancel_return') {
    const request = await returns().cancelReturnRequest({ returnRequestId: input.returnId, buyerId: owner.id, note: input.note });
    return { success: true, data: presentReturn(request), message: `Return ${request.returnNumber} cancelled. The purchase was not cancelled and no refund was issued.` };
  }
  if (action === 'update_return_status') {
    const request = await returns().updateReturnStatus({ returnRequestId: input.returnId, actor: owner, nextStatus: input.status,
      note: input.note, expectedUpdatedAt: new Date(preview.contract.updatedAt).toISOString() });
    return { success: true, data: presentReturn(request), message: `Return ${request.returnNumber}: ${RETURN_STATUS_LABELS[request.status]}. This status update is not a completed refund.` };
  }
  if (input.fundingSource === 'safepay') {
    const request = await ownedReturn(input.returnId, user, 'seller');
    const route = `/seller-dashboard/order/${id(request.order)}`;
    return { success: true, requiresPayment: true, data: { ...presentReturn(request), route, secureCheckoutRequired: true },
      message: `Continue in your order's Return Orders section to fund ${money(request.refund.totalAmount, request.currency)} through secure Safepay checkout: https://rozare.com${route}. No payment or Wallet credit has occurred in chat.` };
  }
  const result = await controllerCall(require('../controllers/returnController').acceptReturn, user,
    { fundingSource: input.fundingSource === 'held_order' ? 'seller_balance' : input.fundingSource,
      expectedRefundAmount: preview.contract.refund.totalAmount, expectedRefundCurrency: preview.contract.currency,
      expectedReturnUpdatedAt: new Date(preview.contract.updatedAt).toISOString() }, { id: input.returnId });
  if (result.success && result.data.returnRequest) {
    result.data = await verifiedReturn(result.data.returnRequest);
    result.message = result.data.settlement.walletCredited
      ? `Return ${result.data.returnNumber} completed: ${money(result.data.refund.totalAmount, result.data.currency)} credited to the buyer Wallet from ${input.fundingSource === 'held_order' ? 'held order funds' : 'seller balance'}.`
        + (result.data.settlement.appliedToLiability > 0 ? ` Wallet balance credit: ${money(result.data.settlement.walletBalanceCredit, result.data.currency)}; ${money(result.data.settlement.appliedToLiability, result.data.currency)} applied to the buyer's outstanding Wallet liability.` : '')
      : `Return ${result.data.returnNumber}: ${result.data.statusLabel}. No Wallet refund is claimed without completed settlement.`;
  }
  return result;
}

async function executeCommerceTool(name, args = {}, user) {
  try {
    if (name === 'get_payment_options') {
      const config = require('../config/safepay').readSafepayConfig(process.env, { requireWebhook: true });
      return { success: true, data: { provider: 'safepay', environment: config.environment,
        webEnabled: process.env.SAFEPAY_WEB_ENABLED === 'true', mobileEnabled: process.env.SAFEPAY_MOBILE_ENABLED === 'true',
        currencies: ['USD', 'PKR', 'EUR', 'GBP'], raastEligibility: 'PKR hosted payment only, if offered by the secure form',
        savedCardsAndRecurringBilling: 'card-only', onlinePurchasesRequireSecureCheckout: true,
        sandboxUsesSimulatedMoney: config.environment === 'sandbox' },
        message: `Safepay is currently configured for ${config.environment === 'sandbox' ? 'Sandbox testing (simulated payments)' : 'live real-money payments'}. Method availability is decided by its secure form; configuration does not prove a payment succeeded.` };
    }
    actor(user);
    if (!REVIEWED_COMMERCE_ACTIONS.has(name)) return await readCommerceTool(name, args, user);
    const result = await executeReviewedCommerceAction(name, args, user, { prepare, execute });
    // Financial messages are a receipt/disclosure, not discretionary model
    // prose. The existing cross-channel renderer gives this wording priority.
    return { ...result, requiredDisclosure: result.message || result.error };
  } catch (error) {
    return { success: false, code: error.code || 'AI_COMMERCE_UNAVAILABLE', error: error.statusCode ? error.message : 'This action could not be verified. Refresh the relevant order, return or Payments page and try again.' };
  }
}
module.exports = { executeCommerceTool, prepare, execute, presentReturn, basicOrder, actor, controllerCall, resolveOwnedStoreGroup, requestedSellers };
