const mongoose = require('mongoose');

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
    lowercase: true
  },
  description: {
    type: String,
    maxlength: [500, 'Description cannot exceed 500 characters'],
    default: ''
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
    country: {
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

// Pre-save middleware to generate slug if not provided
storeSchema.pre('save', function(next) {
  if (this.isModified('storeName') && !this.storeSlug) {
    this.storeSlug = this.storeName
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-'); // Replace multiple hyphens with single hyphen
  }
  next();
});

const Store = mongoose.model('Store', storeSchema);

module.exports = Store;
