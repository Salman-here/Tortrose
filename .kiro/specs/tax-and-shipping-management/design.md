# Design Document

## Overview

This design implements two independent but complementary features for the e-commerce platform:

1. **Admin Tax Configuration System**: A global tax management system where admins can configure platform-wide tax policies
2. **Seller Shipping Methods System**: A flexible shipping configuration system where sellers define custom shipping options

Both features integrate seamlessly into the existing checkout flow, order processing, and order display systems.

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend Layer                           │
├─────────────────────────────────────────────────────────────┤
│  Admin Tax Config UI  │  Seller Shipping Config UI          │
│  Checkout UI (Tax & Shipping Display)                       │
│  Order Display UI (All Roles)                               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Layer                               │
├─────────────────────────────────────────────────────────────┤
│  Tax Config Routes    │  Shipping Config Routes             │
│  Order Routes (Enhanced with Tax & Shipping)                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Business Logic Layer                      │
├─────────────────────────────────────────────────────────────┤
│  Tax Calculation Service                                     │
│  Shipping Method Service                                     │
│  Order Processing Service (Enhanced)                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     Data Layer                               │
├─────────────────────────────────────────────────────────────┤
│  TaxConfig Model  │  ShippingMethod Model  │  Order Model   │
└─────────────────────────────────────────────────────────────┘
```

### System Integration Points


- **Checkout Flow**: Modified to fetch tax config and seller shipping methods, calculate totals dynamically
- **Order Creation**: Enhanced to store tax amount and selected shipping method details
- **Order Display**: Updated across all user roles to show tax and shipping information
- **Admin Dashboard**: New tax configuration section
- **Seller Dashboard**: New shipping methods configuration section

## Components and Interfaces

### Backend Components

#### 1. Tax Configuration System

**TaxConfig Model** (`Backend/models/TaxConfig.js`)
```javascript
{
  type: String, // 'percentage', 'fixed', 'none'
  value: Number, // percentage (0-100) or fixed amount
  isActive: Boolean,
  updatedBy: ObjectId, // Reference to admin user
  createdAt: Date,
  updatedAt: Date
}
```

**Tax Controller** (`Backend/controllers/taxController.js`)
- `getTaxConfig()` - Retrieve current tax configuration (public)
- `updateTaxConfig()` - Update tax settings (admin only)
- `calculateTax(subtotal)` - Calculate tax amount based on config

**Tax Routes** (`Backend/routes/taxRoutes.js`)
- `GET /api/tax/config` - Get current tax configuration
- `PUT /api/tax/config` - Update tax configuration (admin only)

#### 2. Shipping Methods System

**ShippingMethod Model** (`Backend/models/ShippingMethod.js`)
```javascript
{
  seller: ObjectId, // Reference to seller user
  methods: [
    {
      type: String, // 'free', 'standard', 'fast'
      cost: Number, // 0 for free shipping
      deliveryDays: Number, // Estimated delivery time
      isActive: Boolean
    }
  ],
  createdAt: Date,
  updatedAt: Date
}
```

**Shipping Controller** (`Backend/controllers/shippingController.js`)
- `getSellerShippingMethods(sellerId)` - Get shipping methods for a seller
- `updateShippingMethods()` - Update seller's shipping methods (seller only)
- `getShippingMethodsForCart(cartItems)` - Get shipping options grouped by seller

**Shipping Routes** (`Backend/routes/shippingRoutes.js`)
- `GET /api/shipping/seller/:sellerId` - Get seller's shipping methods
- `PUT /api/shipping/methods` - Update seller's shipping methods (seller only)
- `POST /api/shipping/cart` - Get shipping options for cart items

#### 3. Enhanced Order System

**Order Model Updates** (`Backend/models/Order.js`)

```javascript
// Enhanced orderSummary section
orderSummary: {
  subtotal: Number,
  shippingCost: Number,
  tax: Number, // NEW: Tax amount
  totalAmount: Number
}

// Enhanced shippingMethod section
shippingMethod: {
  name: String, // 'free', 'standard', 'fast'
  price: Number,
  estimatedDays: Number, // Changed from enum to Number
  seller: ObjectId // NEW: For multi-seller support
}

// NEW: For multi-seller orders
sellerShipping: [
  {
    seller: ObjectId,
    shippingMethod: {
      name: String,
      price: Number,
      estimatedDays: Number
    }
  }
]
```

**Order Controller Updates** (`Backend/controllers/orderController.js`)
- Enhanced `placeOrder()` to calculate and store tax
- Enhanced `placeOrder()` to handle seller-specific shipping methods
- Updated order retrieval methods to include tax and shipping details

### Frontend Components

#### 1. Admin Tax Configuration UI

**Component**: `Frontend/src/components/admin/TaxConfiguration.jsx`

Features:
- Radio buttons for tax type selection (None, Percentage, Fixed Amount)
- Conditional input fields based on selection
- Real-time validation
- Save button with loading state
- Success/error notifications

UI Layout:
```
┌─────────────────────────────────────────┐
│  Tax Configuration                      │
├─────────────────────────────────────────┤
│  ○ No Tax                               │
│  ○ Percentage Based                     │
│     [____%] (0-100)                     │
│  ○ Fixed Amount                         │
│     [$____]                             │
│                                         │
│  [Save Configuration]                   │
└─────────────────────────────────────────┘
```

#### 2. Seller Shipping Configuration UI

**Component**: `Frontend/src/components/seller/ShippingConfiguration.jsx`

Features:
- Three shipping method cards (Free, Standard, Fast)
- Toggle to enable/disable free shipping
- Input fields for cost and delivery days
- Form validation
- Save button with loading state

UI Layout:
```
┌─────────────────────────────────────────────────────────┐
│  Shipping Methods Configuration                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Free        │  │ Standard    │  │ Fast        │    │
│  │ [✓] Enable  │  │ Cost: $___  │  │ Cost: $___  │    │
│  │ Days: [__]  │  │ Days: [__]  │  │ Days: [__]  │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                         │
│  [Save Shipping Methods]                                │
└─────────────────────────────────────────────────────────┘
```

#### 3. Enhanced Checkout UI

**Component**: `Frontend/src/components/layout/Checkout.jsx`

Modifications:
- Fetch tax configuration on component mount
- Fetch shipping methods for cart items (grouped by seller)
- Add shipping method selection UI in shipping step
- Display tax calculation in order summary
- Update total calculation: `subtotal + tax + shipping`

New Shipping Selection UI (in Shipping Step):
```
┌─────────────────────────────────────────┐
│  Select Shipping Method                 │
├─────────────────────────────────────────┤
│  ○ Free Shipping (5-7 days)      $0.00 │
│  ○ Standard Shipping (3-5 days)  $5.99 │
│  ○ Fast Shipping (1-2 days)     $12.99 │
└─────────────────────────────────────────┘
```

Order Summary Updates:
```
┌─────────────────────────────────────────┐
│  Order Summary                          │
├─────────────────────────────────────────┤
│  Subtotal:           $100.00            │
│  Tax (10%):           $10.00  ← NEW     │
│  Shipping:             $5.99            │
│  ─────────────────────────────          │
│  Total:              $115.99            │
└─────────────────────────────────────────┘
```

#### 4. Enhanced Order Display Components

**Components to Update**:
- `Frontend/src/components/layout/UserOrderDetail.jsx`
- `Frontend/src/components/layout/OrderDetail.jsx` (Admin/Seller)
- `Frontend/src/components/layout/orders.jsx`
- `Frontend/src/components/layout/UserOrdersManagement.jsx`

Modifications:
- Add tax line item in order summary sections
- Display shipping method details (name, cost, delivery estimate)
- Ensure consistent formatting across all views

## Data Models

### TaxConfig Schema

```javascript
const taxConfigSchema = mongoose.Schema({
  type: {
    type: String,
    enum: ['none', 'percentage', 'fixed'],
    default: 'none',
    required: true
  },
  value: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function(v) {
        if (this.type === 'percentage') return v <= 100;
        return true;
      },
      message: 'Percentage value cannot exceed 100'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });
```

### ShippingMethod Schema

```javascript
const shippingMethodSchema = mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  methods: [
    {
      type: {
        type: String,
        enum: ['free', 'standard', 'fast'],
        required: true
      },
      cost: {
        type: Number,
        required: true,
        min: 0,
        validate: {
          validator: function(v) {
            return this.type === 'free' ? v === 0 : v > 0;
          },
          message: 'Free shipping must have 0 cost, others must be > 0'
        }
      },
      deliveryDays: {
        type: Number,
        required: true,
        min: 1
      },
      isActive: {
        type: Boolean,
        default: true
      }
    }
  ]
}, { timestamps: true });
```

## Error Handling

### Backend Error Scenarios

1. **Tax Configuration Errors**
   - Invalid tax type → 400 Bad Request
   - Percentage > 100 → 400 Bad Request
   - Negative values → 400 Bad Request
   - Non-admin attempting update → 403 Forbidden

2. **Shipping Method Errors**
   - Free shipping with cost > 0 → 400 Bad Request
   - Standard/Fast shipping with cost = 0 → 400 Bad Request
   - Negative delivery days → 400 Bad Request
   - Non-seller attempting update → 403 Forbidden
   - All methods disabled → 400 Bad Request

3. **Checkout Errors**
   - No shipping method selected → 400 Bad Request
   - Invalid shipping method for seller → 400 Bad Request
   - Tax calculation failure → 500 Internal Server Error

### Frontend Error Handling

- Display toast notifications for all API errors
- Form validation before submission
- Disable submit buttons during processing
- Show loading states during API calls
- Graceful fallbacks if tax/shipping data unavailable

## Testing Strategy

### Unit Tests

1. **Tax Calculation Logic**
   - Test percentage-based calculation
   - Test fixed amount application
   - Test no tax scenario
   - Test edge cases (0%, 100%, negative values)

2. **Shipping Method Validation**
   - Test free shipping constraints
   - Test paid shipping constraints
   - Test delivery days validation
   - Test at least one active method requirement

3. **Order Total Calculation**
   - Test subtotal + tax + shipping
   - Test with different tax types
   - Test with different shipping methods
   - Test multi-seller scenarios

### Integration Tests

1. **Tax Configuration Flow**
   - Admin updates tax config
   - Tax reflects in checkout
   - Tax stored in orders
   - Tax displayed in order views

2. **Shipping Configuration Flow**
   - Seller creates shipping methods
   - Methods available at checkout
   - Selected method stored in order
   - Method details displayed in order views

3. **Complete Checkout Flow**
   - Cart → Shipping → Payment
   - Tax calculated correctly
   - Shipping method selected
   - Order created with all details
   - Order displays correctly for all roles

### End-to-End Tests

1. **Admin Tax Management**
   - Login as admin
   - Navigate to tax config
   - Update tax settings
   - Verify in checkout

2. **Seller Shipping Management**
   - Login as seller
   - Navigate to shipping config
   - Configure methods
   - Verify in checkout

3. **Customer Purchase Flow**
   - Add products to cart
   - Proceed to checkout
   - Select shipping method
   - View tax calculation
   - Complete order
   - View order details

## Security Considerations

1. **Authorization**
   - Tax config: Admin role required
   - Shipping config: Seller role required
   - Sellers can only modify their own shipping methods

2. **Input Validation**
   - Sanitize all numeric inputs
   - Validate enum values
   - Prevent negative values
   - Enforce min/max constraints

3. **Data Integrity**
   - Validate tax calculations server-side
   - Verify shipping method belongs to seller
   - Store original values in orders (immutable)
   - Audit trail for tax config changes

## Performance Considerations

1. **Caching**
   - Cache tax configuration (rarely changes)
   - Cache seller shipping methods
   - Invalidate cache on updates

2. **Database Queries**
   - Index seller field in ShippingMethod model
   - Single tax config document (no queries needed)
   - Efficient cart-to-seller grouping

3. **Frontend Optimization**
   - Fetch tax config once per session
   - Fetch shipping methods only at checkout
   - Memoize calculation functions
   - Debounce form inputs

## Migration Strategy

1. **Database Migration**
   - Create TaxConfig collection with default 'none' config
   - Create ShippingMethod collection (empty initially)
   - Update existing orders to have tax: 0 if missing

2. **Backward Compatibility**
   - Existing orders without tax field → display as $0.00
   - Sellers without shipping config → use default methods
   - Graceful degradation if services unavailable

3. **Rollout Plan**
   - Phase 1: Deploy backend models and APIs
   - Phase 2: Deploy admin tax configuration UI
   - Phase 3: Deploy seller shipping configuration UI
   - Phase 4: Update checkout flow
   - Phase 5: Update all order display components

## Future Enhancements

1. **Tax System**
   - Region-based tax rates
   - Product-specific tax categories
   - Tax exemptions for certain users
   - Tax reporting and analytics

2. **Shipping System**
   - Real-time shipping rate APIs
   - Weight-based shipping calculation
   - International shipping support
   - Shipping tracking integration
   - Multiple shipping addresses per order

3. **Multi-Seller Improvements**
   - Split orders by seller automatically
   - Separate shipping for each seller
   - Combined shipping discounts
   - Seller-specific tax handling
