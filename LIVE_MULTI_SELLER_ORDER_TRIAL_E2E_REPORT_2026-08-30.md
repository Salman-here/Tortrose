# Rozare Live Multi-Seller, Trial, Money, and Notification E2E Report

- Test window: 2026-08-29 through 2026-08-30 (Asia/Karachi)
- Target: https://rozare.com and the production backend
- Test method: real browser UI using dedicated Mailinator buyer and seller accounts; implementation, deployment, and production health checks were performed separately
- Payment scope: Cash on Delivery (COD)
- Explicit exclusions: Stripe/card payments and Rozare Wallet payments
- Result rule: **Working** means the live browser action and its authoritative persisted result were both inspected. Automated-only coverage is labelled separately.
- Secrets policy: passwords, OTP values, session tokens, database credentials, and order-decision tokens are intentionally omitted.

## Executive Verdict

The tested live COD marketplace behavior is working after the fixes in this run.

| Critical requirement | Final result | Directly observed evidence |
|---|---|---|
| Dedicated identities | Working | All buyer orders were placed from the dedicated buyer account, never from the admin account. Dedicated seller accounts managed their own stores and orders. |
| Configurable seller trial | Working | Admin reset Atlas Aura Goods to 1 calendar month and then extended it by 2 days. The visible end date moved from September 13 to September 30 and then October 2, 2026. |
| Admin dashboard resilience | Working | The Product Management page loaded 309 products even though one historical product has invalid stored price precision; that row displayed `Price unavailable` without crashing the dashboard. |
| Compact new order IDs | Working | New orders use `ORD-` plus a 13-digit millisecond timestamp, for example `ORD-1788052249083`. No random 20-character suffix is added. |
| One buyer order split by seller | Working | Buyer order detail shows one order divided into separate store sections, each with its own items, total, shipping, delivery estimate, and status. |
| Seller ownership isolation | Working | Each seller saw only that seller's products and allocation, not products belonging to other sellers in the same order. |
| Independent seller fulfillment | Working | Pulse Peak Gear advanced only its portion of a three-seller order to Shipped while Nova Nest and Atlas Aura remained at their own statuses. |
| Buyer tracking and targeted notification | Working | Buyer saw the separate seller statuses and received a Pulse-specific shipped notification naming only Yoga Mat, free shipping, five days, and Rs4,250.00 PKR. |
| Product options | Working | `Finish: Walnut` persisted from product selection through cart, checkout, buyer order detail, and seller order detail. Missing a required option was blocked. |
| PKR/USD mixed money | Working | PKR and USD buyer-order scenarios reconciled to the cent/paisa across item lines, seller totals, aggregate totals, email, WhatsApp, and dashboards. |
| Frozen historical FX | Working | Conversion occurs for the current catalog/cart/checkout, but each submitted order saves the accepted rate and exact amounts. Existing orders are not recalculated when the live rate later changes. |
| COD payment truth | Working | Cancelled COD orders show Unpaid/Nothing charged. COD revenue is recognized for a seller only when that seller allocation is delivered; global COD becomes Paid only after all seller portions are delivered. |
| Confirmation delivery audit | Working | Seller order detail accurately displayed email and WhatsApp delivery state for a fresh order. |
| Email decisions | Working | New email contained separate green Confirm Order and red Cancel Order buttons. GET opens a safe decision page and does not mutate the order; the final action requires an explicit decision. |
| Coupon cancellation lifecycle | Working | Cancelling an unpaid discounted order released the buyer allowance and total usage. A historical stale redemption was repaired in production, and the final repair dry-run found zero candidates. |

## Production Revision and Deployment

Application/runtime revision verified in production:

- Git commit: `3bb815756a0eb9f174d92595d2bd58448aedfb3c`
- Railway deployment: `41a4bf7f-9c91-4168-b94b-e395b6312c7f`
- Railway state: `SUCCESS` / service online
- Health response: environment `production`, MongoDB connected, notification outbox worker started
- Git state before this report commit: local `main`, `origin/main`, and deployed runtime all pointed to `3bb8157`

This report is documentation only. The final report commit does not change application behavior.

## Production Change Ledger

| Commit | Change delivered | Why it was needed |
|---|---|---|
| `ef75f23` | Added the guarded 50-number virtual WhatsApp test pool and admin test inbox. | Enables production-routing tests for reserved fictional numbers while ordinary recipients continue to the real Evolution API transport. |
| `03542e6` | Bound Become Seller WhatsApp OTP verification to the authenticated account. | Prevents an OTP verified for one identity from being used to bind another seller. |
| `31254f8` | Added authenticated inbound WhatsApp text/AI testing to the admin inbox. | Exercises the real webhook and AI routing for reserved test numbers. |
| `a35fb38` | Added configurable trial reset/extension, compact order IDs, seller-split buyer tracking, independent seller status, seller shipping sections, and frozen order money. | Implements the critical admin, order-identity, multi-seller, and historical-money requirements. |
| `9da8d26` | Made buyer order lists resilient to invalid legacy totals. | One corrupt historical record must not prevent buyers from opening order history. |
| `f50f53a` | Isolated corrupt product money in Admin Product Management. | One invalid product price previously caused the whole admin page to fail. |
| `05023c9` | Preserved selected buyer product options in order presentations. | Ensures the buyer's selected variant reaches buyer and seller order views. |
| `11f32de` | Kept exact frozen line prices consistent when a converted unit amount cannot be represented independently without a one-cent difference. | Prevents displays such as `$15.30` unit price beside a `$15.29` one-unit subtotal. |
| `9648a7f` | Persisted durable COD confirmation email/WhatsApp delivery metadata. | Seller order detail had incorrectly shown email as not sent even when Mailinator received it. |
| `8d09c34` | Releases reserved or consumed coupon capacity when an unpaid order is cancelled; safely reacquires capacity if the order is reconfirmed. | A cancelled unpaid order previously consumed the buyer limit and seller's total coupon uses. |
| `a707a47` | Added separate scanner-safe Confirm and Cancel buttons to COD email. | Meets the literal two-button requirement without allowing link scanners or email previews to mutate orders through GET. |
| `3bb8157` | Added an idempotent production repair for historical cancelled/unpaid coupon redemptions. | Corrects data created before `8d09c34` without touching paid, active, or non-cancelled orders. |

## Test Accounts and Identity Isolation

No admin credential was used to place an order.

| Purpose | Account | Store/currency/location | Virtual WhatsApp |
|---|---|---|---|
| Seller 1 | `rozare.seller.82901@mailinator.com` | Nova Nest Market / PKR / Lahore, Pakistan | +1 202-555-0101 |
| Seller 2 | `rozare.seller.82902@mailinator.com` | Karachi Craft Co / PKR / Karachi, Pakistan | +1 202-555-0102 |
| Seller 3 | `rozare.seller.82903@mailinator.com` | Pulse Peak Gear / PKR / Lahore, Pakistan | +1 202-555-0103 |
| Seller 4 | `rozare.seller.82904@mailinator.com` | Atlas Aura Goods / USD / Lahore, Pakistan | +1 202-555-0104 |
| Buyer | `rozare.buyer.82910@mailinator.com` | Buyer / PKR and USD display tested / Lahore, Pakistan | +1 202-555-0110 |

Each seller was created through live signup, normal OTP submission, Become Seller, store setup, location/currency selection, and branding upload. The buyer was separately signed up and verified and used saved Pakistan shipping information.

The admin identity was used only for admin functions: trial controls, product-dashboard recovery checks, and the virtual WhatsApp inbox.

## Live Stores and Catalog

Four stores and twenty products remain in production as the evidence set. Each store has a logo and banner, and each product has an uploaded image.

| Store | Native catalog currency | Five live products |
|---|---:|---|
| Nova Nest Market | PKR | Bamboo Desk Organizer; Insulated Steel Bottle; Cotton Throw Cushion; LED Reading Lamp; Ceramic Coffee Mug Set |
| Karachi Craft Co | PKR | Handwoven Canvas Tote; Walnut Serving Board; Block Print Table Runner; Scented Soy Candle; Brass Desk Clock |
| Pulse Peak Gear | PKR | Resistance Band Set; Yoga Mat; Gym Duffel; Steel Shaker; Jump Rope |
| Atlas Aura Goods | USD | Travel Tech Pouch; Minimalist Wallet; Packing Cubes; Portable Stand; Weekender Bag |

Catalog behavior observed live:

- Required option validation blocked Bamboo Desk Organizer until a Finish was chosen.
- Both `Natural` and `Walnut` were selectable.
- `Finish: Walnut` survived the complete order pipeline.
- Delivered items reduced stock.
- Cancelled unpaid items restored stock.
- Search, category filter, wishlist add/remove, public order tracking, coupon creation/deactivation, store settings, and shipping settings were also exercised in the broader run.

## Admin Trial Controls

The live Atlas Aura Goods trial test produced these exact outcomes:

1. The original 15-day trial ended September 13, 2026.
2. Admin selected **Reset**, entered `1`, and selected **month**.
3. The trial end became September 30, 2026: one calendar month from August 30, not a hard-coded 30-day approximation.
4. Admin selected **Extend**, entered `2`, and selected **days**.
5. The trial end became October 2, 2026.

Validation is enforced on the server:

- Positive whole values only.
- Days: maximum 3,650.
- Months: maximum 120.
- Reset starts from the current date.
- Extend starts from the current stored trial end.

Result: **Working and observed live.**

## Admin Dashboard Error and Recovery

Initial production symptom:

- `/admin-dashboard/product-management` failed because historical product `Black Noise-Cancelling Earbuds With Charging Case` has invalid stored price precision.

Final behavior after `f50f53a`:

- The page opened successfully.
- 309 product records loaded.
- The corrupt row displayed `Price unavailable`.
- Edit was disabled for that unsafe value.
- Delete remained available.
- Other product rows stayed usable.

The bad stored value was not silently rounded or rewritten. This preserves auditability and prevents one record from taking down the admin surface.

Result: **Working and observed live.**

## Order ID Behavior

All new orders in the final run have the compact form requested:

- `ORD-1788052249083`
- `ORD-1788054194531`
- `ORD-1788057233220`
- `ORD-1788058811996`
- `ORD-1788059520693`

The identifier contains the `ORD-` prefix and a 13-digit millisecond timestamp. Collision handling is performed by the backend rather than appending a long random suffix.

Historical IDs such as `ORD-1788027012731-4946CD821193953CB5B1` were intentionally not renamed. Changing an existing external reference would break notification links, support references, audit history, and idempotency records.

Result: **Working for every new order; historical references safely preserved.**

## Final Multi-Seller Order Run

### R1 — PKR buyer, three stores, one USD-native seller, independent status

- Order: `ORD-1788052249083`
- Buyer/order currency: PKR
- Payment: COD
- Shipping: free for all three seller portions

| Seller section | Native product | Frozen PKR line/seller total | Option | Observed seller status behavior |
|---|---|---:|---|---|
| Nova Nest Market | Bamboo Desk Organizer | Rs2,250.00 | Finish: Walnut | Nova independently moved to Processing. |
| Atlas Aura Goods | Minimalist Wallet, native USD | Rs8,196.87 | None | Atlas saw only its wallet line and exact frozen allocation. |
| Pulse Peak Gear | Yoga Mat | Rs4,250.00 | None | Pulse independently advanced Confirmed → Processing → Shipped. |
| **Buyer aggregate** | Three stores | **Rs14,696.87** | Walnut visible | One order, three separate store/shipping/status sections. |

Exact reconciliation:

`Rs2,250.00 + Rs8,196.87 + Rs4,250.00 + Rs0.00 shipping = Rs14,696.87`

After Pulse shipped:

- The buyer no longer saw a Cancel Order button.
- The UI explained that the whole order cannot be cancelled because Pulse Peak Gear already shipped its portion.
- The server-side cancellation guard also remained in force.
- The buyer received a seller-specific notification: Pulse Peak Gear shipped Yoga Mat; shipping was free; estimated delivery was five days; the frozen seller portion was Rs4,250.00 PKR.
- Nova and Atlas statuses were not incorrectly advanced by Pulse's action.
- COD stayed unpaid because the complete multi-seller order was not delivered.

Result: **Money, option, ownership, independent fulfillment, cancellation gating, and targeted notification all observed correct.**

### R2 — USD buyer, mixed PKR and USD sellers

- Order: `ORD-1788054194531`
- Buyer/order currency: USD
- Final state: Cancelled / Unpaid

| Seller section | Frozen USD allocation |
|---|---:|
| Nova Nest Market — Bamboo Desk Organizer, Finish: Natural | $8.10 |
| Pulse Peak Gear — Yoga Mat | $15.29 |
| Atlas Aura Goods — Minimalist Wallet | $29.50 |
| **Buyer aggregate** | **$52.89** |

Exact reconciliation:

`$8.10 + $15.29 + $29.50 + $0.00 shipping = $52.89`

The old rounding presentation would have shown the one-unit Yoga Mat as `$15.30` beside a `$15.29` subtotal. After `11f32de`, the browser consistently showed the frozen `$15.29` line amount. The same exact values appeared in seller views, buyer detail, email, and WhatsApp.

Result: **Working and observed live.**

### R3 — Fresh confirmation-delivery audit

- Order: `ORD-1788057233220`
- Item: Pulse Peak Gear Steel Shaker
- Buyer/order currency: USD
- Total: $5.22
- Final state: Cancelled through WhatsApp / Unpaid

Immediately after placement, the seller order detail showed both confirmation channels as sent. The Mailinator message and virtual WhatsApp message existed, so the seller audit label matched real delivery state. Cancellation added no recognized revenue.

Result: **Working and observed live.**

### R4 — Coupon reservation and cancellation restoration

- Order: `ORD-1788058811996`
- Item: Steel Shaker
- Base amount: $5.22
- Coupon: LIVEFIX30, 10%
- Discount: $0.52
- Final total: $4.70
- Final state: Cancelled from buyer dashboard / Unpaid

Lifecycle observed in the live seller coupon UI:

1. Before checkout: 0/1 uses, active.
2. After order placement: 1/1, exhausted.
3. After unpaid cancellation: 0/1, available again.
4. Buyer order detail: Cancelled, Unpaid, Nothing charged, with `$5.22 - $0.52 = $4.70`.
5. Seller order detail contained only the seller's Steel Shaker line and the same exact amounts.
6. The test coupon was deactivated afterward to prevent unintended public use.

Result: **Working and observed live after the fix.**

### R5 — Separate scanner-safe email buttons

- Order: `ORD-1788059520693`
- Item: Steel Shaker
- Total: $5.22
- Final state after cleanup: Cancelled from buyer dashboard / Unpaid

Mailinator received the live subject `Confirm cash on delivery order ORD-1788059520693`. The rendered message contained:

- A green **Confirm Order** button.
- A red **Cancel Order** button.
- The exact item and $5.22 frozen total.
- A security explanation.

Opening Cancel from the email loaded a safe Rozare decision page with order identity, items, total, address, and both final actions. Merely opening the GET URL did not cancel the order. This protects against automated email scanners and preview bots. Earlier live orders separately proved the explicit landing-page Confirm and Cancel actions.

Result: **Two-button email requirement and safe decision behavior observed live.**

## Broader COD Order Matrix

The earlier live matrix remains useful evidence for completed fulfillment, channel decisions, review, return, and seller revenue.

| # | Order | Scenario and exact total | Decision/final state | Result |
|---:|---|---|---|---|
| B1 | `ORD-1788027012731-4946CD821193953CB5B1` | Nova bottle, Rs1,690.00 | Email-confirmed; Delivered/Paid | Working |
| B2 | `ORD-1788031149838-901A4E9B09D71442E66E` | Three Karachi products, Rs7,540.00 | WhatsApp-cancelled; Cancelled/Unpaid | Working |
| B3 | `ORD-1788032248451-D5C1D466D4F4DD81601C` | Nova + Pulse, Rs4,740.00 | WhatsApp-confirmed; Delivered/Paid | Working |
| B4 | `ORD-1788032930339-5C34B5B4D19BEA9A193F` | All three PKR sellers, Rs11,250.00 | Email-page cancelled; Cancelled/Unpaid | Working |
| B5 | `ORD-1788033498229-642CE122D05D0380D6CA` | PKR buyer, Atlas Packing Cubes $42 native → Rs11,672.22 | WhatsApp-confirmed; Delivered/Paid | Working |
| B6 | `ORD-1788034520439-A4F63BB829C87AE1B842` | USD buyer, Karachi $8.96 + Atlas $29.50 = $38.46 | WhatsApp-confirmed; Delivered/Paid | Working |
| B7 | `ORD-1788035495869-945556A2EF927FBC0DF5` | Bamboo Finish: Walnut, $8.10 | Buyer-dashboard cancelled; Cancelled/Unpaid | Working |
| B8 | `ORD-1788037049051-C4A514191365843DFDAF` | LIVEQA10, $10.61 - $1.06 = $9.55 | Buyer-dashboard cancelled; historical stale coupon repaired | Working after data repair |

Together with R1-R5, the live evidence set contains thirteen COD orders covering one seller, one seller with multiple products, two sellers, three sellers, native PKR, native USD, buyer PKR, buyer USD, options, discounts, free shipping, independent fulfillment, email/WhatsApp/dashboard decisions, delivery, cancellation, review, and return.

## Buyer and Seller Money Presentation

### What the seller sees

Seller order detail is scoped to the authenticated seller and uses the frozen **order currency** for that order.

- A USD-native Atlas product bought in a PKR order was shown to Atlas as its exact PKR order allocation, not as another seller's money and not as a later live conversion.
- In R1, Atlas saw only Minimalist Wallet at Rs8,196.87 PKR.
- Nova saw only Rs2,250.00 PKR.
- Pulse saw only Rs4,250.00 PKR.
- The seller did not see the buyer's other-store products.

### What the buyer sees

Buyer order detail uses the same frozen order currency and adds separate seller cards:

- Items and selected options.
- Seller-specific product subtotal.
- Seller shipping method, price, and delivery estimate.
- Seller coupon/rounding amounts where applicable.
- Seller total.
- Seller-specific fulfillment progress.
- One reconciled aggregate order total.

### Mixed order in USD

R2 displayed every seller allocation in the buyer's frozen USD order currency:

`$8.10 + $15.29 + $29.50 = $52.89`

The PKR-native seller lines were converted once for checkout and then stored. They are not live-reconverted when the dashboard opens.

### Mixed order in PKR

R1 displayed every seller allocation in the buyer's frozen PKR order currency:

`Rs2,250.00 + Rs4,250.00 + Rs8,196.87 = Rs14,696.87`

The Atlas USD-native line was converted for this checkout and frozen at Rs8,196.87.

Result: **Buyer and seller order-detail calculations were directly observed correct in both PKR and USD mixed-seller orders.**

## Product Options

The Bamboo Desk Organizer has required option `Finish` with `Natural` and `Walnut` values.

| Surface | Observed result |
|---|---|
| Product quick-add/modal | Add was blocked until Finish was selected. |
| Cart | Selected Finish was visible. |
| Checkout | Selected Finish remained visible. |
| Buyer order history/detail | `Finish: Walnut` or `Finish: Natural` matched the buyer's choice. |
| Seller order detail | The authenticated Nova seller saw the same selected Finish for its item. |
| Other sellers | Atlas and Pulse did not see Nova's product line. |

Result: **Working and observed live.**

## Currency Conversion: Live Before Checkout, Frozen After Checkout

The answer to whether USD is repeatedly converted to PKR is:

1. **Before an order is submitted:** product pages, cart, and checkout use the current trusted/cached exchange-rate data. The frontend rate cache is short-lived (up to roughly 15 minutes), and the backend validates trusted conversion at checkout.
2. **At order creation:** the backend saves the accepted exchange-rate snapshot, order currency, exact line subtotals, shipping, discounts, reconciliation adjustment, and per-seller allocations.
3. **After order creation:** buyer history, buyer detail, seller detail, notifications, exports, and analytics read the saved order values. They do not ask today's exchange rate to rewrite an old order.

Live proof:

- The older Yoga Mat order remained frozen at $15.29.
- A later fresh cart showed $15.30 under the newer current rate.
- Opening the older order still showed $15.29 everywhere.

This is the correct financial behavior: browsing prices can follow the current market, while a submitted order remains a historical financial record.

Result: **Working and observed live.**

## Seller Split, Fulfillment, and Buyer Tracking

| Check | Final result | Evidence |
|---|---|---|
| One order, separate seller cards | Working | R1 buyer detail had Nova, Atlas, and Pulse sections. |
| Seller-only ownership | Working | Each seller endpoint/detail returned only its own order lines. |
| Per-seller shipping | Working | Each buyer section showed that seller's free shipping and five-day estimate in the tested stores. |
| Independent seller status | Working | Pulse reached Shipped without advancing Nova or Atlas. |
| Aggregate status | Working | Buyer aggregate remained conservative until all portions reach the next lifecycle boundary. |
| Seller-specific notification | Working | Pulse's shipment message named only Yoga Mat and Rs4,250.00 PKR. |
| Whole-order cancellation after shipment | Working | Cancel button disappeared and explanatory text appeared after one seller shipped; server guard also rejects the mutation. |
| Partial COD delivery | Working | Delivered seller revenue can be recognized, but global COD remains unpaid until every seller allocation is delivered. |
| Final COD delivery | Working | Broader B6 proof changed global COD to Paid only after the remaining seller delivered. |

## Confirmation, Cancellation, Email, WhatsApp, and In-App Notifications

| Flow | Final result | Live evidence |
|---|---|---|
| Email confirmation | Working | B1 confirmed from the secure email landing flow and completed delivery. |
| Email cancellation | Working | B4 cancelled through the secure email landing flow. |
| Two email buttons | Working | R5 rendered separate Confirm and Cancel buttons. |
| Safe email GET | Working | Opening R5's link showed a decision page but did not mutate the pending order. |
| WhatsApp confirmation | Working | B3, B5, and B6 confirmed through production webhook actions. |
| WhatsApp cancellation | Working | B2, R2, and R3 cancelled through the decision path. |
| Dashboard cancellation | Working | B7, B8, R4, and R5 cancelled as the dedicated buyer. |
| Cancelled payment display | Working | Cancelled COD order detail now shows Unpaid and Nothing charged; the payment subsection no longer says Pending. |
| Seller email/WhatsApp audit | Working | R3 seller detail matched the messages observed in Mailinator and the admin test inbox. |
| Buyer lifecycle notifications | Working | Processing, Shipped, Delivered, Cancelled, and seller-specific shipment notifications were observed. |
| Seller notifications | Working | New order, buyer decision, cancellation, delivery, and return request were seller-scoped. |
| Cross-channel replay handling | Working | After email cancellation, an old WhatsApp Confirm prompted an explicit reconfirm choice instead of silently reversing state. |

## Coupon Cancellation and Historical Repair

### New orders

The fixed lifecycle is transactional:

- Unpaid cancellation releases reserved or consumed coupon capacity.
- Reconfirm reacquires and consumes capacity under current limits.
- Inventory, order state, and coupon state commit together.
- If another buyer legitimately takes the final use before reconfirm, reconfirm fails and rolls back rather than oversubscribing the coupon.

R4 proved release in the live UI: 0/1 → 1/1 → 0/1.

### Historical production data

The repair script defaults to dry-run and targets only coupon redemptions whose order is both `cancelled` and `isPaid: false`.

Production execution:

1. Dry-run found exactly one order: `ORD-1788037049051-C4A514191365843DFDAF`.
2. Write mode processed exactly one order and released exactly one redemption.
3. A second dry-run returned `candidateOrders: 0`.

No active, paid, delivered, or non-cancelled order was selected.

Result: **Runtime behavior fixed, live UI verified, historical production data repaired, and idempotent zero-candidate verification completed.**

## Dashboard and Analytics Reconciliation

Observed analytics demonstrate the intended recognition rules:

| Store | Inspected recognized result | Reconciliation |
|---|---|---|
| Nova Nest Market | $17.92 revenue, 2 recognized orders, $8.96 average, 2 units | $11.84 + $6.08 = $17.92; cancellations added no revenue. |
| Atlas Aura Goods | $71.51 revenue, 2 recognized orders, $35.76 displayed average, 2 units | Frozen delivered product allocations were $42.01 and $29.50; seller-only top products matched. |
| Pulse Peak Gear | $5.22 recognized revenue at the inspected snapshot, 1 recognized order, 1 unit | Delivered Steel Shaker counted; later cancelled pending orders did not add revenue. |
| Karachi Craft Co | $8.96 recognized revenue, 1 recognized order, 1 unit at its inspected snapshot | Delivered Handwoven Canvas Tote counted; cancelled rows did not. |

Important interpretation:

- Seller overview **Total Orders** can include cancelled operational orders.
- Analytics **Recognized Orders** and recognized revenue include qualifying delivered COD seller allocations.
- Pending, Confirmed, Processing, Shipped, and Cancelled COD allocations do not become recognized revenue merely because an order exists.
- A seller allocation can be delivered and recognized before the final seller delivers, while global COD still remains unpaid.
- Buyer total spent excludes cancelled orders.

Result: **The inspected counts, units, averages, top products, and recognized revenue reconciled to their underlying delivered seller allocations.**

## Review and Return Coverage

The broader live run also completed post-delivery behavior:

- A five-star Insulated Steel Bottle review was submitted and appeared in seller Top Rated Products.
- A return was created within the displayed 14-day eligibility window.
- The correct seller received the return request.
- The seller rejected it with an audit note.
- The buyer saw the rejection in order detail and notifications.
- No wallet balance or refund was created, honoring the explicit wallet exclusion.

Result: **Working in the tested non-wallet rejection path.**

## WhatsApp Test Pool: What Is and Is Not Proven

The production application now has 50 fixed reserved test numbers from +1 202-555-0100 through +1 202-555-0149.

Verified:

- Admin-only inbox access.
- OTP capture and normal OTP verification; OTP was not bypassed.
- Outbound order and lifecycle message generation.
- Confirm/Cancel button payload handling through the production webhook path.
- Free-form inbound AI routing for linked buyer and seller accounts.
- Unlinked boundary-number guidance.
- Normal, non-reserved recipients remain on the original Evolution API transport path through automated coverage.

Important limitation:

These +1 202-555-01xx values are fictional application test numbers, not 50 independently registered WhatsApp devices. The admin inbox proves Rozare's application generation, capture, webhook, decision, and AI paths. It cannot honestly prove Meta/telecom delivery to a physical WhatsApp handset for every fictional number. External network/device delivery requires real WhatsApp-registered numbers.

Result: **Application-level WhatsApp test infrastructure is working; physical carrier/device delivery for fictional numbers is not claimed.**

## Defect Closure Ledger

| Defect | Original symptom | Fix | Final proof |
|---|---|---|---|
| D-01 seller email audit | Seller said email not sent although Mailinator received it. | `9648a7f` durable delivery metadata | R3 seller detail showed Email and WhatsApp sent. |
| D-02 cancelled COD payment label | Top showed Unpaid but Payment Details said Pending. | Buyer presentation derives cancelled COD as Unpaid. | R4/R5 displayed Cancelled, Unpaid, Nothing charged. |
| D-03 post-shipment cancel UX | Button remained visible although server rejected cancellation. | Seller-group-aware cancel gating and explanation. | R1 after Pulse shipped: zero cancel buttons and explicit explanation. |
| D-04 email button layout | One generic decision link instead of two direct actions. | `a707a47` two scanner-safe intent links. | R5 Mailinator email rendered Confirm and Cancel separately; GET did not mutate. |
| D-05 coupon usage after cancellation | Unpaid cancellation left coupon use consumed. | `8d09c34` transactional release/reacquire plus `3bb8157` backfill. | R4 live 1/1 → 0/1; historical repair 1 candidate → 1 release → 0 candidates. |
| Admin product crash | One corrupt money row returned a page-level error. | `f50f53a` row isolation. | 309 rows loaded; corrupt row safely marked unavailable. |

All defects found in this focused run are closed within the tested scope.

## Automated Validation

| Validation | Result |
|---|---|
| Backend full regression after the final runtime behavior changes | 199 suites, 2,877 tests passed, 0 failed |
| Coupon/cancellation focused suite | 28/28 passed |
| Email decision and order presentation focused suites | 74/74 passed |
| Historical repair script syntax and repository diff checks | Passed |
| Historical production repair | Dry-run 1 candidate; write 1 order/1 redemption; final dry-run 0 candidates |
| Frontend regression from the live change set | 175/175 tests passed |
| Frontend production build/prerenders | Passed |
| Production backend health | `status: ok`, production, Mongo connected, outbox worker started |

Automated tests support but do not replace the live browser observations documented above.

## Not Claimed or Excluded

The following were not part of the requested completed mutation matrix:

- Stripe/card checkout, capture, refund, dispute, or payout.
- Rozare Wallet funding, payment, or refund.
- Native mobile app behavior.
- Physical WhatsApp-device delivery to fictional +1 202-555-01xx numbers.
- Destructive attacks against production authorization controls.
- Subscription payment, ad purchase, saved-card mutation, and subdomain purchase.

These exclusions must not be interpreted as failures; they were outside this authorized COD/browser scope.

## Local Workspace Changes

At the point immediately before adding this authoritative report, the remaining local-only user-owned files were:

1. `LIVE_BUYER_SELLER_E2E_REPORT_2026-08-29.md`
   - Modified documentation draft only.
   - Approximately 285 inserted lines and 98 deleted lines relative to Git.
   - It reorganizes the earlier executive result, deployment evidence, WhatsApp controls, catalog, order matrix, ownership, analytics, notifications, return/coupon coverage, and defect ledger.
   - It contains pre-fix defect wording, so it was deliberately not committed or treated as the current authoritative report.
   - It does not change backend, frontend, database, or deployed behavior.

2. `test-assets/live-e2e-2026-08-29/`
   - Four generated catalog fixture images:
     - `atlas-aura-catalog.png` — 2,895,412 bytes
     - `karachi-craft-catalog.png` — 3,326,835 bytes
     - `nova-nest-catalog.png` — 2,379,697 bytes
     - `pulse-peak-catalog.png` — 2,582,700 bytes
   - Total: 11,184,644 bytes, approximately 10.67 MiB.
   - These were used as upload/catalog test assets.
   - They are untracked, were not pushed, and are not application code.

This new `LIVE_MULTI_SELLER_ORDER_TRIAL_E2E_REPORT_2026-08-30.md` is the current authoritative report and is intended to be committed. The older draft and generated assets remain untouched.

## Final Classification

| Area | Final status |
|---|---|
| Dedicated buyer/seller identity use | Working |
| Admin-configurable trial duration | Working |
| Admin dashboard error containment | Working |
| Compact new order IDs | Working |
| Seller-scoped order visibility | Working |
| Buyer seller-split order detail | Working |
| Independent seller fulfillment/status | Working |
| Seller-specific buyer notifications | Working |
| PKR buyer with USD seller | Working; exact values frozen in PKR |
| USD buyer with mixed PKR/USD sellers | Working; exact values frozen in USD |
| PKR buyer with mixed PKR/USD sellers | Working; exact values frozen in PKR |
| Product option requirement and persistence | Working |
| Per-seller shipping and totals | Working |
| Aggregate order reconciliation | Working |
| Historical FX immutability | Working |
| COD unpaid/paid and revenue timing | Working |
| Email Confirm/Cancel buttons | Working and scanner-safe |
| WhatsApp decisions and application routing | Working |
| In-app buyer/seller notifications | Working |
| Coupon cancellation restoration | Working |
| Historical coupon data repair | Complete; zero remaining candidates |
| Reviews | Working |
| Non-wallet rejected return | Working |

## Live Evidence Intentionally Retained

- Four seller accounts and stores.
- One dedicated buyer account.
- Twenty products with store and product imagery.
- Thirteen COD orders and their audit histories.
- Inactive test coupons retained where useful for audit.
- One five-star review.
- One rejected return request with no wallet refund.
- Virtual WhatsApp OTP, outbound, action, inbound, and AI audit records.

No passwords, OTP codes, private keys, access tokens, database credentials, or confirmation tokens are included in this report.
