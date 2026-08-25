const mongoose = require('mongoose');

const strictActualNumberSetter = value => {
    if (value === null || value === undefined) return value;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

const strictStringSetter = value => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') throw new TypeError('Stripe entitlement identifiers require strings.');
    return value;
};

const isNonNegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const isNullableNonNegativeSafeInteger = value => (
    value === null || value === undefined || isNonNegativeSafeInteger(value)
);

const minorUnitField = ({ required = false, default: defaultValue, nullable = false } = {}) => ({
    type: Number,
    ...(required ? { required: true } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    min: 0,
    set: strictActualNumberSetter,
    validate: {
        validator: nullable ? isNullableNonNegativeSafeInteger : isNonNegativeSafeInteger,
        message: 'Stripe entitlement amount must be a non-negative safe minor-unit integer',
    },
});

const entitlementDisputeTrackSchema = new mongoose.Schema({
    disputeId: { type: String, required: true },
    chargeId: { type: String, default: '' },
    status: { type: String, default: '' },
    state: {
        type: String,
        enum: ['inquiry', 'open', 'won', 'lost'],
        default: 'inquiry',
    },
    amountMinor: minorUnitField({ default: 0 }),
    terminalAt: { type: Date, default: null },
    processedEventIds: { type: [String], default: [] },
    lastEventAt: { type: Date, default: null },
}, { _id: false });

const entitlementChargeTrackSchema = new mongoose.Schema({
    // Invoice Payments are the Basil-era source of truth that maps a payment
    // object to the exact amount it contributed to an invoice. Keep one
    // durable row per association so a refund on one Charge cannot revoke the
    // value supplied by another Charge (or by a PaymentRecord).
    invoicePaymentId: { type: String, required: true },
    paymentType: {
        type: String,
        enum: ['payment_intent', 'charge', 'payment_record', 'legacy'],
        required: true,
    },
    paymentIntentId: { type: String, default: '' },
    paymentRecordId: { type: String, default: '' },
    chargeId: { type: String, default: '' },
    capturedMinor: minorUnitField({ required: true }),
    refundedMinor: minorUnitField({ default: 0 }),
    currency: {
        type: String,
        required: true,
        enum: ['usd'],
        lowercase: true,
        set: strictStringSetter,
    },
    paidAt: { type: Date, default: null },
}, { _id: false });

const entitlementRefundEvidenceSchema = new mongoose.Schema({
    refundId: {
        type: String,
        required: true,
        trim: true,
        match: /^re_[A-Za-z0-9_]+$/,
    },
    // A single provider Refund can fund more than one historical Invoice
    // Payment contribution. Persist the exact slice assigned to this ledger
    // row so seller copy never mistakes the Charge-wide amount for the amount
    // that changed this entitlement.
    amountMinor: minorUnitField({ required: true }),
    createdAt: { type: Date, required: true },
}, { _id: false });

const entitlementRiskEventEvidenceSchema = new mongoose.Schema({
    eventId: { type: String, required: true, trim: true },
    eventType: { type: String, required: true, trim: true },
    occurredAt: { type: Date, required: true },
    chargeId: { type: String, required: true, trim: true },
    paymentIntentId: { type: String, required: true, trim: true },
    fingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    providerRefunds: { type: [entitlementRefundEvidenceSchema], default: [] },
}, { _id: false });

const entitlementRiskNotificationIntentSchema = new mongoose.Schema({
    intentKey: { type: String, required: true, trim: true },
    eventId: { type: String, required: true, trim: true },
    eventType: { type: String, required: true, trim: true },
    kind: {
        type: String,
        enum: ['refund', 'dispute_opened', 'dispute_won', 'dispute_lost'],
        required: true,
    },
    disputeState: {
        type: String,
        enum: { values: ['inquiry', 'open', 'won', 'lost', null], message: 'Risk notification dispute state is invalid' },
        default: null,
    },
    occurredAt: { type: Date, required: true },
    chargeId: { type: String, required: true, trim: true },
    paymentIntentId: { type: String, required: true, trim: true },
    disputeId: { type: String, default: '', trim: true },
    amountMinor: minorUnitField({ required: true }),
    currency: {
        type: String,
        required: true,
        enum: ['usd'],
        lowercase: true,
        set: strictStringSetter,
    },
    providerRefunds: { type: [entitlementRefundEvidenceSchema], default: [] },
    state: { type: String, enum: ['pending', 'outboxed'], default: 'pending', required: true },
    outboxEnqueuedAt: { type: Date, default: null },
}, { _id: false });

const stripeEntitlementPaymentSchema = new mongoose.Schema({
    entitlementType: {
        type: String,
        enum: ['subdomain', 'subscription'],
        required: true,
        index: true,
    },
    sourceKey: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    seller: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    store: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Store',
        default: null,
        index: true,
    },
    // Immutable purchased slug for subdomain contributions. A seller who
    // explicitly abandons one slug must never have its old payment re-grant a
    // replacement slug during a later webhook replay.
    resourceKey: { type: String, default: '', trim: true, lowercase: true, index: true },
    paymentIntentId: { type: String, default: '', index: true },
    chargeIds: { type: [String], default: [] },
    chargeTracks: { type: [entitlementChargeTrackSchema], default: [] },
    invoiceId: { type: String, default: '', index: true },
    stripeSubscriptionId: { type: String, default: '', index: true },
    currency: {
        type: String,
        default: 'usd',
        enum: ['usd'],
        lowercase: true,
        set: strictStringSetter,
    },

    // Stripe amounts are always stored in the currency's minor unit. These
    // values never pass through floating-point currency arithmetic.
    capturedMinor: minorUnitField({ required: true }),
    refundedMinor: minorUnitField({ default: 0 }),
    disputeAmountMinor: minorUnitField({ default: 0 }),

    // The immutable paid interval. Risk decisions derive an effective end from
    // this snapshot; a later win/restoration can therefore never extend access.
    grantStart: { type: Date, required: true, index: true },
    grantEnd: { type: Date, required: true, index: true },
    effectiveGrantEnd: { type: Date, required: true },

    // Subscription invoices can contain prorations. The invoice's Stripe
    // period is retained verbatim so a reversal always shortens the service
    // interval that this exact payment funded, never a later renewal.
    billingReason: { type: String, default: '' },
    priceIds: { type: [String], default: [] },
    unitAmountMinorSnapshots: {
        type: [{
            type: Number,
            min: 0,
            set: strictActualNumberSetter,
            validate: {
                validator: isNonNegativeSafeInteger,
                message: 'Stripe price snapshot must be a non-negative safe minor-unit integer',
            },
        }],
        default: [],
    },
    // Immutable feature snapshot funded by this exact invoice. Subscription
    // plan changes can overlap a still-paid predecessor cycle; refund/dispute
    // reconciliation must therefore be able to remove only the newer tier and
    // fall back to the independently-funded predecessor entitlement.
    fundedPlan: {
        type: String,
        enum: { values: ['starter', 'elite', null], message: 'fundedPlan is invalid' },
        default: null,
    },
    fundedPlanName: { type: String, default: null },
    fundedMetaAdsIncluded: { type: Boolean, default: null },
    fundedStripePriceId: { type: String, default: null },
    fundedStripeProductId: { type: String, default: null },
    fundedSubscriptionItemId: { type: String, default: null },
    fundedUnitAmountMinor: minorUnitField({ default: null, nullable: true }),
    fundedBonusFeaturesActive: { type: Boolean, default: null },
    fundedBonusExpiryDate: { type: Date, default: null },
    fundedBonusFeaturesExpiredPermanently: { type: Boolean, default: null },
    fundedBonusGraceDeadline: { type: Date, default: null },
    planChangeToken: { type: String, default: null },
    predecessorPlan: {
        type: String,
        enum: { values: ['starter', 'elite', null], message: 'predecessorPlan is invalid' },
        default: null,
    },
    predecessorPlanName: { type: String, default: null },
    predecessorMetaAdsIncluded: { type: Boolean, default: null },
    predecessorStripePriceId: { type: String, default: null },
    predecessorStripeProductId: { type: String, default: null },
    predecessorSubscriptionItemId: { type: String, default: null },
    predecessorUnitAmountMinor: minorUnitField({ default: null, nullable: true }),
    predecessorBonusFeaturesActive: { type: Boolean, default: null },
    predecessorBonusExpiryDate: { type: Date, default: null },
    predecessorBonusFeaturesExpiredPermanently: { type: Boolean, default: null },
    predecessorBonusGraceDeadline: { type: Date, default: null },
    stripeEventCreated: minorUnitField({ default: 0 }),

    nonReversibleLegacyBaseline: { type: Boolean, default: false },
    completionState: {
        type: String,
        enum: ['processing', 'confirmed'],
        default: 'confirmed',
    },
    completionEventIds: { type: [String], default: [] },

    // Frozen ownership of the seller-facing payment receipt. The outbox row is
    // inserted before outboxEnqueuedAt is marked, so a crash can only cause an
    // idempotent replay, never a silently lost receipt or a received/recovered
    // wording change on a later webhook.
    paymentNotification: {
        kind: {
            type: String,
            enum: { values: ['received', 'recovered', null], message: 'paymentNotification.kind is invalid' },
            default: null,
        },
        occurredAt: { type: Date, default: null },
        outboxEnqueuedAt: { type: Date, default: null },
    },

    // A paid invoice that actually transitions a payment-restricted seller
    // back to active owns its recovery notification here. This ledger row is
    // immutable by invoice identity, so `invoice.paid` /
    // `invoice.payment_succeeded` retries can resume individual channels even
    // after the subscription has already been restored locally.
    recoveryNotification: {
        failureInvoiceId: { type: String, default: null },
        eventId: { type: String, default: null },
        planName: { type: String, default: null },
        state: {
            type: String,
            enum: {
                values: ['pending', 'processing', 'partial', 'sent', 'superseded', 'outboxed', null],
                message: 'recoveryNotification.state is invalid',
            },
            default: null,
        },
        token: { type: String, default: null },
        startedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
        lastError: { type: String, default: '' },
        emailState: {
            type: String,
            enum: { values: ['pending', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
        whatsAppState: {
            type: String,
            enum: { values: ['pending', 'sent', 'skipped', 'failed', null] },
            default: null,
        },
        inAppState: {
            type: String,
            enum: { values: ['pending', 'sent', 'failed', null] },
            default: null,
        },
    },

    disputeId: { type: String, default: '' },
    disputeStatus: { type: String, default: '' },
    disputeState: {
        type: String,
        enum: ['none', 'inquiry', 'open', 'won', 'lost'],
        default: 'none',
        index: true,
    },
    disputeEventCreatedAt: { type: Date, default: null },
    disputeTerminalAt: { type: Date, default: null },
    disputes: { type: [entitlementDisputeTrackSchema], default: [] },
    riskSuspended: { type: Boolean, default: false, index: true },
    processedRiskEventIds: { type: [String], default: [] },
    // The evidence fingerprint fences a Stripe event id against a replay with
    // different provider facts. Notification intents are appended in the
    // same optimistic write as the money transition; an outbox outage can
    // therefore delay delivery but can never silently lose the outcome.
    riskEventEvidence: { type: [entitlementRiskEventEvidenceSchema], default: [] },
    riskNotificationIntents: { type: [entitlementRiskNotificationIntentSchema], default: [] },
    lastRiskEventAt: { type: Date, default: null },
}, {
    timestamps: true,
    optimisticConcurrency: true,
});

stripeEntitlementPaymentSchema.index({ store: 1, entitlementType: 1, resourceKey: 1, grantStart: 1 });
stripeEntitlementPaymentSchema.index({ seller: 1, stripeSubscriptionId: 1, grantStart: 1 });
stripeEntitlementPaymentSchema.index({ chargeIds: 1 });
stripeEntitlementPaymentSchema.index({ 'chargeTracks.paymentIntentId': 1 });
stripeEntitlementPaymentSchema.index({ 'chargeTracks.chargeId': 1 });

stripeEntitlementPaymentSchema.pre('validate', function validateMinorUnitConservation() {
    if (this.refundedMinor > this.capturedMinor) {
        this.invalidate('refundedMinor', 'Refunded entitlement money cannot exceed captured money');
    }
    if (this.disputeAmountMinor > this.capturedMinor) {
        this.invalidate('disputeAmountMinor', 'Disputed entitlement money cannot exceed captured money');
    }
    for (let index = 0; index < (this.chargeTracks || []).length; index += 1) {
        const track = this.chargeTracks[index];
        if (track.refundedMinor > track.capturedMinor) {
            this.invalidate(
                `chargeTracks.${index}.refundedMinor`,
                'Refunded Invoice Payment money cannot exceed its captured contribution',
            );
        }
    }

    const eventIds = (this.riskEventEvidence || []).map(entry => entry.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
        this.invalidate('riskEventEvidence', 'Stripe entitlement risk event ids must be unique');
    }
    for (let index = 0; index < (this.riskEventEvidence || []).length; index += 1) {
        const refundIds = (this.riskEventEvidence[index].providerRefunds || [])
            .map(refund => refund.refundId);
        if (new Set(refundIds).size !== refundIds.length) {
            this.invalidate(
                `riskEventEvidence.${index}.providerRefunds`,
                'Provider refund ids must be unique inside Stripe entitlement event evidence',
            );
        }
    }
    const processedEventIds = [...(this.processedRiskEventIds || [])];
    if (new Set(processedEventIds).size !== processedEventIds.length) {
        this.invalidate('processedRiskEventIds', 'Processed Stripe entitlement event ids must be unique');
    }
    const intentKeys = (this.riskNotificationIntents || []).map(intent => intent.intentKey);
    if (new Set(intentKeys).size !== intentKeys.length) {
        this.invalidate('riskNotificationIntents', 'Stripe entitlement notification intent keys must be unique');
    }
    for (let index = 0; index < (this.riskNotificationIntents || []).length; index += 1) {
        const intent = this.riskNotificationIntents[index];
        const refundTotal = (intent.providerRefunds || []).reduce(
            (sum, refund) => sum + refund.amountMinor,
            0,
        );
        if (intent.amountMinor <= 0) {
            this.invalidate(
                `riskNotificationIntents.${index}.amountMinor`,
                'Stripe entitlement outcome notifications require a positive amount',
            );
        }
        if (intent.kind === 'refund') {
            if (intent.disputeId || intent.disputeState) {
                this.invalidate(
                    `riskNotificationIntents.${index}.disputeId`,
                    'Stripe refund notifications cannot contain a dispute outcome',
                );
            }
            if (!(intent.providerRefunds || []).length || refundTotal !== intent.amountMinor) {
                this.invalidate(
                    `riskNotificationIntents.${index}.providerRefunds`,
                    'Stripe refund evidence must exactly equal the entitlement refund delta',
                );
            }
        } else {
            if (!/^dp_[A-Za-z0-9_]+$/.test(intent.disputeId || '')) {
                this.invalidate(
                    `riskNotificationIntents.${index}.disputeId`,
                    'Stripe dispute notifications require the provider dispute id',
                );
            }
            if ((intent.providerRefunds || []).length) {
                this.invalidate(
                    `riskNotificationIntents.${index}.providerRefunds`,
                    'Stripe dispute notifications cannot contain refund evidence',
                );
            }
            const expectedState = {
                dispute_won: 'won',
                dispute_lost: 'lost',
            }[intent.kind];
            if (expectedState && intent.disputeState !== expectedState) {
                this.invalidate(
                    `riskNotificationIntents.${index}.disputeState`,
                    'Stripe dispute notification kind and state do not match',
                );
            }
            if (intent.kind === 'dispute_opened' && !['inquiry', 'open'].includes(intent.disputeState)) {
                this.invalidate(
                    `riskNotificationIntents.${index}.disputeState`,
                    'Opened Stripe dispute notifications require inquiry or open state',
                );
            }
        }
        if (
            (intent.state === 'outboxed') !== Boolean(intent.outboxEnqueuedAt)
        ) {
            this.invalidate(
                `riskNotificationIntents.${index}.state`,
                'Stripe entitlement notification outbox state is inconsistent',
            );
        }
    }
});

module.exports = mongoose.model('StripeEntitlementPayment', stripeEntitlementPaymentSchema);
