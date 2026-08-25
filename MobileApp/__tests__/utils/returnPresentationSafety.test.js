import { readFileSync } from 'fs';
import { inspectReturnPresentationSnapshot } from '../../src/utils/returnPresentationSafety';

const RETURN_ID = '64b000000000000000000001';
const ITEM_A_ID = '64b000000000000000000002';
const ITEM_B_ID = '64b000000000000000000003';

const makeReturn = (overrides = {}) => ({
  _id: RETURN_ID,
  status: 'under_review',
  currency: 'PKR',
  policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
  items: [
    { orderItemId: ITEM_A_ID, quantity: 2, purchasedQuantity: 3, unitPrice: 100.005, lineSubtotal: 200 },
    { orderItemId: ITEM_B_ID, quantity: 1, purchasedQuantity: 1, unitPrice: 50, lineSubtotal: 50 },
  ],
  refund: { itemSubtotal: 250, taxAmount: 17.5, shippingAmount: 20, discountAmount: 7.5, totalAmount: 280 },
  ...overrides,
});

const cloneReturn = () => JSON.parse(JSON.stringify(makeReturn()));

describe('seller return presentation safety', () => {
  test('accepts exact reconciled snapshots for every supported currency', () => {
    ['USD', 'PKR', 'EUR', 'GBP'].forEach((currency) => {
      const result = inspectReturnPresentationSnapshot(makeReturn({ currency }));
      expect(result.valid).toBe(true);
      expect(result.currency).toBe(currency);
      expect(result.itemCount).toBe(3);
      expect(result.refund.totalAmount).toBe(280);
    });
  });

  test('rejects missing, string, non-finite, sub-cent, and unsafe fetched money', () => {
    [undefined, null, '', '200', true, Number.NaN, Number.POSITIVE_INFINITY, 200.001, Number.MAX_SAFE_INTEGER].forEach((value) => {
      const lineSnapshot = cloneReturn();
      lineSnapshot.items[0].lineSubtotal = value;
      expect(inspectReturnPresentationSnapshot(lineSnapshot).valid).toBe(false);

      const refundSnapshot = cloneReturn();
      refundSnapshot.refund.itemSubtotal = value;
      expect(inspectReturnPresentationSnapshot(refundSnapshot).valid).toBe(false);
    });

    [undefined, null, '', '100.005', true, Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1].forEach((value) => {
      const snapshot = cloneReturn();
      snapshot.items[0].unitPrice = value;
      expect(inspectReturnPresentationSnapshot(snapshot).valid).toBe(false);
    });
  });

  test('rejects fractional, coerced, oversized, or over-returned quantities and bad identities', () => {
    [undefined, null, '', '2', true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].forEach((value) => {
      const snapshot = cloneReturn();
      snapshot.items[0].quantity = value;
      expect(inspectReturnPresentationSnapshot(snapshot).valid).toBe(false);

      const purchasedSnapshot = cloneReturn();
      purchasedSnapshot.items[0].purchasedQuantity = value;
      expect(inspectReturnPresentationSnapshot(purchasedSnapshot).valid).toBe(false);
    });

    const overReturned = cloneReturn();
    overReturned.items[0].quantity = 4;
    expect(inspectReturnPresentationSnapshot(overReturned).valid).toBe(false);

    const duplicate = cloneReturn();
    duplicate.items[1].orderItemId = ITEM_A_ID.toUpperCase();
    expect(inspectReturnPresentationSnapshot(duplicate).valid).toBe(false);

    const invalidIdentity = cloneReturn();
    invalidIdentity._id = 'return-1';
    expect(inspectReturnPresentationSnapshot(invalidIdentity).valid).toBe(false);

    const unsafeCount = cloneReturn();
    unsafeCount.items[0].quantity = Number.MAX_SAFE_INTEGER;
    unsafeCount.items[0].purchasedQuantity = Number.MAX_SAFE_INTEGER;
    unsafeCount.items[1].quantity = 1;
    expect(inspectReturnPresentationSnapshot(unsafeCount).valid).toBe(false);
  });

  test('requires canonical currencies and reconciles line, component, and discount totals exactly', () => {
    [undefined, null, '', 'usd', ' USD ', 'CAD'].forEach((currency) => {
      expect(inspectReturnPresentationSnapshot(makeReturn({ currency })).valid).toBe(false);
    });

    expect(inspectReturnPresentationSnapshot(makeReturn({
      policySnapshot: { returnsEnabled: false, returnDuration: 14, refundType: 'full_refund' },
    })).valid).toBe(false);
    expect(inspectReturnPresentationSnapshot(makeReturn({
      policySnapshot: { returnsEnabled: true, returnDuration: 366, refundType: 'full_refund' },
    })).valid).toBe(false);
    expect(inspectReturnPresentationSnapshot(makeReturn({
      status: 'accepted_pending_payment',
      policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'replacement_only' },
    })).errors.join(',')).toMatch(/statusResolution/);
    expect(inspectReturnPresentationSnapshot(makeReturn({ status: 'replacement_approved' })).errors.join(',')).toMatch(/statusResolution/);

    const zeroRefund = cloneReturn();
    zeroRefund.items.forEach(item => { item.lineSubtotal = 0; });
    zeroRefund.refund = { itemSubtotal: 0, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 0 };
    expect(inspectReturnPresentationSnapshot(zeroRefund).errors.join(',')).toMatch(/totalAmountPositive/);
    zeroRefund.policySnapshot.refundType = 'replacement_only';
    expect(inspectReturnPresentationSnapshot(zeroRefund).valid).toBe(true);

    const lineMismatch = cloneReturn();
    lineMismatch.refund.itemSubtotal = 249.99;
    lineMismatch.refund.totalAmount = 279.99;
    expect(inspectReturnPresentationSnapshot(lineMismatch).errors.join(',')).toMatch(/itemSubtotalReconciliation/);

    const totalMismatch = cloneReturn();
    totalMismatch.refund.totalAmount = 279.99;
    expect(inspectReturnPresentationSnapshot(totalMismatch).errors.join(',')).toMatch(/totalAmountReconciliation/);

    const excessiveDiscount = cloneReturn();
    excessiveDiscount.refund.discountAmount = 300;
    excessiveDiscount.refund.totalAmount = 0;
    expect(inspectReturnPresentationSnapshot(excessiveDiscount).errors.join(',')).toMatch(/discountAmountReconciliation/);
  });

  test('mobile return actions and formatters are gated by the strict snapshot', () => {
    const source = readFileSync(require.resolve('../../src/components/SellerReturnsPanel.js'), 'utf8');
    expect(source).toMatch(/inspectReturnPresentationSnapshot/);
    expect(source).toMatch(/Financial snapshot unavailable/);
    expect(source).toMatch(/const transitions = snapshot\.valid/);
    expect(source).not.toMatch(/Number\(.*(?:refund|lineSubtotal|quantity)/);
    expect(source).not.toMatch(/(?:refund|lineSubtotal|quantity)[^\n]*(?:\|\||\?\?)\s*0/);
  });
});
