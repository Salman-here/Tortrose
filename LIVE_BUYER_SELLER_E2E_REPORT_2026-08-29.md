# Rozare Live Buyer and Seller End-to-End Test Report

- Test date: 2026-08-29 (Asia/Karachi)
- Target: `https://rozare.com` and its production API
- Payment scope: Cash on Delivery only
- Excluded by request: Stripe card payments and wallet payments
- Working definition: A feature is marked **Working** only after its live browser flow and authoritative resulting state are verified.
- Status legend: **Working**, **Not Working**, **Blocked**, **Not Run**

## Safety and Test-Data Controls

| Control | Status | Evidence / notes |
|---|---|---|
| Real WhatsApp recipients are not used for synthetic testing | Working (local) | The only eligible virtual recipients are the fixed fictional NANP range +1 202-555-0100 through +1 202-555-0149. Live deployment verification remains pending. |
| Normal WhatsApp recipients remain on Evolution API | Working (local) | Transport tests prove that only active database records in the fixed range are intercepted; a normal number continues through the original Evolution API request path. |
| WhatsApp OTP is still verified rather than bypassed | Working (local) | The normal OTP endpoint and verification endpoint remain unchanged. The transport captures the normal outbound OTP for an active test number, and the browser must submit that generated OTP. |
| Admin-only access to OTPs and captured messages | Working (local) | Every pool, inbox, and action endpoint is protected by both token and admin middleware; the frontend route also uses the admin protected-route guard. Live authorization checks remain pending. |
| No credentials or OTPs committed to Git | Working | This report does not store passwords, session tokens, or OTP values. |

## Production Change Verification

| Check | Status | Evidence / notes |
|---|---|---|
| Current baseline identified | Working | Clean `main` at `8a20650f6f310530dd589e28ea69c53ca78ad833`. |
| Backend test-number pool and virtual transport | Working (local) | Implemented on `codex/whatsapp-test-inbox-e2e`; fixed pool is idempotently provisioned and inactive entries fail closed. |
| Admin WhatsApp test inbox | Working (local) | Admin can provision/toggle the pool, inspect OTPs/messages, filter by number, and submit only actions present in a captured message through the existing guarded webhook decision path. |
| Local backend regression tests | Working | WhatsApp-focused Jest run: 16 suites, 88 tests passed. Complete backend Jest run: 195 suites, 2,844 tests passed. |
| Frontend build and lint | Working (local) | Full Vite production build, both SSR bundles, and both prerenders passed. ESLint passed with zero errors and 11 pre-existing warnings outside this change. Frontend regression tests: 174/174 passed. |
| Production backend deployment | Not Run | Pending validation. |
| Production frontend deployment | Not Run | Pending validation. |
| Live backend health/version | Not Run | Pending deployment. |

## Accounts and Stores

| Account / store | Currency | Location | WhatsApp test number | Status | Evidence / notes |
|---|---:|---|---|---|---|
| `rozare.seller.82901@mailinator.com` / Nova Nest Market | PKR | Pakistan | +1 202-555-0101 | In progress | Email account created live; seller onboarding paused at WhatsApp OTP before test-inbox deployment. |
| PKR seller 2 | PKR | Pakistan | To assign | Not Run | |
| PKR seller 3 | PKR | Pakistan | To assign | Not Run | |
| USD seller | USD | Pakistan | To assign | Not Run | Required for cross-currency tests. |
| Buyer account(s) | PKR / USD | Pakistan | To assign | Not Run | |

## Catalog and Storefront Coverage

| Check | Status | Evidence / notes |
|---|---|---|
| Store name, description, slug, logo, and location | Not Run | |
| Five products per PKR seller | Not Run | |
| Product images, descriptions, category, stock, and PKR pricing | Not Run | |
| Five products for USD seller | Not Run | |
| USD native prices displayed/converted correctly for PKR buyer | Not Run | |
| Product detail, marketplace search/filter, store page, cart, and wishlist | Not Run | |

## COD Order Scenarios

| Scenario | Status | Evidence / notes |
|---|---|---|
| One product from one seller | Not Run | |
| Three products from one seller | Not Run | |
| Products from two sellers in one checkout | Not Run | |
| Products from all three PKR sellers in one checkout | Not Run | |
| PKR buyer ordering from USD seller | Not Run | |
| USD buyer ordering from PKR and USD sellers | Not Run | |
| Buyer email confirmation action | Not Run | |
| Buyer WhatsApp confirm action | Not Run | |
| Buyer WhatsApp cancel action | Not Run | |
| Buyer account/dashboard cancellation | Not Run | |

## Ownership, Money, and Dashboard Checks

| Check | Status | Evidence / notes |
|---|---|---|
| Each seller sees only their own items/fulfillment in multi-seller orders | Not Run | |
| Buyer sees complete multi-seller order and correct line totals | Not Run | |
| Seller subtotal, shipping, tax, discount, and total allocations reconcile exactly | Not Run | |
| COD revenue excluded before seller delivery | Not Run | |
| COD revenue recognized after that seller's delivery | Not Run | |
| Cancelled seller fulfillment excluded from revenue | Not Run | |
| Seller Home metrics reconcile to orders | Not Run | |
| Seller Analytics metrics reconcile to authoritative order data | Not Run | |
| Admin totals reconcile to buyer and seller views | Not Run | |
| PKR/USD conversions and currency labels remain consistent | Not Run | |

## Notifications and Messaging

| Check | Status | Evidence / notes |
|---|---|---|
| Seller WhatsApp OTP captured and verifiable | Not Run | |
| Buyer WhatsApp OTP captured and verifiable | Not Run | |
| COD WhatsApp message contains Confirm and Cancel actions | Not Run | |
| WhatsApp action passes through guarded live decision path | Not Run | |
| Buyer confirmation email arrives with working action links | Not Run | |
| Seller receives new-order notification | Not Run | |
| Seller receives buyer confirm/cancel update | Not Run | |
| In-app notification records appear for correct audience | Not Run | |
| Normal Evolution gateway status remains healthy | Not Run | Virtual delivery proves application routing, not delivery to a physical WhatsApp device. |

## Post-Fulfillment and Review Coverage

| Check | Status | Evidence / notes |
|---|---|---|
| Seller status transitions: pending → confirmed → processing → shipped → delivered | Not Run | |
| Buyer status and tracking reflect seller transitions | Not Run | |
| Review eligibility is blocked before fulfillment | Not Run | |
| Buyer can write a review after qualifying delivery | Not Run | |
| Review appears on the correct product/store surface | Not Run | |
| Returns/refunds (COD-safe paths only) | Not Run | |

## Additional Buyer and Seller Surface Audit

| Surface | Status | Evidence / notes |
|---|---|---|
| Buyer profile, addresses, currency preference, orders, order details | Not Run | |
| Seller products, inventory, orders, shipping, coupons, notifications | Not Run | |
| Seller store settings, profile, subdomain, subscription/trial status | Not Run | |
| Admin users, products, orders, analytics, WhatsApp queue/test inbox | Not Run | |
| Authorization and blocked-account guards | Not Run | |
| Mobile-specific flows | Blocked | Current request is explicitly live website/browser testing; native mobile app testing is outside this run unless added later. |

## Defects and Follow-up Actions

No final defects recorded yet. Findings will be added with reproducible steps, expected behavior, actual behavior, severity, and evidence.
