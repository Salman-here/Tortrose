# Buyer purchase access after becoming a seller

## Issue and cause

The Android My Orders detail screen returned “You can only view orders containing your products” after the same account became a seller. The error was reproduced in the emulator.

The purchase list already selected orders by the buyer's account id. However, the shared detail endpoint selected its seller-management presentation solely from the current account role. It therefore rejected personal purchases from other stores, even though their purchaser id still matched the signed-in account.

## Changes

- Android and website personal order-detail screens explicitly request `view=buyer`.
- The backend scopes that view to `Order.user === authenticated account id` in the database query. A requested view cannot grant access to someone else's purchase.
- Default management requests retain their existing behavior: sellers see only their own sold items, shipping and allocations; administrative access is unchanged. An explicit seller view requires the seller role.
- This also separates the two views when a seller buys their own product together with another seller's product: My Orders shows the full purchase, while seller management retains only that seller's portion.
- The personal cancellation endpoint now permits seller-account purchasers to cancel their own orders, subject to the same existing payment/fulfillment restrictions. It still refuses another customer's order, even if the requester sold an item in it. No live order cancellation was performed for verification.
- Invoice, re-order and buyer return access already use purchase ownership and were not changed. No stored order, price, exchange rate, fulfillment state, account role or payment provider was rewritten.

## Automated checks

- **46 targeted backend tests passed**, including purchase access before/after role change with the original token, USD/PKR/EUR frozen values, multi-seller/self-purchase view separation, foreign-owner denial, unpaid-checkout privacy, invalid view selectors and cancellation safeguards.
- **28 targeted mobile tests passed**, including an actual buyer detail-screen render with both seller groups and the frozen total.
- **Full mobile suite: 105 suites / 1,191 tests passed.**
- Website buyer/management request-contract check passed; the full website production build and SSR/prerender steps passed.
- **Full backend suite: 234 suites / 3,486 tests passed.** Deployment and live results are recorded below.

## Existing live orders selected for verification

Both records belong to the same account, whose current role is seller. Neither contains that account's own seller products. The store was created at **2026-09-23 18:22:57 UTC**.

| Purchase | Created | Timing | Stored buyer total |
| --- | --- | --- | ---: |
| `ORD-1790175148227` — Resistance Band Set and Jump Rope | 2026-09-23 14:52:28 UTC | Before store creation | PKR 3,480.00 |
| `ORD-1790190258534` — Minimalist Wallet and Travel Tech Pouch | 2026-09-23 19:04:19 UTC | After store creation | PKR 16,486.46 |

These timestamps establish the chosen before/after data cases, not a claim that historical UI behavior was directly observed. Their saved totals will be compared with the updated My Orders screens.

## Deployment and live API checks

- Commit `77a27240` was pushed to both configured GitHub repositories. The backend health endpoint reports `77a27240d2b7877b77eae5665729dbb762a3ba02` with MongoDB connected.
- The live website serves `UserOrderDetail-DT9swv-c.js`, which includes the explicit `?view=buyer` request. This verifies deployed client delivery; the manual UI checks below are Android checks, not a separate browser-session test.
- Android update group `db877532-3fe8-4fcb-a4a0-aa7677768c71`, update `01a0e126-d5a1-7390-8eb4-df9130d6c210`, was published to production channel for runtime **1.0.13**. No native dependency or new APK was needed.
- **Live cross-account denial PASS:** separate existing test buyer and test seller accounts both received HTTP 404 with no order data when requesting the affected account's purchase using `view=buyer`.
- **Existing access preserved PASS:** the known QA buyer still retrieved their own PKR 1,200.00 test order. Its merchant still retrieved the seller-management view, but received HTTP 404 when requesting that customer's buyer view. These checks used authenticated read-only order requests; no order status/payment was changed.
- Activated the update on the existing emulator installation, **Android 1.0.13 (17)**. The same account remained signed in and visibly retained its Seller role.

## Updated Android My Orders — PASS

Opened **all four existing purchases** through Profile → My Orders, without changing accounts or roles. Every detail screen loaded instead of returning the seller-product access error.

| Order | Payment | Saved total matched on the detail screen | Result |
| --- | --- | ---: | --- |
| `ORD-1790175148227` | COD | PKR 3,480.00 | PASS — purchase before store creation |
| `ORD-1790190258534` | COD | PKR 16,486.46 | PASS — purchase after store creation |
| `ORD-1790200478081` | COD | PKR 39,762.61 | PASS — multiple quantities |
| `ORD-1790432771170` | Safepay, paid | PKR 8,306.03 | PASS — latest paid purchase |

For `ORD-1790200478081`, scrolled into the buyer shipment breakdown and saw **Minimalist Wallet ×3**, **Travel Tech Pouch ×2**, all five units, product total **PKR 38,376.96**, shipping **PKR 1,385.65**, and total **PKR 39,762.61**. These were buyer checkout values, not a seller-management allocation. The existing return-eligibility section loaded as well.

No live order was placed, cancelled, refunded or otherwise changed in this verification. Cancellation behavior was checked through automated authorization/transition tests, not by cancelling the user's existing purchases. No account role or original currency snapshot was modified.
