# Rozare Live Buyer and Seller End-to-End Test Report

- Test window: 2026-08-29 through 2026-08-30 (Asia/Karachi)
- Target: https://rozare.com and its production API
- Browser method: live UI interactions through the in-app browser, using real account, seller, catalog, checkout, notification, fulfillment, review, and return screens
- Payment scope: Cash on Delivery only
- Excluded by request: Stripe/card payments and Rozare Wallet payments
- Result rule: “Working” means the live UI action and its authoritative resulting state were both verified. Automated checks are identified separately.
- Secrets policy: passwords, OTP values, session tokens, and confirmation tokens are intentionally omitted.

## Executive Result

The core live buyer/seller marketplace is working across the tested COD scope.

| Result | Verified live outcome |
|---|---|
| Seller coverage | 4 seller accounts and 4 Pakistan stores: 3 PKR stores and 1 USD store |
| Catalog coverage | 20 real live products, 5 per store, with uploaded images; one product also has a required Finish option |
| Buyer coverage | 1 verified buyer account with Pakistan/Lahore shipping and both PKR and USD display-currency tests |
| Order coverage | 8 COD orders: 4 delivered and paid, 4 cancelled and unpaid |
| Seller combinations | Single seller, three products from one seller, two sellers, all three PKR sellers, PKR buyer to USD seller, and USD-display buyer across PKR and USD sellers |
| Decision channels | Email confirmation, email cancellation, WhatsApp confirmation, WhatsApp cancellation, and buyer-dashboard cancellation |
| Notifications | Buyer and seller email, virtual WhatsApp, and in-app notifications verified |
| Post-fulfillment | Five-star review submitted; a return was requested, seller-rejected, buyer-notified, and no wallet refund was issued |
| WhatsApp test infrastructure | 50 fixed virtual numbers deployed; buyer/seller OTPs, button actions, normal notifications, and free-form AI replies use production routing |
| Current deployed code | main/origin/main at 31254f8 |

The final buyer dashboard showed 8 orders, 4 delivered, 0 pending, and $103.60 total spent. The four cancelled orders remained visible for audit but were excluded from spend.

## Production Changes and Deployment

| Change | Commit | Production status | Verification |
|---|---|---|---|
| Fixed 50-number virtual WhatsApp pool, guarded transport, and admin test inbox | ef75f23 | Deployed | Pool shows exactly +1 202-555-0100 through +1 202-555-0149; normal recipients stay on Evolution API |
| Authenticated seller onboarding OTP send/verify | 03542e6 | Deployed | All four seller OTP flows completed through the live seller onboarding UI |
| Free-form inbound WhatsApp AI testing through the authenticated production webhook | 31254f8 | Deployed | Buyer AI returned exact latest-order status/total; seller AI returned exact active-product count |

Deployment evidence:

- Railway backend deployment: SUCCESS; instance RUNNING at commit 31254f8.
- Vercel frontend deployment: SUCCESS at commit 31254f8.
- GitHub combined deployment status: success.
- Backend full regression: 195/195 suites, 2,846/2,846 tests passed.
- New focused WhatsApp/inbound tests: 3 suites, 10 tests passed.
- Frontend regression: 175/175 tests passed.
- Frontend production build and prerenders passed.
- ESLint: 0 errors; 11 pre-existing warnings outside this change.
- Git state at report completion: main equals origin/main at 31254f8; only generated test-assets/ is untracked.

## WhatsApp Test-Data Controls

| Control | Status | Evidence |
|---|---|---|
| Fixed pool contains 50 numbers | Working | Admin inbox lists Test 01 through Test 50, covering +1 202-555-0100 through +1 202-555-0149 |
| Only reserved active records are intercepted | Working | Backend validation and regression tests fail closed for inactive/unreserved records |
| Real numbers remain on normal transport | Working (automated) | Transport tests prove a normal number continues to the original Evolution API path |
| OTP is verified, not bypassed | Working | Seller and buyer onboarding used the normal OTP send and verify endpoints; OTPs were read only in the admin inbox |
| Inbox access is admin-only | Working | Backend endpoints use token plus admin middleware; frontend route is admin-protected |
| Captured buttons use the real decision path | Working | Confirm/cancel actions generated authenticated MESSAGES_UPSERT events and produced real order transitions |
| Free-form inbound text uses production AI routing | Working | Buyer question resolved the exact latest order; seller question resolved exactly 5 active products; first and last unassigned pool numbers returned account-linking guidance |
| Secrets are excluded from source/report | Working | No passwords, OTP values, access tokens, or decision tokens were committed or recorded here |

Seven distinct numbers were exercised live: both pool boundaries ending 0100 and 0149, four assigned sellers ending 0101–0104, and the assigned buyer ending 0110. Both unassigned boundary numbers accepted authenticated inbound text and returned the correct account-linking AI guidance. The remaining unassigned numbers use the same fixed allowlist, database, transport, and webhook code path; they were not individually bound to accounts because doing so would add redundant live test data.

## Accounts and Stores

| Account | Store | Store currency | Store location | Virtual WhatsApp | Status |
|---|---|---:|---|---|---|
| rozare.seller.82901@mailinator.com | Nova Nest Market | PKR | Lahore, Punjab, Pakistan | +1 202-555-0101 | Working |
| rozare.seller.82902@mailinator.com | Karachi Craft Co | PKR | Karachi, Sindh, Pakistan | +1 202-555-0102 | Working |
| rozare.seller.82903@mailinator.com | Pulse Peak Gear | PKR | Lahore, Punjab, Pakistan | +1 202-555-0103 | Working |
| rozare.seller.82904@mailinator.com | Atlas Aura Goods | USD | Lahore, Punjab, Pakistan | +1 202-555-0104 | Working |
| rozare.buyer.82910@mailinator.com | Buyer account | PKR and USD display tested | Lahore, Punjab, Pakistan | +1 202-555-0110 | Working |

Each seller completed live signup, OTP verification, Become Seller onboarding, store creation, location and currency selection, and store logo/banner upload. The buyer completed live signup, OTP verification, saved shipping information, and PKR/USD display testing.

## Live Catalog

All 20 products have uploaded catalog imagery and live product data.

| Store | Products and final verified stock notes |
|---|---|
| Nova Nest Market | Bamboo Desk Organizer (25; required Finish: Natural/Walnut), Insulated Steel Bottle (29), Cotton Throw Cushion (20), LED Reading Lamp (14), Ceramic Coffee Mug Set (18) |
| Karachi Craft Co | Handwoven Canvas Tote (21), Walnut Serving Board (14), Block Print Table Runner (19), Scented Soy Candle (26), Brass Desk Clock (11) |
| Pulse Peak Gear | Resistance Band Set (28), Yoga Mat (17 after cancellation restore), Gym Duffel (13), Steel Shaker (32), Jump Rope (24) |
| Atlas Aura Goods | Travel Tech Pouch (25), Minimalist Wallet (29), Packing Cubes (17), Portable Stand (21), Weekender Bag (12) |

Catalog checks:

| Check | Status | Evidence |
|---|---|---|
| Images, titles, descriptions, category, stock, and regular/sale prices | Working | Created and inspected live for all 20 products |
| Store logos and banners | Working | Uploaded for all four stores |
| PKR-native display | Working | PKR buyer saw exact PKR listing and checkout totals |
| USD-native to PKR conversion | Working | Packing Cubes $42 displayed and froze as Rs11,672.22 PKR |
| PKR-native to USD conversion | Working | Handwoven Canvas Tote Rs2,490 displayed and froze as $8.96 |
| Required option validation | Working | Incomplete Bamboo Desk Organizer add was blocked with “Choose an option for Finish to continue” |
| Selected option persistence | Working | Finish: Walnut persisted through modal, cart, checkout, buyer history, buyer detail, and seller detail |
| Inventory reservation/restoration | Working | Delivered items reduced stock; cancelled items restored stock, including Bamboo Desk Organizer back to 25 |

## COD Order Matrix

| # | Order reference | Scenario and total | Decision | Final state | Result |
|---:|---|---|---|---|---|
| 1 | ORD-1788027012731-4946CD821193953CB5B1 | One seller; Insulated Steel Bottle; Rs1,690 PKR | Confirmed through email landing page | Delivered / Paid | Working |
| 2 | ORD-1788031149838-901A4E9B09D71442E66E | Three products from Karachi Craft; Rs7,540 PKR | Cancelled through WhatsApp | Cancelled / Unpaid | Working |
| 3 | ORD-1788032248451-D5C1D466D4F4DD81601C | Two sellers; LED Lamp + Steel Shaker; Rs4,740 PKR | Confirmed through WhatsApp | Delivered / Paid | Working |
| 4 | ORD-1788032930339-5C34B5B4D19BEA9A193F | All three PKR sellers; Rs11,250 PKR | Cancelled through email landing page | Cancelled / Unpaid | Working |
| 5 | ORD-1788033498229-642CE122D05D0380D6CA | PKR buyer to USD-native seller; Packing Cubes $42 shown as Rs11,672.22 | Confirmed through WhatsApp | Delivered / Paid | Working |
| 6 | ORD-1788034520439-A4F63BB829C87AE1B842 | USD-display buyer across PKR and USD sellers; $8.96 + $29.50 = $38.46 | Confirmed through WhatsApp | Delivered / Paid | Working |
| 7 | ORD-1788035495869-945556A2EF927FBC0DF5 | Required Walnut variant; $8.10 | Cancelled from buyer dashboard before confirmation | Cancelled / Unpaid | Working |
| 8 | ORD-1788037049051-C4A514191365843DFDAF | LIVEQA10 coupon; $10.61 - $1.06 = $9.55 | Cancelled from buyer dashboard before confirmation | Cancelled / Unpaid | Working, with coupon-restoration defect D-05 |

## Multi-Seller Ownership and Fulfillment

| Check | Status | Live evidence |
|---|---|---|
| Seller sees only own items | Working | Order 3 split Rs3,290 to Nova Nest and Rs1,450 to Pulse Peak; Order 6 split $8.96 to Karachi Craft and $29.50 to Atlas Aura |
| Buyer sees complete aggregate | Working | Buyer details listed all seller lines, per-seller free shipping, and exact aggregate totals |
| Independent status transitions | Working | On Order 3, one seller could be Processing/Shipped while the other remained Confirmed/Processing; on Order 6, Karachi Craft remained Processing while Atlas Aura reached Delivered |
| Aggregate status is conservative | Working | Buyer aggregate remained Processing until both seller allocations advanced, then Shipped and Delivered at the correct boundaries |
| Global COD remains unpaid during partial delivery | Working | Atlas Aura allocation reached Delivered while Karachi Craft remained Processing; order still displayed Unpaid |
| Global COD becomes paid only after final allocation delivery | Working | Order 6 changed to Paid only when Karachi Craft delivered the remaining allocation |
| Per-seller revenue is recognized on seller delivery | Working | Atlas Aura revenue rose before global COD completion; final global payment followed the last allocation |
| Cancellation isolation and stock restore | Working | Orders 2, 4, and 7 remained Unpaid, generated per-seller cancellation notices, restored inventory, and added no recognized revenue |

## Dashboard and Analytics Reconciliation

### Buyer

- Final after Order 8 cancellation: Total Orders 8, Pending 0, Delivered 4, Total Spent $103.60.
- Order history showed all delivered/cancelled states and currency-converted totals.
- Cancelled orders remained visible for audit but were excluded from Total Spent.
- Order 6 detail showed both seller items, $38.46 total, COD Paid, and Delivered.
- Order 7 detail showed Finish: Walnut, buyer-dashboard cancellation provenance, Cancelled/Unpaid, and “Nothing has been charged.”

### Nova Nest Market

- Final inspected overview: 5 products, recognized revenue $17.92, average recognized order $8.96, total orders 5, fulfillment rate 40%, inventory health 100%.
- Two delivered allocations produced $6.08 + $11.84 = $17.92.
- Three cancellations produced no revenue.
- Bamboo stock returned to 25 after buyer-dashboard cancellation.
- Rejected return did not reduce revenue, change stock, or issue wallet funds.

### Karachi Craft Co

- Final inspected overview: 5 products, recognized revenue $8.96, average recognized order $8.96, total orders 3, fulfillment rate 33%, inventory health 100%.
- Final inspected Analytics: total revenue $8.96, recognized orders 1, units sold 1, delivered 1, cancelled 2, top product Handwoven Canvas Tote at $8.96.
- Cancelled Board/Runner/Candle/Clock quantities were restored; delivered Tote stock is 21.

### Pulse Peak Gear

- Delivered Order 3 allocation recognized $5.22 and reduced Steel Shaker stock to 32.
- Order 4 cancellation restored Yoga Mat stock and generated the exact seller allocation cancellation message.

### Atlas Aura Goods

- After Order 5 delivery: recognized revenue $42, Packing Cubes stock 17.
- After its Order 6 allocation delivery: recognized revenue $71.50, average recognized order $35.75, total orders 2, fulfillment 100%, Minimalist Wallet stock 29.
- Its $29.50 seller allocation was visible without the Karachi Craft item.

Seller overview “Total Orders” includes cancelled orders, while Analytics “Recognized Orders” and recognized revenue include only qualifying delivered COD allocations. The displayed fulfillment rates match delivered divided by all seller orders.

## Email, WhatsApp, and In-App Notifications

| Check | Status | Evidence |
|---|---|---|
| Seller OTPs and buyer OTP | Working | Captured in admin inbox and submitted through normal live verification forms |
| Initial COD WhatsApp message | Working | Exact frozen items/total plus Confirm and Cancel buttons |
| WhatsApp confirm | Working | Orders 3, 5, and 6 confirmed through production webhook actions |
| WhatsApp cancel | Working | Order 2 cancelled; seller/buyer states and stock restored |
| Cross-channel replay protection | Working | After Order 4 email cancellation, old WhatsApp Confirm produced a reconfirm prompt; “keep cancelled” preserved cancellation |
| Buyer free-form WhatsApp AI | Working | “What is the status and total of my latest order?” returned the exact Order 5 reference, Confirmed state, and Rs11,672.22 total |
| Seller free-form WhatsApp AI | Working | “How many active products are in my store?” returned exactly 5 |
| Seller new-order/decision WhatsApp | Working | Order 6 seller notices contained only $8.96 and $29.50 respective allocations |
| Buyer status WhatsApp | Working | Order 6 produced Processing, Shipped, and Delivered messages with frozen total $38.46 |
| Buyer confirmation email | Working | Mailinator received confirmation messages for live orders |
| Buyer lifecycle email | Working | Order 6 Mailinator subjects: Confirm COD, Order processing, Order shipped, Order delivered |
| Buyer in-app notifications | Working | 21 unread records included all order confirmations/final statuses and return rejection |
| Seller in-app notifications | Working | New order, buyer decision, cancellation, delivery, and return request were visible to the correct seller |
| Return WhatsApp | Working | Seller received New Return Request; buyer received Return rejected with exact audit note |

Functional email decisions work by opening a secure Rozare page that contains Confirm and Cancel. See Defect D-04 for the literal two-buttons-inside-email requirement.

## Confirmation, Cancellation, Review, and Return Edge Cases

| Edge case | Status | Evidence |
|---|---|---|
| Email confirm | Working | Order 1 confirmed and fulfilled |
| Email cancel | Working | Order 4 cancelled with no charge |
| WhatsApp cancel | Working | Order 2 cancelled and stock restored |
| Account/dashboard cancel before fulfillment | Working | Order 7 cancelled with provenance “Cancelled by buyer from account” |
| Cancel after any allocation shipped | Server guard Working; UI gap | Order 3 cancellation was rejected after one seller shipped; order state did not change |
| Old WhatsApp Confirm after email cancellation | Working | Reconfirm challenge appeared; buyer kept the order cancelled |
| Review after delivery | Working | Five-star Insulated Steel Bottle review saved with live QA text and appeared in seller Top Rated Products |
| Return request eligibility | Working | Order 1 exposed a 14-day return window with exact deadline |
| Return request creation | Working | RET-1788035122640-5C03E8 created for quantity 1 with audit reason |
| Seller return handling | Working | Seller rejected request with note; buyer detail and notifications updated |
| Wallet exclusion respected | Working | No refund was issued and no wallet balance was changed |

## Storefront Utilities, Coupons, and Seller Configuration

| Check | Status | Evidence |
|---|---|---|
| Product search | Working | Searching “Yoga Mat” submitted search=Yoga+Mat and reduced results to Yoga Mat |
| Category filter | Working | Sports & Outdoors filter returned exactly Resistance Band Set, Jump Rope, Gym Duffel, Steel Shaker, and Yoga Mat |
| Reset filters | Working | Reset removed the search/category query before a category-only check |
| Wishlist add/remove | Working | Yoga Mat changed Wishlist 0 → 1, appeared in My Wishlist, then trash removal restored Wishlist 0 |
| Public order tracking | Working | Correct email + Order 6 reference returned $38.46, Delivered, COD Paid, shipping address, and two items |
| Tracking privacy check | Working | Correct order reference with a mismatched email returned “Order not found” and no order data |
| Coupon creation | Working | LIVEQA10 created as 10% off all products, 5 total uses, 1 use per buyer, expiry 9/30/2026 |
| Coupon redemption math | Working | Ceramic Mug $10.61 received -$1.06 discount and froze at $9.55 on Order 8 |
| Coupon cancellation | Order cancellation Working; restoration Not Working | Order 8 cancelled/unpaid and stock/revenue restored, but coupon usage did not restore; see D-05 |
| Coupon cleanup | Working | LIVEQA10 was deactivated after testing to avoid unintended public discounts |
| Store settings persistence | Working | Nova Nest remained PKR, COD-enabled, with live subdomain, branding, 14-day returns, wallet refund policy, and warranty settings |
| Shipping settings persistence | Working | Free Shipping remained enabled at zero cost with 5 delivery days; checkout used the same per-seller method |

## Defects

### D-01 — Seller order detail falsely says email confirmation was not sent

- Severity: Medium
- Reproduced: Yes, repeatedly
- Steps: place a COD order, verify the Mailinator confirmation email, then inspect seller order detail.
- Expected: Email confirmation state reflects that the message was sent/received.
- Actual: Seller detail shows “Email confirmation: Not sent” even when the email arrived. Order 1 was also successfully confirmed through that email link.
- Impact: Incorrect seller audit trail; fulfillment itself still works.

### D-02 — Cancelled COD order retains “Payment Details Status: Pending”

- Severity: Low
- Reproduced: Orders 7 and 8
- Steps: place a pending COD order, cancel it from the buyer dashboard, inspect buyer order detail.
- Expected: Payment detail should show Unpaid or Cancelled.
- Actual: Top-level order correctly shows Cancelled/Unpaid and “Nothing has been charged,” but the Payment Details subsection still says Status: Pending.
- Impact: Confusing presentation; no money was collected and seller state is correct.

### D-03 — Buyer Cancel Order control remains visible after one seller has shipped

- Severity: Low
- Reproduced: Order 3
- Steps: advance one seller allocation to Shipped while another remains Processing; inspect buyer order detail and click Cancel.
- Expected: The button should be hidden/disabled with an explanation.
- Actual: Button remains visible; the server correctly rejects the request with “This order has already shipped or been delivered. Use the return request flow…”
- Impact: Safe backend behavior, but avoidable buyer confusion.

### D-04 — Email contains a secure decision link, not two direct embedded buttons

- Severity: Low / requirement clarification
- Reproduced: Multiple COD emails
- Expected from the stated requirement: Confirm and Cancel buttons directly in the email.
- Actual: Email opens a secure Rozare confirmation page containing both Confirm and Cancel buttons.
- Impact: The decision flow is secure and fully functional, but the literal email-layout requirement is not met.

### D-05 — Cancelling a discounted order does not restore coupon usage

- Severity: Medium
- Reproduced: Order 8 with LIVEQA10
- Steps: create a 10% coupon with 5 total uses and 1 use per buyer; apply it to a $10.61 item; place the $9.55 COD order; cancel before confirmation; inspect coupon management and start another eligible checkout.
- Expected: Cancelling an unpaid order releases the coupon redemption, returns total uses to 0/5, and allows the buyer to use the one-use coupon on a later order.
- Actual: Seller coupon management remains at 1/5 used. A second checkout for the same seller no longer exposes the coupon field for that buyer, consistent with the one-use allowance remaining consumed.
- Impact: Buyers lose a limited-use coupon after cancelling an unpaid order, and seller usage analytics overcount completed redemptions.
- Cleanup: LIVEQA10 was deactivated after verification.

## Working but Not Exhaustively Repeated

- The fixed 50-number pool was structurally and automatically verified; five assigned numbers were exercised live instead of creating 50 accounts.
- Product edit/delete, subdomain purchase, ads, subscription billing, saved cards, wallet funding/refund, and Stripe were not part of the completed mutation matrix.
- Admin authorization negative cases were covered by automated tests, not by intentionally attacking production.
- Native mobile application flows were not tested; this run was explicitly the live website/browser.
- Real-device Evolution API delivery was intentionally not used for reserved fictional test numbers. The verified result is application-level outbound capture plus authenticated inbound production webhook/AI processing.

## Final Classification

| Area | Final status |
|---|---|
| Signup and OTP | Working |
| Seller onboarding and store creation | Working |
| PKR/USD catalog and conversions | Working |
| Product options | Working |
| Search, category filters, wishlist, and public tracking | Working |
| Cart and multi-seller checkout | Working |
| COD order creation | Working |
| Email/WhatsApp confirmation and cancellation | Working, with D-04 layout gap |
| Seller ownership isolation | Working |
| Fulfillment and COD money recognition | Working |
| Buyer/seller dashboards and analytics | Working |
| Inventory reservation/restoration | Working |
| Reviews | Working |
| Returns without wallet mutation | Working |
| In-app/email/WhatsApp notifications | Working |
| Coupon creation and discount math | Working |
| Coupon restoration after cancellation | Not Working (D-05) |
| Seller email audit label | Not Working (D-01) |
| Cancelled-order payment subsection label | Not Working (D-02) |
| Post-shipment cancel-button UX | Not Working (D-03); server guard works |

## Live Data Left Intentionally

- Four seller accounts and stores
- One buyer account
- Twenty products and their uploaded images
- Eight COD orders and their audit histories
- One inactive LIVEQA10 coupon retained as defect evidence
- One five-star product review
- One rejected return request, with no wallet refund
- Captured virtual WhatsApp OTP/message/action/AI audit records

These records were left in production intentionally because they are the evidence set for this test. No passwords or OTP values are present in this report.
