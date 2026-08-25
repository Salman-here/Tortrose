'use strict';

const { CURRENCIES, isSupportedCurrency } = require('./currencyService');
const { fromMinorUnits, toMinorUnits } = require('./moneyMath');
const {
  getFrozenSellerSettlement,
  sellerSettlementEntry,
} = require('./orderMoneyService');

const notificationMoneyError = (message, code = 'NOTIFICATION_MONEY_INVALID') => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
};

const requireSourceId = value => {
  const id = value?._id?.toString?.() || value?.toString?.() || '';
  if (!id || id.length > 200) {
    throw notificationMoneyError('Notification money requires an authoritative source document id.');
  }
  return id;
};

const requireStoredCurrency = (value, field = 'stored currency') => {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value !== value.toUpperCase()
    || !isSupportedCurrency(value)
  ) {
    throw notificationMoneyError(`The ${field} is invalid or unsupported.`);
  }
  return value;
};

const requireStripeStoredCurrency = (value, field = 'Stripe stored currency') => {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value !== value.toLowerCase()
    || !isSupportedCurrency(value.toUpperCase())
  ) {
    throw notificationMoneyError(`The ${field} is invalid or unsupported.`);
  }
  return value.toUpperCase();
};

const requireExactStoredMoney = (value, field = 'stored money') => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw notificationMoneyError(`The ${field} must be a non-negative finite number.`);
  }
  let minor;
  try {
    minor = toMinorUnits(value);
  } catch (_) {
    throw notificationMoneyError(`The ${field} is outside the supported money range.`);
  }
  if (fromMinorUnits(minor) !== value) {
    throw notificationMoneyError(`The ${field} is not exact to the currency minor unit.`);
  }
  return { amount: value, amountMinor: minor };
};

const requireStoredMinorUnits = (value, field = 'stored minor-unit amount') => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw notificationMoneyError(`The ${field} must be a non-negative safe integer.`);
  }
  return value;
};

const requireSnapshotMetadata = ({ key, label = '', sourceModel, sourceDocumentId, sourcePath }) => {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(key)) {
    throw notificationMoneyError('Notification money snapshot keys are invalid.');
  }
  if (typeof label !== 'string' || label.length > 100) {
    throw notificationMoneyError('Notification money snapshot labels are invalid.');
  }
  if (typeof sourceModel !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(sourceModel)) {
    throw notificationMoneyError('Notification money source models are invalid.');
  }
  if (typeof sourcePath !== 'string' || !/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,159}$/.test(sourcePath)) {
    throw notificationMoneyError('Notification money source paths are invalid.');
  }
  return {
    key,
    label,
    sourceModel,
    sourceDocumentId: requireSourceId(sourceDocumentId),
    sourcePath,
  };
};

const snapshotMajorMoney = ({ amount, currency, ...metadata }) => {
  const storedCurrency = requireStoredCurrency(currency);
  const exact = requireExactStoredMoney(amount);
  return {
    ...requireSnapshotMetadata(metadata),
    amountMinor: exact.amountMinor,
    currency: storedCurrency,
  };
};

const snapshotMinorMoney = ({ amountMinor, currency, stripeCurrency = false, ...metadata }) => ({
  ...requireSnapshotMetadata(metadata),
  amountMinor: requireStoredMinorUnits(amountMinor),
  currency: stripeCurrency
    ? requireStripeStoredCurrency(currency)
    : requireStoredCurrency(currency),
});

const formatMoneySnapshot = snapshot => {
  const currency = requireStoredCurrency(snapshot?.currency, 'notification snapshot currency');
  const amountMinor = requireStoredMinorUnits(snapshot?.amountMinor, 'notification snapshot amount');
  // Format from the authoritative integer directly. Converting a very large
  // safe minor-unit integer to a major-unit Number first can lose its final
  // cent even though the stored integer itself is exact.
  const minor = BigInt(amountMinor);
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (minor % 100n).toString().padStart(2, '0');
  const symbol = CURRENCIES[currency].symbol;
  return `${symbol}${whole}.${fraction}${currency === 'USD' ? '' : ` ${currency}`}`;
};

const orderTotalSnapshot = (order, key = 'order_total') => snapshotMajorMoney({
  key,
  label: 'Order total',
  amount: order?.orderSummary?.totalAmount,
  currency: order?.currency,
  sourceModel: 'Order',
  sourceDocumentId: order?._id,
  sourcePath: 'orderSummary.totalAmount',
});

const orderStockRefundSnapshot = (order, key = 'refund_total') => snapshotMinorMoney({
  key,
  label: 'Completed Stripe stock-loss refund',
  amountMinor: order?.paymentResult?.stockRefundAmountMinor,
  currency: order?.paymentResult?.stockRefundCurrency,
  sourceModel: 'Order',
  sourceDocumentId: order?._id,
  sourcePath: 'paymentResult.stockRefundAmountMinor',
});

const orderSellerTotalSnapshot = (order, sellerId, key = 'seller_order_total') => {
  const sellerKey = sellerId?._id?.toString?.() || sellerId?.toString?.() || '';
  // Validate the complete frozen allocation before selecting a recipient. A
  // locally plausible seller row is not authoritative when another row is
  // duplicated, malformed, uses a different currency, or breaks conservation.
  const frozenSettlement = getFrozenSellerSettlement(order);
  const settlement = sellerSettlementEntry(frozenSettlement, sellerKey);
  if (!settlement) {
    throw notificationMoneyError(
      'The order has no frozen seller settlement for this recipient.',
      'NOTIFICATION_SELLER_SETTLEMENT_MISSING'
    );
  }
  return snapshotMinorMoney({
    key,
    label: 'Seller order allocation',
    amountMinor: settlement.sourceAmountMinor,
    currency: settlement.sourceCurrency,
    sourceModel: 'Order',
    sourceDocumentId: order?._id,
    sourcePath: `sellerSettlement[${sellerKey}].sourceAmountMinor`,
  });
};

const sellerSettlementUsdSnapshot = (order, sellerId, key = 'seller_settlement_usd') => {
  const sellerKey = sellerId?._id?.toString?.() || sellerId?.toString?.() || '';
  const frozenSettlement = getFrozenSellerSettlement(order);
  const settlement = sellerSettlementEntry(frozenSettlement, sellerKey);
  if (!settlement) {
    throw notificationMoneyError(
      'The order has no frozen seller settlement for this recipient.',
      'NOTIFICATION_SELLER_SETTLEMENT_MISSING'
    );
  }
  return snapshotMinorMoney({
    key,
    label: 'Seller settlement ledger amount',
    amountMinor: settlement.amountUSDMinor,
    currency: 'USD',
    sourceModel: 'Order',
    sourceDocumentId: order?._id,
    sourcePath: `sellerSettlement[${sellerKey}].amountUSDMinor`,
  });
};

const returnRefundSnapshot = (returnRequest, key = 'refund_total') => snapshotMajorMoney({
  key,
  label: 'Return refund total',
  amount: returnRequest?.refund?.totalAmount,
  currency: returnRequest?.currency,
  sourceModel: 'ReturnRequest',
  sourceDocumentId: returnRequest?._id,
  sourcePath: 'refund.totalAmount',
});

const withdrawalRequestedSnapshot = (withdrawal, key = 'requested_amount') => snapshotMajorMoney({
  key,
  label: 'Requested withdrawal amount',
  amount: withdrawal?.requestedAmount,
  currency: withdrawal?.requestedCurrency,
  sourceModel: 'SellerWithdrawalRequest',
  sourceDocumentId: withdrawal?._id,
  sourcePath: 'requestedAmount',
});

const withdrawalPayoutSnapshot = (withdrawal, key = 'payout_amount') => snapshotMajorMoney({
  key,
  label: 'Frozen bank payout amount',
  amount: withdrawal?.payoutAmount,
  currency: withdrawal?.payoutCurrency,
  sourceModel: 'SellerWithdrawalRequest',
  sourceDocumentId: withdrawal?._id,
  sourcePath: 'payoutAmount',
});

const stripeEntitlementCapturedSnapshot = (
  payment,
  key = 'entitlement_paid',
  label = 'Stripe entitlement payment',
) => snapshotMinorMoney({
  key,
  label,
  amountMinor: payment?.capturedMinor,
  currency: payment?.currency,
  stripeCurrency: true,
  sourceModel: 'StripeEntitlementPayment',
  sourceDocumentId: payment?._id,
  sourcePath: 'capturedMinor',
});

const subscriptionCapturedSnapshot = (payment, key = 'invoice_paid') => (
  stripeEntitlementCapturedSnapshot(payment, key, 'Subscription invoice payment')
);

const walletTransactionSnapshot = (transaction, key = 'wallet_amount') => snapshotMajorMoney({
  key,
  label: 'Wallet transaction amount',
  amount: transaction?.amount,
  currency: transaction?.currency,
  sourceModel: 'WalletTransaction',
  sourceDocumentId: transaction?._id,
  sourcePath: 'amount',
});

const walletCreditBreakdownSnapshots = (transaction, {
  totalKey = 'wallet_amount',
  availableKey = 'wallet_available_credit',
  liabilityAppliedKey = 'wallet_liability_applied',
  remainingLiabilityKey = 'wallet_remaining_liability',
} = {}) => {
  const total = walletTransactionSnapshot(transaction, totalKey);
  const availableMinor = requireStoredMinorUnits(
    transaction?.metadata?.availableCreditedMinor,
    'Wallet available-credit amount',
  );
  const liabilityAppliedMinor = requireStoredMinorUnits(
    transaction?.metadata?.liabilityAppliedMinor,
    'Wallet liability-applied amount',
  );
  const remainingLiabilityMinor = requireStoredMinorUnits(
    transaction?.metadata?.remainingLiabilityMinor,
    'Wallet remaining-liability amount',
  );
  if (
    !Number.isSafeInteger(availableMinor + liabilityAppliedMinor)
    || availableMinor + liabilityAppliedMinor !== total.amountMinor
  ) {
    throw notificationMoneyError(
      'Wallet credit allocation does not conserve the completed transaction amount.',
      'NOTIFICATION_WALLET_CREDIT_ALLOCATION_INVALID',
    );
  }
  const component = (key, label, amountMinor, sourcePath) => snapshotMinorMoney({
    key,
    label,
    amountMinor,
    currency: total.currency,
    sourceModel: 'WalletTransaction',
    sourceDocumentId: transaction?._id,
    sourcePath,
  });
  return {
    total,
    available: component(
      availableKey,
      'Available Wallet credit',
      availableMinor,
      'metadata.availableCreditedMinor',
    ),
    liabilityApplied: component(
      liabilityAppliedKey,
      'Wallet liability payment',
      liabilityAppliedMinor,
      'metadata.liabilityAppliedMinor',
    ),
    remainingLiability: component(
      remainingLiabilityKey,
      'Remaining Wallet liability',
      remainingLiabilityMinor,
      'metadata.remainingLiabilityMinor',
    ),
  };
};

module.exports = {
  formatMoneySnapshot,
  notificationMoneyError,
  orderSellerTotalSnapshot,
  orderStockRefundSnapshot,
  orderTotalSnapshot,
  requireExactStoredMoney,
  requireStoredCurrency,
  requireStoredMinorUnits,
  requireStripeStoredCurrency,
  returnRefundSnapshot,
  sellerSettlementUsdSnapshot,
  snapshotMajorMoney,
  snapshotMinorMoney,
  stripeEntitlementCapturedSnapshot,
  subscriptionCapturedSnapshot,
  walletCreditBreakdownSnapshots,
  walletTransactionSnapshot,
  withdrawalPayoutSnapshot,
  withdrawalRequestedSnapshot,
};
