const { getSellerWithdrawals } = require('../../controllers/PaymentController');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');

const importedLegacy = () => ({
    _id: 'legacy-withdrawal', seller: 'seller-1', amount: 5, currency: 'USD',
    balanceVersion: 0, requestedAmount: 0, requestedCurrency: 'USD',
    payoutAmount: 0, payoutCurrency: 'USD', status: 'manual_review',
    payoutWorkflowVersion: 1, paymentAccountSnapshotVersion: 0,
    activePayoutAttemptId: 'imported-attempt',
    payoutAttempts: [{ attemptId: 'imported-attempt', status: 'manual_review', legacyImported: true }],
});

const readWithdrawals = async (rows, role = 'seller') => {
    const query = {
        sort: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(rows),
    };
    jest.spyOn(SellerWithdrawalRequest, 'find').mockReturnValue(query);
    const response = { statusCode: 200 };
    const res = {
        status: jest.fn(code => { response.statusCode = code; return res; }),
        json: jest.fn(body => { response.body = body; return res; }),
    };
    await getSellerWithdrawals({ user: { id: 'seller-1', role }, query: {} }, res);
    expect(response.statusCode).toBe(200);
    return response.body.withdrawals;
};

afterEach(() => jest.restoreAllMocks());

test('derives imported legacy presentation metadata from the recorded attempt without inventing payout terms', async () => {
    const stored = importedLegacy();
    const original = JSON.parse(JSON.stringify(stored));
    const [seller] = await readWithdrawals([stored]);
    expect(seller.payoutWorkflow.legacyImported).toBe(true);
    expect(seller).not.toHaveProperty('payoutAttempts');
    expect(seller).toMatchObject({ requestedAmount: 0, payoutAmount: 0 });
    expect(seller.paymentAccountSnapshot).toMatchObject({ snapshotStatus: 'missing', payoutBlocked: true });
    expect(stored).toEqual(original);

    const [admin] = await readWithdrawals([stored], 'admin');
    expect(admin.payoutWorkflow.legacyImported).toBe(true);
    expect(admin.payoutAttempts).toEqual(original.payoutAttempts);
    expect(admin.payoutAmount).toBe(0);
});

test.each([
    ['response metadata without an imported attempt', { payoutAttempts: [] }],
    ['native balance version', { balanceVersion: 2 }],
    ['original frozen destination', { paymentAccountSnapshotVersion: 1 }],
    ['original workflow version', { payoutWorkflowVersion: 0 }],
])('cannot label %s as an imported legacy payout', async (_label, overrides) => {
    const row = {
        ...importedLegacy(),
        payoutWorkflow: { version: 1, legacyImported: true },
        ...overrides,
    };
    const [result] = await readWithdrawals([row]);
    expect(result.payoutWorkflow.legacyImported).toBe(false);
});

test.each(['approved', 'processing'])('preserves complete native %s withdrawal terms', async status => {
    const row = {
        ...importedLegacy(), balanceVersion: 2, minimumAmount: 5,
        requestedAmount: 5, payoutAmount: 5, status,
        paymentAccountSnapshotVersion: 1, paymentAccountSnapshot: { currency: 'USD' },
        payoutAttempts: status === 'processing'
            ? [{ attemptId: 'native-attempt', status: 'processing', legacyImported: false }]
            : [],
    };
    const [result] = await readWithdrawals([row]);
    expect(result.payoutWorkflow.legacyImported).toBe(false);
    expect(result).toMatchObject({ balanceVersion: 2, amount: 5, requestedAmount: 5, payoutAmount: 5, status });
});
