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
- **Full backend suite: 234 suites / 3,486 tests passed.** Deployment and updated live UI verification are pending at this checkpoint.

## Existing live orders selected for verification

Both records belong to the same account, whose current role is seller. Neither contains that account's own seller products. The store was created at **2026-09-23 18:22:57 UTC**.

| Purchase | Created | Timing | Stored buyer total |
| --- | --- | --- | ---: |
| `ORD-1790175148227` — Resistance Band Set and Jump Rope | 2026-09-23 14:52:28 UTC | Before store creation | PKR 3,480.00 |
| `ORD-1790190258534` — Minimalist Wallet and Travel Tech Pouch | 2026-09-23 19:04:19 UTC | After store creation | PKR 16,486.46 |

These timestamps establish the chosen before/after data cases, not a claim that historical UI behavior was directly observed. Their saved totals will be compared with the updated My Orders screens.
