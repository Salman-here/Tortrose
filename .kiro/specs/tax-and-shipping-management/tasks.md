# Implementation Plan

- [x] 1. Create backend data models and database schemas
  - Create TaxConfig model with validation for type (none/percentage/fixed) and value constraints
  - Create ShippingMethod model with seller reference and methods array
  - Add database indexes for efficient querying
  - _Requirements: 1.5, 4.2_

- [x] 2. Implement tax configuration backend API
  - [x] 2.1 Create tax controller with getTaxConfig and updateTaxConfig methods
    - Implement tax calculation logic for percentage and fixed amount
    - Add admin-only authorization middleware
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  
  - [x] 2.2 Create tax routes and integrate with Express app
    - Define GET /api/tax/config route (public)
    - Define PUT /api/tax/config route (admin only)
    - _Requirements: 1.1, 1.5_

- [x] 3. Implement shipping methods backend API
  - [x] 3.1 Create shipping controller with CRUD operations
    - Implement getSellerShippingMethods method
    - Implement updateShippingMethods with validation
    - Implement getShippingMethodsForCart to group by seller
    - Add seller-only authorization
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  
  - [x] 3.2 Create shipping routes and integrate with Express app
    - Define GET /api/shipping/seller/:sellerId route
    - Define PUT /api/shipping/methods route (seller only)
    - Define POST /api/shipping/cart route for checkout
    - _Requirements: 4.1, 4.5_

- [x] 4. Update Order model and controller for tax and shipping
  - [x] 4.1 Enhance Order model schema
    - Add tax field to orderSummary
    - Update shippingMethod to include seller reference and numeric deliveryDays
    - Add sellerShipping array for multi-seller support
    - _Requirements: 2.5, 7.1, 7.4_
  
  - [x] 4.2 Update order controller placeOrder method
    - Fetch tax configuration and calculate tax amount
    - Validate and store selected shipping methods
    - Calculate final total as subtotal + tax + shipping
    - Store tax and shipping details in order document
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.1, 7.2, 7.3_

- [x] 5. Create admin tax configuration UI component
  - [x] 5.1 Build TaxConfiguration component with form
    - Create radio button group for tax type selection
    - Add conditional input fields for percentage and fixed amount
    - Implement form validation (percentage 0-100, positive amounts)
    - Add save button with loading state
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  
  - [x] 5.2 Integrate tax configuration API calls
    - Fetch current tax config on component mount
    - Implement updateTaxConfig API call with error handling
    - Display success/error toast notifications
    - _Requirements: 1.5_
  
  - [x] 5.3 Add tax configuration to admin dashboard navigation
    - Create route for tax configuration page
    - Add navigation link in admin sidebar/menu
    - _Requirements: 1.1_

- [x] 6. Create seller shipping configuration UI component
  - [x] 6.1 Build ShippingConfiguration component with method cards
    - Create three shipping method cards (Free, Standard, Fast)
    - Add toggle for enabling/disabling free shipping
    - Add input fields for cost and delivery days
    - Implement form validation (free = $0, others > $0, days > 0)
    - _Requirements: 4.2, 4.3, 4.4_
  
  - [x] 6.2 Integrate shipping methods API calls
    - Fetch seller's current shipping methods on mount
    - Implement updateShippingMethods API call
    - Handle validation errors and display notifications
    - Prevent saving if all methods are disabled
    - _Requirements: 4.1, 4.4, 4.5_
  
  - [x] 6.3 Add shipping configuration to seller dashboard navigation
    - Create route for shipping configuration page
    - Add navigation link in seller sidebar/menu
    - _Requirements: 4.1_

- [x] 7. Enhance checkout component with tax and shipping
  - [x] 7.1 Fetch and display tax configuration
    - Fetch tax config on checkout component mount
    - Calculate tax amount based on cart subtotal
    - Display tax line item in order summary
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  
  - [x] 7.2 Implement shipping method selection UI
    - Fetch shipping methods for cart items grouped by seller
    - Display shipping options in shipping step
    - Add radio buttons for method selection
    - Show method name, cost, and delivery estimate
    - Handle multi-seller scenarios with grouped display
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  
  - [x] 7.3 Update order total calculation
    - Modify total calculation to include tax and shipping
    - Update order summary display with all cost breakdowns
    - Ensure real-time updates when shipping method changes
    - _Requirements: 2.1, 2.2, 2.3, 7.3_
  
  - [x] 7.4 Update order placement logic
    - Include selected shipping method in order data
    - Include calculated tax amount in order data
    - Validate shipping method selection before submission
    - _Requirements: 6.3, 7.1, 7.2_

- [x] 8. Update order display components across all user roles
  - [x] 8.1 Update UserOrderDetail component
    - Add tax line item to order summary section
    - Display shipping method details (name, cost, days)
    - Ensure consistent formatting with design
    - _Requirements: 3.1, 3.2, 3.3, 7.5_
  
  - [x] 8.2 Update admin/seller OrderDetail component
    - Add tax information to order details view
    - Display complete shipping method information
    - Show seller-specific shipping for multi-seller orders
    - _Requirements: 3.1, 3.2, 3.3, 7.5_
  
  - [x] 8.3 Update order list components
    - Add tax and shipping to order summary cards
    - Update total calculation display
    - Ensure consistency across UserOrdersManagement and admin orders view
    - _Requirements: 3.1, 3.2, 3.3_
  
  - [x] 8.4 Handle orders without tax data (backward compatibility)
    - Display $0.00 for tax if field is missing in old orders
    - Gracefully handle missing shipping method details
    - _Requirements: 3.4_

- [x] 9. Add authorization middleware and route protection
  - Verify admin-only access for tax configuration routes
  - Verify seller-only access for shipping configuration routes
  - Ensure sellers can only modify their own shipping methods
  - Add role checks in frontend route guards
  - _Requirements: 1.1, 4.1_

- [x] 10. Implement error handling and validation
  - Add comprehensive input validation on backend
  - Implement error responses with appropriate status codes
  - Add frontend form validation with error messages
  - Display user-friendly error notifications
  - Handle API failures gracefully with fallbacks
  - _Requirements: 1.5, 4.4, 4.5_
