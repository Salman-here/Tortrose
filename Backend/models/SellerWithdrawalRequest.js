const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

const strictMoneySetter = value => {
    if (value === null || value === undefined) return value;
    const parsed = parseStrictFiniteNumber(value);
    return parsed === null ? Number.NaN : parsed;
};

const isExactNonNegativeMoney = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    try {
        return roundMoney(value) === value;
    } catch (_) {
        return false;
    }
};

const WITHDRAWAL_STATUSES = [
    'pending',
    'approved',
    'processing',
    'manual_review',
    'paid',
    'failed',
    'rejected',
    'cancelled',
];

const payoutEvidenceSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['provider_reference', 'receipt', 'bank_statement', 'manual_confirmation'],
            required: true,
        },
        reference: { type: String, trim: true, maxlength: 200, required: true },
        url: { type: String, trim: true, maxlength: 1000, default: undefined },
        note: { type: String, trim: true, maxlength: 1000, default: '' },
        recordedAt: { type: Date, required: true },
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { _id: false }
);

const payoutAttemptSchema = new mongoose.Schema(
    {
        attemptId: { type: String, trim: true, maxlength: 200, required: true },
        sequence: { type: Number, min: 1, required: true },
        provider: { type: String, trim: true, maxlength: 120, required: true },
        status: {
            type: String,
            enum: ['processing', 'manual_review', 'paid', 'failed'],
            required: true,
        },
        initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        startedAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
        resolvedAt: { type: Date, default: undefined },
        transferReference: { type: String, trim: true, maxlength: 200, default: undefined },
        transferredAt: { type: Date, default: undefined },
        evidence: { type: payoutEvidenceSchema, default: undefined },
        failureCertainty: {
            type: String,
            enum: ['definitively_not_sent'],
            default: undefined,
        },
        failureCode: { type: String, trim: true, maxlength: 120, default: '' },
        failureReason: { type: String, trim: true, maxlength: 1000, default: '' },
        reconciliationNote: { type: String, trim: true, maxlength: 1000, default: '' },
        legacyImported: { type: Boolean, default: false },
    },
    { _id: false }
);

const payoutAdminOperationSchema = new mongoose.Schema(
    {
        operationKey: { type: String, trim: true, maxlength: 200, required: true },
        payloadFingerprint: {
            type: String,
            match: /^[a-f0-9]{64}$/,
            maxlength: 64,
            required: true,
        },
        fromStatus: { type: String, enum: WITHDRAWAL_STATUSES, required: true },
        toStatus: { type: String, enum: WITHDRAWAL_STATUSES, required: true },
        attemptId: { type: String, trim: true, maxlength: 200, default: undefined },
        appliedAt: { type: Date, required: true },
        appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { _id: false }
);

const paymentAccountSnapshotSchema = new mongoose.Schema(
    {
        accountHolderName: { type: String, default: '', immutable: true },
        bankName: { type: String, default: '', immutable: true },
        accountNumberLast4: { type: String, default: '', immutable: true },
        ibanLast4: { type: String, default: '', immutable: true },
        swiftCode: { type: String, default: '', immutable: true },
        country: { type: String, default: '', immutable: true },
        countryCode: { type: String, default: '', immutable: true },
        currency: { type: String, default: 'USD', immutable: true },
    },
    { _id: false }
);

const exchangeRateSnapshotSchema = new mongoose.Schema(
    {
        base: { type: String, enum: ['USD'], default: 'USD', immutable: true },
        rates: {
            _id: false,
            USD: { type: Number, default: 1, immutable: true },
            PKR: { type: Number, default: null, immutable: true },
            EUR: { type: Number, default: null, immutable: true },
            GBP: { type: Number, default: null, immutable: true },
        },
        capturedAt: { type: Date, default: null, immutable: true },
        source: { type: String, default: '', maxlength: 80, immutable: true },
        fallback: { type: Boolean, default: false, immutable: true },
    },
    { _id: false }
);

const sellerWithdrawalRequestSchema = new mongoose.Schema(
    {
        seller: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
            immutable: true,
        },
        idempotencyKey: {
            type: String,
            trim: true,
            maxlength: 200,
            default: undefined,
            immutable: true,
        },
        amount: {
            type: Number,
            required: true,
            min: 5,
            immutable: true,
            set: strictMoneySetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Withdrawal USD amount must be finite, safe, and exact to cents',
            },
        },
        currency: {
            type: String,
            // Balance reservation is canonical USD. Seller-selected and bank
            // payout currencies are frozen separately below.
            enum: ['USD'],
            default: 'USD',
            immutable: true,
        },
        requestedAmount: {
            type: Number,
            required: true,
            default: 0,
            immutable: true,
            set: strictMoneySetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Requested withdrawal amount must be finite, safe, and exact to cents',
            },
        },
        requestedCurrency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            default: 'USD',
            immutable: true,
        },
        // Canonical balance reservation remains in amount/USD. These fields
        // freeze what an admin must actually transfer to the saved bank
        // account, even when the seller viewed/requested another currency.
        payoutAmount: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
            immutable: true,
            set: strictMoneySetter,
            validate: {
                validator: isExactNonNegativeMoney,
                message: 'Payout amount must be finite, safe, and exact to cents',
            },
        },
        payoutCurrency: {
            type: String,
            enum: ['USD', 'PKR', 'EUR', 'GBP'],
            default: 'USD',
            immutable: true,
        },
        exchangeRateSnapshot: {
            type: exchangeRateSnapshotSchema,
            default: () => ({}),
            immutable: true,
        },
        status: {
            type: String,
            enum: WITHDRAWAL_STATUSES,
            default: 'pending',
            index: true,
        },
        // Version 0 covers rows created before payout attempts were auditable.
        // A version-0 processing row is an unknown bank outcome and must be
        // quarantined into manual review before it can be resolved.
        payoutWorkflowVersion: {
            type: Number,
            enum: [0, 1],
            default: 0,
            required: true,
        },
        payoutAttempts: {
            type: [payoutAttemptSchema],
            default: [],
            validate: {
                validator: attempts => attempts.length <= 50,
                message: 'A withdrawal cannot contain more than 50 payout attempts',
            },
        },
        activePayoutAttemptId: {
            type: String,
            trim: true,
            maxlength: 200,
            default: undefined,
        },
        paidPayoutAttemptId: {
            type: String,
            trim: true,
            maxlength: 200,
            default: undefined,
        },
        paidPayoutProvider: {
            type: String,
            trim: true,
            maxlength: 120,
            default: undefined,
        },
        paidPayoutProviderKey: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 120,
            default: undefined,
        },
        paidTransferReference: {
            type: String,
            trim: true,
            maxlength: 200,
            default: undefined,
        },
        paidTransferReferenceKey: {
            type: String,
            trim: true,
            uppercase: true,
            maxlength: 200,
            default: undefined,
        },
        // Hidden from every API payload. It makes status mutations durable and
        // idempotent without exposing retry keys or fingerprints to clients.
        adminOperations: {
            type: [payoutAdminOperationSchema],
            default: [],
            select: false,
            validate: {
                validator: operations => operations.length <= 200,
                message: 'A withdrawal cannot contain more than 200 admin operations',
            },
        },
        paymentAccountSnapshot: {
            type: paymentAccountSnapshotSchema,
            default: () => ({}),
            immutable: true,
        },
        // Version 1 snapshots carry a complete AES-256-GCM sealed payout
        // destination. The envelope is excluded by default and is never sent
        // to seller/public clients. Version 0 is a legacy request and must not
        // fall back to the seller's mutable current payment account.
        paymentAccountSnapshotVersion: {
            type: Number,
            enum: [0, 1],
            default: 0,
            required: true,
            immutable: true,
        },
        paymentAccountSnapshotEnvelope: {
            type: String,
            select: false,
            immutable: true,
            maxlength: 4096,
            required() {
                return this.paymentAccountSnapshotVersion === 1;
            },
            default: undefined,
        },
        sellerNote: { type: String, trim: true, maxlength: 500, default: '' },
        adminNote: { type: String, trim: true, maxlength: 1000, default: '' },
        processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        processedAt: { type: Date },
    },
    { timestamps: true, optimisticConcurrency: true }
);

sellerWithdrawalRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });
sellerWithdrawalRequestSchema.index({ status: 1, createdAt: -1 });
sellerWithdrawalRequestSchema.index(
    { seller: 1, idempotencyKey: 1 },
    {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    }
);
sellerWithdrawalRequestSchema.index(
    { paidPayoutProviderKey: 1, paidTransferReferenceKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            paidPayoutProviderKey: { $type: 'string' },
            paidTransferReferenceKey: { $type: 'string' },
        },
    }
);

sellerWithdrawalRequestSchema.pre('validate', function validateVersionedMoneySnapshots() {
    if (
        this.paymentAccountSnapshotVersion === 1
        && (!(this.requestedAmount > 0) || !(this.payoutAmount > 0))
    ) {
        this.invalidate(
            'paymentAccountSnapshotVersion',
            'Version 1 withdrawals require positive requested and payout amounts',
        );
    }

    if (this.payoutWorkflowVersion !== 1) return;

    const attempts = Array.isArray(this.payoutAttempts) ? this.payoutAttempts : [];
    const operations = Array.isArray(this.adminOperations) ? this.adminOperations : [];
    const attemptIds = attempts.map(attempt => attempt.attemptId);
    const operationKeys = operations.map(operation => operation.operationKey);
    if (new Set(attemptIds).size !== attemptIds.length) {
        this.invalidate('payoutAttempts', 'Payout attempt IDs must be unique');
    }
    if (new Set(operationKeys).size !== operationKeys.length) {
        this.invalidate('adminOperations', 'Admin payout operation keys must be unique');
    }
    attempts.forEach((attempt, index) => {
        if (attempt.sequence !== index + 1) {
            this.invalidate('payoutAttempts', 'Payout attempt sequence must be contiguous');
        }
        if (attempt.status === 'processing' && (
            attempt.resolvedAt
            || attempt.transferReference
            || attempt.transferredAt
            || attempt.evidence
            || attempt.failureCertainty
        )) {
            this.invalidate('payoutAttempts', 'Processing attempts cannot contain resolution proof');
        }
        if (attempt.status === 'manual_review' && !attempt.reconciliationNote) {
            this.invalidate('payoutAttempts', 'Manual-review attempts require a reconciliation note');
        }
        if (attempt.status === 'paid' && (
            !attempt.resolvedAt
            || !attempt.transferReference
            || !attempt.transferredAt
            || !attempt.evidence
        )) {
            this.invalidate('payoutAttempts', 'Paid attempts require complete transfer proof');
        }
        if (attempt.status === 'failed' && (
            !attempt.resolvedAt
            || attempt.failureCertainty !== 'definitively_not_sent'
            || !attempt.failureReason
        )) {
            this.invalidate('payoutAttempts', 'Failed attempts require definitive no-transfer evidence');
        }
    });
    if (attempts.filter(attempt => attempt.status === 'paid').length > 1) {
        this.invalidate('payoutAttempts', 'Only one payout attempt may complete as paid');
    }

    const unresolvedAttempts = attempts.filter(attempt => (
        attempt.status === 'processing' || attempt.status === 'manual_review'
    ));
    const activeAttempt = attempts.find(attempt => attempt.attemptId === this.activePayoutAttemptId);
    if (['processing', 'manual_review'].includes(this.status)) {
        if (
            unresolvedAttempts.length !== 1
            || !activeAttempt
            || activeAttempt.status !== this.status
        ) {
            this.invalidate(
                'activePayoutAttemptId',
                'Processing and manual-review withdrawals require exactly one matching active attempt',
            );
        }
    } else if (unresolvedAttempts.length > 0 || this.activePayoutAttemptId) {
        this.invalidate(
            'activePayoutAttemptId',
            'Only processing or manual-review withdrawals may retain an active payout attempt',
        );
    }

    if (this.status === 'paid') {
        const paidAttempt = attempts.find(attempt => attempt.attemptId === this.paidPayoutAttemptId);
        if (
            !paidAttempt
            || paidAttempt.status !== 'paid'
            || !paidAttempt.transferReference
            || !paidAttempt.transferredAt
            || !paidAttempt.evidence
            || this.paidPayoutProvider !== paidAttempt.provider
            || this.paidTransferReference !== paidAttempt.transferReference
            || this.paidPayoutProviderKey !== paidAttempt.provider.trim().toLowerCase()
            || this.paidTransferReferenceKey !== paidAttempt.transferReference.trim().toUpperCase()
        ) {
            this.invalidate('paidPayoutAttemptId', 'Paid withdrawals require matching transfer proof');
        }
    } else if (
        this.paidPayoutAttemptId
        || this.paidPayoutProvider
        || this.paidPayoutProviderKey
        || this.paidTransferReference
        || this.paidTransferReferenceKey
    ) {
        this.invalidate('paidPayoutAttemptId', 'Only paid withdrawals may carry paid transfer proof');
    } else if (attempts.some(attempt => attempt.status === 'paid')) {
        this.invalidate('payoutAttempts', 'A non-paid withdrawal cannot contain a paid attempt');
    }

    if (this.status === 'failed') {
        const failedAttempts = attempts.filter(attempt => attempt.status === 'failed');
        const latestAttempt = attempts[attempts.length - 1];
        if (
            !failedAttempts.length
            || latestAttempt?.status !== 'failed'
            || latestAttempt.failureCertainty !== 'definitively_not_sent'
            || !latestAttempt.failureReason
        ) {
            this.invalidate(
                'payoutAttempts',
                'Failed withdrawals require definitive no-transfer evidence',
            );
        }
    }
});

module.exports = mongoose.model('SellerWithdrawalRequest', sellerWithdrawalRequestSchema);
