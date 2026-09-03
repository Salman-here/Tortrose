const mongoose = require('mongoose');
const { slugifyStoreName, validateStoreSlug } = require('../utils/storeSlug');

const storeThemeCustomSchema = new mongoose.Schema({
  name: {
    type: String,
    default: 'Custom Store Theme',
    maxlength: 40
  },
  layout: {
    type: String,
    enum: ['classic', 'centered', 'editorial', 'showcase', 'compact'],
    default: 'classic'
  },
  colors: {
    primary: { type: String, default: '#3b82f6' },
    secondary: { type: String, default: '#8b5cf6' },
    accent: { type: String, default: '#10b981' },
    background: { type: String, default: '#eef4ff' },
    surface: { type: String, default: '#ffffff' },
    text: { type: String, default: '#111827' }
  }
}, { _id: false });

const storeThemeSchema = new mongoose.Schema({
  themeId: {
    type: String,
    enum: [
      'rozare-professional-store',
      'pearl-boutique',
      'sage-studio',
      'skyline-market',
      'lilac-gallery',
      'sunlit-minimal',
      'coral-showroom',
      'aqua-retail',
      'orchid-luxe',
      'mint-catalog',
      'custom'
    ],
    default: 'rozare-professional-store'
  },
  customTheme: {
    type: storeThemeCustomSchema,
    default: null
  },
  updatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const storeVisibilitySchema = new mongoose.Schema({
  mode: {
    type: String,
    enum: ['global', 'country', 'region', 'city', 'town', 'radius'],
    default: 'country',
    index: true
  },
  country: { type: String, default: '' },
  countryCode: { type: String, default: '' },
  countryKey: { type: String, default: '', index: true },
  region: { type: String, default: '' },
  regionCode: { type: String, default: '' },
  regionKey: { type: String, default: '', index: true },
  city: { type: String, default: '' },
  cityStateCode: { type: String, default: '' },
  cityKey: { type: String, default: '', index: true },
  town: { type: String, default: '' },
  townStateCode: { type: String, default: '' },
  townKey: { type: String, default: '', index: true },
  radiusKm: { type: Number, default: null, min: 0.1, max: 500 },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: undefined
    },
    coordinates: {
      type: [Number],
      default: undefined
    }
  },
  label: { type: String, default: '' },
  updatedAt: { type: Date, default: null }
}, { _id: false });

const storeSchema = new mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  storeName: {
    type: String,
    required: true,
    trim: true,
    minlength: [3, 'Store name must be at least 3 characters'],
    maxlength: [50, 'Store name cannot exceed 50 characters']
  },
  storeSlug: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    validate: {
      validator(value) {
        // Existing legacy rows with a newly-reserved slug must remain editable
        // until an administrator migrates them. Every creation or actual slug
        // mutation is still rejected at the model boundary.
        if (typeof this?.isModified === 'function' && !this.isNew && !this.isModified('storeSlug')) {
          return true;
        }
        return validateStoreSlug(value).valid;
      },
      message: props => validateStoreSlug(props.value).msg || 'Invalid store subdomain',
    },
  },
  sellerType: {
    type: String,
    enum: ['store', 'brand'],
    default: 'store',
    index: true
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters'],
    default: ''
  },
  productCurrency: {
    type: String,
    enum: ['USD', 'PKR', 'EUR', 'GBP'],
    default: null,
    index: true
  },
  productCurrencyStatus: {
    type: String,
    enum: ['active', 'pending_conversion'],
    default: 'active',
    index: true
  },
  previousProductCurrency: {
    type: String,
    enum: ['USD', 'PKR', 'EUR', 'GBP'],
    default: null
  },
  pendingProductCurrency: {
    type: String,
    enum: ['USD', 'PKR', 'EUR', 'GBP'],
    default: null
  },
  productCurrencyChangedAt: {
    type: Date,
    default: null
  },
  storeTheme: {
    type: storeThemeSchema,
    default: () => ({
      themeId: 'rozare-professional-store',
      customTheme: null,
      updatedAt: null
    })
  },
  visibility: {
    type: storeVisibilitySchema,
    default: undefined
  },
  paymentPolicy: {
    type: String,
    enum: ['online_and_cod', 'advance_only'],
    default: 'online_and_cod',
    index: true
  },
  paymentPolicyUpdatedAt: {
    type: Date,
    default: null
  },
  address: {
    street: {
      type: String,
      default: ''
    },
    city: {
      type: String,
      default: ''
    },
    state: {
      type: String,
      default: ''
    },
    stateCode: {
      type: String,
      default: ''
    },
    country: {
      type: String,
      default: ''
    },
    countryCode: {
      type: String,
      default: ''
    },
    postalCode: {
      type: String,
      default: ''
    }
  },
  logo: {
    type: String, // Cloudinary URL
    default: ''
  },
  banner: {
    type: String, // Cloudinary URL
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  },
  views: {
    type: Number,
    default: 0
  },
  trustCount: {
    type: Number,
    default: 0,
    min: [0, 'Trust count cannot be negative']
  },
  socialLinks: {
    website: {
      type: String,
      default: ''
    },
    facebook: {
      type: String,
      default: ''
    },
    instagram: {
      type: String,
      default: ''
    },
    twitter: {
      type: String,
      default: ''
    },
    youtube: {
      type: String,
      default: ''
    },
    tiktok: {
      type: String,
      default: ''
    }
  },
  returnPolicy: {
    returnsEnabled: {
      type: Boolean,
      default: false
    },
    returnDuration: {
      type: Number,
      default: 0 // days
    },
    refundType: {
      type: String,
      enum: ['none', 'full_refund', 'replacement_only', 'store_credit'],
      default: 'none'
    },
    warrantyEnabled: {
      type: Boolean,
      default: false
    },
    warrantyDuration: {
      type: Number,
      default: 0 // months
    },
    warrantyDescription: {
      type: String,
      default: ''
    },
    policyDescription: {
      type: String,
      default: ''
    }
  },
  // Change-cooldown tracking
  lastSlugChangeAt: { type: Date, default: null },
  lastNameChangeAt: { type: Date, default: null },
  lastTypeChangeAt: { type: Date, default: null },
  // Mirrored from subscription so middleware/UI knows the store is currently blocked
  blockedAt: { type: Date, default: null },
  // Ownership marker for a reversible subscription-payment suspension. The
  // exact timestamp prevents a won dispute from undoing a later independent
  // admin/manual store deactivation.
  subscriptionPaymentRiskLock: {
    stripeSubscriptionId: { type: String, default: '' },
    lockedAt: { type: Date, default: null }
  },
  // Serializes a payable subdomain Checkout against a slug change. Checkout
  // locks outlive the hosted Session and are released by completion/expiry;
  // short slug-change locks make the inverse race safe as well.
  subdomainResourceLock: {
    kind: {
      type: String,
      enum: { values: ['checkout', 'slug_change', null], message: 'Invalid subdomain resource lock kind' },
      default: null
    },
    token: { type: String, default: '' },
    expiresAt: { type: Date, default: null }
  },
  // Bounded operational audit for every public hostname reassignment. Stripe
  // entitlement rows remain the immutable financial record for a purchased
  // slug; this history records who intentionally moved the Store away from it.
  subdomainSlugHistory: {
    type: [{
      fromSlug: { type: String, required: true, lowercase: true, trim: true },
      toSlug: { type: String, required: true, lowercase: true, trim: true },
      actorType: {
        type: String,
        enum: ['seller', 'admin', 'ai', 'system'],
        required: true,
      },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reason: { type: String, default: '', maxlength: 240 },
      purchasedOwnershipForfeited: { type: Boolean, default: false },
      changedAt: { type: Date, required: true },
    }],
    default: [],
  },
  // Subdomain purchase / ownership
  subdomainPurchase: {
    isPurchased: {
      type: Boolean,
      default: false
    },
    purchasedAt: {
      type: Date
    },
    expiresAt: {
      type: Date  // purchasedAt + 3 years
    },
    stripePaymentId: {
      type: String,
      default: ''
    },
    // Durable idempotency history for Stripe Checkout completion retries.
    // Subdomain purchases are rare (multi-year), so this remains naturally small.
    processedPaymentIds: {
      type: [String],
      default: []
    },
    // A financial dispute temporarily freezes renewal/transfer while keeping
    // the slug reserved. Terminal refund/loss recalculates ownership from the
    // surviving payment contributions.
    paymentRiskState: {
      type: String,
      enum: ['none', 'open', 'lost'],
      default: 'none'
    },
    paymentRiskUpdatedAt: {
      type: Date,
      default: null
    },
    // Track removal schedule for blocked (non-purchased) accounts
    removalScheduledAt: {
      type: Date  // blockedAt + 7 days; null if purchased or not blocked
    },
    // Recovery markers for lifecycle notices. The event identity is frozen
    // before/with the state transition, then the durable outbox is retried
    // until it is safely enqueued.
    expiryNotice: {
      slug: { type: String, lowercase: true, trim: true, maxlength: 120, default: '' },
      expiresAt: { type: Date, default: null },
      notificationEnqueuedAt: { type: Date, default: null }
    },
    removalNotice: {
      previousSlug: { type: String, lowercase: true, trim: true, maxlength: 120, default: '' },
      removedAt: { type: Date, default: null },
      notificationEnqueuedAt: { type: Date, default: null }
    }
  },
  verification: {
    isVerified: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none'
    },
    appliedAt: {
      type: Date
    },
    reviewedAt: {
      type: Date
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    applicationMessage: {
      type: String,
      default: ''
    },
    contactEmail: {
      type: String,
      default: ''
    },
    contactPhone: {
      type: String,
      default: ''
    },
    rejectionReason: {
      type: String,
      default: ''
    }
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// Indexes for performance
storeSchema.index({ storeName: 'text', description: 'text' }); // Text search
storeSchema.index({ storeSlug: 1 }, { unique: true }); // Fast slug lookup with uniqueness
storeSchema.index({ seller: 1 }, { unique: true }); // Fast seller lookup with uniqueness (one store per seller)
storeSchema.index({ 'visibility.location': '2dsphere' });
storeSchema.index({
  isActive: 1,
  'visibility.mode': 1,
  'visibility.countryKey': 1,
  'visibility.regionKey': 1,
  'visibility.cityKey': 1,
  'visibility.townKey': 1
});

// Generate a safe fallback before validation when an internal/legacy caller did
// not provide a slug. Public creation controllers still perform uniqueness
// checks and normally provide the final slug explicitly.
storeSchema.pre('validate', function(next) {
  if (this.isModified('storeName') && !this.storeSlug) {
    const generated = slugifyStoreName(this.storeName);
    this.storeSlug = validateStoreSlug(generated).valid
      ? generated
      : `merchant-${String(this._id).slice(-12)}`;
  }
  next();
});

// Keep trust counters non-negative even for atomic update paths such as $inc.
storeSchema.pre('findOneAndUpdate', async function(next) {
  const update = this.getUpdate() || {};

  if (update.trustCount !== undefined && Number(update.trustCount) < 0) {
    update.trustCount = 0;
  }

  if (update.$set?.trustCount !== undefined && Number(update.$set.trustCount) < 0) {
    update.$set.trustCount = 0;
  }

  const trustIncrement = Number(update.$inc?.trustCount);
  if (Number.isFinite(trustIncrement) && trustIncrement < 0) {
    const current = await this.model.findOne(this.getQuery()).select('trustCount').lean();
    if (current && (Number(current.trustCount) || 0) + trustIncrement < 0) {
      update.$set = { ...(update.$set || {}), trustCount: 0 };
      delete update.$inc.trustCount;
      if (Object.keys(update.$inc).length === 0) delete update.$inc;
    }
  }

  this.setUpdate(update);
  next();
});

const Store = mongoose.model('Store', storeSchema);

module.exports = Store;
