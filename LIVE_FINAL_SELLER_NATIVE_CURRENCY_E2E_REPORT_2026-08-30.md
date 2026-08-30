# Rozare Final Seller-Native Currency and Buyer/Seller Live E2E Report

**Test date:** August 30, 2026

**Environment:** Live production website at `https://rozare.com`

**Backend release verified:** `5122ff9270023e33cac1cc076fdf9690929e6449`

**Railway deployment:** `3daacc28-74eb-4ff1-870e-dc008e2b0791`

**Overall result:** **PASS for the tested buyer, seller, admin, COD, currency-freezing, notification, and order-splitting flows**

## 1. Executive conclusion

The requested seller-native order-money design is implemented and verified on the live website.

- A buyer sees and permanently keeps the order amounts in the currency used at checkout.
- Each seller sees the seller's part of that same order primarily in the seller store's own frozen currency.
- The seller also sees the frozen buyer-currency equivalent for reconciliation.
- Product price, selected options, seller shipping, seller adjustment, seller total, buyer allocation, and the exchange rate used at checkout are stored with the order. Old orders do not change when a later exchange rate changes.
- One buyer order containing several sellers is split visibly into seller shipments. Each seller sees only that seller's products and money. The buyer sees each seller's items, shipping, delivery estimate, status, and allocation separately.
- Seller statuses can change independently. The buyer sees the correct status on the correct seller group and receives a separate notification for each seller transition.
- New orders use short IDs such as `ORD-1788112641895`. Historical orders retain their old long IDs so external links and records are not broken.
- Product options are preserved. In the mixed PKR order, the buyer selected **Walnut** and the Nova seller saw **Walnut** on the seller order detail page.
- Admin order cancellation now performs the action with one click and no browser confirmation alert.
- Buyer, seller, email, WhatsApp test inbox, public confirmation page, and admin order detail all report the actual cancellation actor.

No Stripe or wallet payment was executed because the requested test scope explicitly excluded online payments. All placed orders used COD.

## 2. What "live conversion" and "frozen conversion" mean

Before an order is placed, a product remains stored in its seller currency. When a buyer views it in another currency, Rozare calculates a display amount from the current exchange rate available to the application for that request. That display value is not permanently written back onto the product. The rate provider may cache rates, so "live" means the current application rate, not a price that changes every second on screen.

At checkout, the behavior changes:

1. Rozare prices the complete checkout in the buyer's selected currency.
2. Rozare allocates the buyer total to sellers in exact minor units so the allocations add up to the charged/order total.
3. Rozare stores the buyer-currency totals and the rate used.
4. Rozare also stores each seller's product, shipping, adjustment, and total in the seller store's currency.
5. All later order pages and notifications read those saved snapshots. They do not recalculate an old order from a new rate.

This gives both parties a stable commercial record:

| Party | Primary amount shown | Additional reconciliation information |
|---|---:|---|
| Buyer | Frozen checkout currency | Seller-by-seller buyer allocations |
| Seller | Frozen store currency | Frozen buyer-currency equivalent and checkout rate context |
| Admin | Buyer order totals plus seller allocations | Seller-native values for audit |

Example: a USD seller lists a product for `$29.50` and charges `$5.00` shipping. A PKR buyer checked out at the frozen rate `1 USD = 277.86 PKR`.

- The buyer permanently sees `Rs8,196.87` product + `Rs1,389.30` shipping = `Rs9,586.17 PKR`.
- The seller permanently sees `$29.50` product + `$5.00` shipping = `$34.50 USD`.
- The seller can also see the buyer equivalent of `Rs9,586.17 PKR`.

This is preferable to showing the seller only PKR: the seller's catalog, operational expectations, revenue interpretation, and order record remain in the seller's chosen currency while the buyer still has an immutable PKR purchase record.

## 3. Live test identities and catalog

Testing used dedicated Mailinator-backed accounts, not the administrator account for purchases.

| Identity | Role in testing | Store/currency coverage | Result |
|---|---|---|---|
| Dedicated buyer | Buyer | PKR and USD checkouts | PASS |
| Nova Nest | Seller | PKR store, paid shipping, option product | PASS |
| Pulse Peak | Seller | PKR store, free shipping | PASS |
| Atlas Aura | Seller | USD store, paid USD shipping | PASS |
| Karachi Craft | Additional seller/credential coverage | Five-product seller dashboard | PASS |

The primary sellers had five test products each. Product imagery was visible on the live marketplace cards. The test accounts now use the common test credential requested by the owner; the credential itself is intentionally omitted from this report.

The Karachi seller initially did not accept the common credential. I used the real live **Forgot password** flow, received the reset email in Mailinator, opened the live reset link, set the requested test credential, and verified a successful browser login. The live seller dashboard then showed the correct active identity, five products, and seller navigation. No reset token is recorded here.

## 4. Seller shipping configurations used

| Seller | Shipping used | Price | Delivery estimate | Live result |
|---|---|---:|---:|---|
| Nova Nest | Standard | `Rs300.00 PKR` | 3 days | Applied only to Nova's shipment |
| Atlas Aura | Standard | `$5.00 USD` | 2 days | Frozen in USD and converted into buyer allocation |
| Pulse Peak | Free | `Rs0.00 PKR` | 5 days | No shipping added |

An inactive paid shipping slot with no price had previously blocked saving otherwise valid shipping configuration. The backend now permits an inactive slot without a price while continuing to validate active methods. This was fixed in `ac09cc0` and covered by backend tests.

## 5. Live order calculation matrix

### 5.1 Single USD seller ordered by a PKR buyer

**Order:** `ORD-1788106369523`

**Seller:** Atlas Aura

**Frozen rate:** `1 USD = 277.86 PKR`

| Component | Buyer record | Seller record |
|---|---:|---:|
| Minimalist Wallet | `Rs8,196.87 PKR` | `$29.50 USD` |
| Standard shipping | `Rs1,389.30 PKR` | `$5.00 USD` |
| Seller/order allocation | `Rs9,586.17 PKR` | `$34.50 USD` |

Arithmetic checked:

- `29.50 × 277.86 = 8,196.87`
- `5.00 × 277.86 = 1,389.30`
- `8,196.87 + 1,389.30 = 9,586.17`
- `29.50 + 5.00 = 34.50`

**Result: PASS.** Buyer and seller saw the correct frozen amounts in their respective currencies. Email cancellation worked without a browser popup, and buyer/seller WhatsApp test messages contained the correct frozen values.

### 5.2 Three sellers, buyer checks out in PKR

**Order:** `ORD-1788106779679`

**Database record:** `6a94581bd3a7230da141cd60`

**Payment:** COD

**Confirmation:** Buyer confirmed through the WhatsApp test action

#### Buyer calculation

| Seller | Product subtotal | Shipping | Buyer seller-group total |
|---|---:|---:|---:|
| Nova Nest | `Rs2,250.00` | `Rs300.00` | `Rs2,550.00` |
| Atlas Aura | `Rs8,196.87` | `Rs1,389.30` | `Rs9,586.17` |
| Pulse Peak | `Rs1,450.00` | `Rs0.00` | `Rs1,450.00` |
| **Order total** | **`Rs11,896.87`** | **`Rs1,689.30`** | **`Rs13,586.17 PKR`** |

Arithmetic checked:

- Products: `2,250.00 + 8,196.87 + 1,450.00 = 11,896.87`
- Shipping: `300.00 + 1,389.30 + 0.00 = 1,689.30`
- Total: `11,896.87 + 1,689.30 = 13,586.17`

#### What each seller saw

| Seller | Seller-native record | Buyer equivalent | Isolation result |
|---|---:|---:|---|
| Nova Nest | `Rs2,250.00 + Rs300.00 = Rs2,550.00 PKR` | `Rs2,550.00 PKR` | Only Nova item |
| Atlas Aura | `$29.50 + $5.00 = $34.50 USD` | `Rs9,586.17 PKR` | Only Atlas item |
| Pulse Peak | `Rs1,450.00 + Rs0.00 = Rs1,450.00 PKR` | `Rs1,450.00 PKR` | Only Pulse item |

The Nova product option selected by the buyer was **Walnut**. The seller order detail displayed **Walnut** correctly.

Independent seller statuses were set to:

- Nova Nest: **Delivered**
- Atlas Aura: **Processing**
- Pulse Peak: **Shipped**

The buyer order remained one order but showed three separate seller sections with their own products, shipping, delivery timing, totals, and statuses. Each seller saw only its own section. Separate status notifications remained visible after the notification identity fix in `4862629`.

**Result: PASS.** Exact order reconciliation, seller isolation, selected option persistence, shipping separation, and independent status tracking all matched the expected values.

### 5.3 Three sellers, buyer checks out in USD

**Order:** `ORD-1788107800861`

**Database record:** `6a945c18d3a7230da141f9c1`

**Payment:** COD

**Confirmation:** Buyer confirmed through email

#### Buyer calculation

| Component | Frozen buyer amount |
|---|---:|
| Product subtotal | `$46.37 USD` |
| Shipping | `$6.08 USD` |
| **Order total** | **`$52.45 USD`** |

Seller-group allocations were:

| Seller | Frozen buyer allocation |
|---|---:|
| Nova Nest | `$7.16 USD` |
| Atlas Aura | `$29.99 USD` |
| Pulse Peak | `$15.30 USD` |
| **Total** | **`$52.45 USD`** |

#### Seller-native calculation

| Seller | Native calculation | Buyer equivalent |
|---|---:|---:|
| Nova Nest | `Rs1,690.00 + Rs300.00 - Rs0.52 allocation adjustment = Rs1,989.48 PKR` | `$7.16 USD` |
| Atlas Aura | `$24.99 + $5.00 = $29.99 USD` | `$29.99 USD` |
| Pulse Peak | `Rs4,250.00 + Rs1.26 allocation adjustment = Rs4,251.26 PKR` | `$15.30 USD` |

The small `-Rs0.52` and `+Rs1.26` values are explicit exact-cent reconciliation adjustments. They are saved and displayed instead of hiding a rounding mismatch. Buyer seller allocations add to the order total exactly; seller-native totals remain internally auditable.

**Result: PASS.** Mixed PKR sellers and a USD seller reconciled exactly into a USD buyer order while preserving each seller's own frozen currency.

### 5.4 Fresh post-deployment USD order and cancellation-actor regression

**Order:** `ORD-1788112641895`

**Database record:** `6a946f0265ee74f2424cc729`

**Seller:** Atlas Aura

**Buyer currency:** USD

**Payment:** COD

| Component | Buyer | Seller |
|---|---:|---:|
| Travel Tech Pouch | `$24.99 USD` | `$24.99 USD` |
| Standard shipping | `$5.00 USD` | `$5.00 USD` |
| **Total** | **`$29.99 USD`** | **`$29.99 USD`** |

Live sequence:

1. The dedicated buyer placed the order in the live browser.
2. Mailinator received the order-confirmation email with `$29.99`, Confirm, and Cancel links.
3. The buyer opened the public link and confirmed through email. No browser dialog appeared.
4. Admin detail showed **confirmed via email** and the correct `$24.99 + $5.00 = $29.99` calculation.
5. Admin clicked **Cancel Order** once. There was no JavaScript alert or second confirmation modal.
6. Admin detail showed **Cancelled by administrator (was confirmed by buyer via email)**.
7. Buyer detail showed **Order cancelled by a Rozare administrator**, noted the earlier email confirmation, and correctly stated that nothing had been charged.
8. Atlas seller detail showed only the Atlas item, the frozen USD summary, `$24.99 + $5.00 = $29.99`, and administrator attribution.
9. Buyer and seller in-app notifications showed administrator attribution and `$29.99`.
10. Buyer and seller WhatsApp test-inbox messages showed administrator attribution and `$29.99`.
11. The cancellation email showed administrator attribution, the COD/no-refund-needed explanation, and `$29.99`.
12. A fresh load of the public decision page showed the administrator cancellation, did not show the stale phrase **Order confirmed!**, and no longer offered Confirm or Cancel actions.

**Result: PASS.** This is the final live proof on the exact deployed commit `5122ff9`.

## 6. Buyer dashboard behavior

Verified on live buyer order details:

- One order is retained as one buyer purchase.
- Products are grouped by seller.
- Each group shows the seller/store, only that seller's items, selected product options, seller shipping amount, delivery estimate, seller allocation, and current seller status.
- The order summary equals the sum of every seller group.
- The buyer sees the frozen checkout currency, not a later FX recalculation.
- A status change by one seller does not incorrectly relabel the other seller groups.
- Administrator cancellation is distinguished from buyer or seller cancellation.
- COD orders that were never collected do not claim that money was refunded.

**Buyer dashboard verdict: PASS.**

## 7. Seller order behavior

Verified on live seller order details:

- A seller sees only products belonging to that seller.
- Buyer-selected options are visible to the correct seller.
- The primary summary is the seller store's currency captured at checkout.
- Product subtotal, shipping, adjustment, and seller total are separate and add correctly.
- The buyer-currency equivalent remains visible for reconciliation.
- Seller status changes apply only to that seller's shipment.
- Seller notifications identify the correct actor and frozen values.
- A USD seller receiving a PKR buyer order sees USD as the primary amount, not a newly converted PKR operational amount.

**Seller order verdict: PASS.**

## 8. Dashboard and analytics checkpoints

Nova's live analytics were checked around the delivered mixed-seller order.

| Metric | Before/expected transition | Observed result |
|---|---:|---:|
| Recognized revenue | `Rs4,980 + Rs2,550 delivered COD` | `Rs7,530 PKR` |
| Recognized orders | `2 + 1 delivered order` | `3` |
| Average recognized order | `7,530 / 3` | `Rs2,510 PKR` |
| Units in recognized orders | Expected | `3` |
| Delivered COD | Expected | `Rs7,530 PKR` |
| Pending COD estimate | Expected | `Rs2,250 PKR` |
| Estimated total | `7,530 + 2,250` | `Rs9,780 PKR` |
| Withdrawable | No settled withdrawable money expected | `Rs0` |

Nova's home dashboard showed revenue `Rs7,530`, 8 total orders, 5 products, 38% conversion, 3 delivered, and 1 processing at that checkpoint. The order-money test treats delivered COD as recognized revenue and does not treat an uncollected or cancelled COD as paid settlement.

The final Karachi credential check opened the correct live seller dashboard and showed an active seller, 5 products, 3 historical orders, `$8.96` visible dashboard revenue, 33% conversion, and 1 delivered order. This check was for identity/access continuity; the controlled arithmetic proofs are the four orders in Section 5.

**Dashboard/analytics verdict: PASS for the controlled checkpoints.** Wallet withdrawal and Stripe settlement were intentionally outside this test.

## 9. Product option and review coverage

- The option-bearing Bamboo Desk Organizer required choosing an option before adding it.
- The buyer selected **Walnut**.
- The buyer order page and Nova seller order page both retained **Walnut**.
- After Nova's seller shipment was delivered, the buyer submitted a 5-star review.
- The product page showed one review.

**Result: PASS.**

## 10. Email, WhatsApp, and in-app notification coverage

### Email

- Order-confirmation email arrived in Mailinator.
- The email showed the correct frozen order total.
- Confirm and Cancel links were present for eligible COD orders.
- Confirmation through email worked without a browser alert.
- Cancellation email identified the actual actor.
- Public decision pages became terminal after a decision and did not expose usable repeat actions.

### WhatsApp test pool and admin inbox

- The 50-number pool contains the fictional test range `+1 202-555-0100` through `+1 202-555-0149`.
- The admin inbox showed 50/50 active test numbers and the assigned test identities.
- Outbound OTP/order/action/AI test traffic for allowlisted test identities is intercepted into the admin test inbox.
- Buyer confirmation actions and buyer/seller order lifecycle messages were observed in the admin inbox.
- Real phone numbers remain on the normal Evolution/WhatsApp delivery path.

These 50 numbers are a **virtual test transport**, not real carrier-owned WhatsApp lines. They can receive the application's WhatsApp payloads inside the admin test inbox, including test OTP and lifecycle traffic, but the report does not claim Meta/carrier delivery to physical phones. That distinction prevents a test harness from being mistaken for real-world WhatsApp deliverability.

### In-app notifications

- Buyer and seller notifications contained correct frozen currency values.
- Each seller status event remained separately visible after the notification-key fix.
- Admin/buyer/seller cancellation attribution matched the persisted actor.
- The buyer notification for the final regression order explicitly said an administrator cancelled it.

**Notification verdict: PASS for application generation, routing, display, and test-inbox actions. Physical WhatsApp handset delivery was not applicable to the fictional pool.**

## 11. Admin coverage

### Configurable trial period

The admin trial control supports:

- Any positive duration entered by admin.
- Unit selection between **Days** and **Months**.
- **Reset** semantics: start a new duration from now.
- **Extend** semantics: add duration to the applicable current end.
- A preview before applying the change.
- Calendar-month calculation for months rather than assuming every month has 30 days.

Live test: admin reset Pulse Peak to **1 month**. The resulting trial end was **September 30, 2026**, and the seller card showed **1-Month Free Trial** and active status.

**Result: PASS.**

### Admin order cancellation

- The cancellation control no longer opens a confirmation alert/modal.
- One click performs the action and shows success feedback.
- The persisted actor is `administrator` when admin performs the cancellation.
- Buyer and seller surfaces, email, WhatsApp, and public pages use that actor.

**Result: PASS on the final deployed order.**

## 12. Order ID behavior

New live orders created during this verification used the requested short form:

- `ORD-1788106369523`
- `ORD-1788106779679`
- `ORD-1788107800861`
- `ORD-1788110665570`
- `ORD-1788112641895`

Historical order IDs with the old random suffix remain visible. They were intentionally not rewritten because IDs can be referenced by emails, notifications, exports, customer support records, and external links. New-order behavior is corrected without making historical records unreachable.

**Result: PASS for all newly created orders.**

## 13. Defects found during live testing and resolution

| Defect observed | User-visible risk | Resolution | Final state |
|---|---|---|---|
| Seller order values were primarily buyer currency | USD seller could not operate from its native price record | Added immutable seller-native snapshots and seller presentation | Fixed/live |
| Inactive paid shipping slot required a price | Valid active shipping configuration could not save | Validate price only where required for an active method | Fixed/live |
| Multiple seller-status notifications collapsed | Buyer could lose one seller's transition | Use seller/status-aware notification identity | Fixed/live |
| Admin cancel opened confirmation UI | Added unnecessary interaction and caused automation confusion | Direct one-click cancel with success feedback | Fixed/live |
| Cancellation origin was not reliably persisted | Admin cancellation could appear neutral/incorrect | Persist and propagate buyer/seller/admin/system actor | Fixed/live |
| Buyer lifecycle message remained neutral after admin cancel | Buyer did not know who cancelled | Actor-aware email, WhatsApp, in-app, and push wording | Fixed/live |
| Public decision page retained stale confirmation text after later cancel | Page could say both confirmed and cancelled | Terminal-state presentation now derives from current order state | Fixed/live |
| Karachi seller credential differed from requested test credential | Shared test-account login failed | Used live email reset flow and reverified seller login/dashboard | Fixed/live |
| Historical IDs are long | Older records retain previous format | Preserve history; short format applies to new orders | Accepted compatibility behavior |

## 14. Implementation commits now on `main`

### WhatsApp test foundation

| Commit | Change |
|---|---|
| `ef75f23` | Added the isolated 50-number WhatsApp test pool and admin test inbox while retaining the real Evolution path for non-test numbers. |
| `03542e6` | Bound seller WhatsApp OTP flow to the authenticated account so an existing buyer cannot accidentally verify a different identity. |
| `31254f8` | Added inbound test messages and AI-response capture to the WhatsApp admin inbox. |

### Order split, trial, and prior correctness foundation

| Commit | Change |
|---|---|
| `a35fb38` | Added arbitrary trial-day/month controls and seller-split order tracking. |
| `9da8d26` | Kept buyer lists resilient when a legacy order has an invalid total. |
| `f50f53a` | Kept the admin product dashboard resilient to corrupt legacy money. |
| `05023c9` | Preserved buyer-selected product options in order views. |
| `11f32de` | Kept frozen order line prices consistent. |
| `9648a7f` | Recorded COD confirmation-delivery state accurately. |
| `8d09c34` | Released coupons when unpaid orders are cancelled. |
| `a707a47` | Added scanner-safe COD email decision buttons. |
| `3bb8157` | Added repair behavior for coupons on cancelled orders. |

### Final seller-native currency and live-test corrections

| Commit | Change |
|---|---|
| `47e4286` | Added seller-native order snapshots, exact-cent seller allocations, backend validation, notifications, exports, analytics integration, and web/mobile seller presentation. |
| `ac09cc0` | Allowed inactive shipping methods without a price while retaining active-money validation. |
| `4862629` | Preserved each seller-specific status notification in the web inbox. |
| `efa4ef0` | Removed the admin cancellation confirmation popup. |
| `db55a59` | Persisted the true cancellation actor and presented it across admin, buyer, seller, public, web, and mobile views. |
| `0d8459e` | Aligned the Android branding regression test with the release branding code. |
| `5122ff9` | Made buyer cancellation email/WhatsApp/in-app/push actor-aware and removed stale public confirmation messaging. |

All commits above are ancestors of the verified production commit or are the verified production commit itself.

## 15. Automated and deployment validation

| Check | Result |
|---|---|
| Backend targeted financial/notification regression suite | 49/49 passed |
| Backend full Jest run | 199/199 suites; 2,898/2,898 tests passed |
| Frontend full test run | 190/190 tests passed |
| Frontend lint | 0 errors; 11 pre-existing warnings |
| Frontend production build | Passed |
| Mobile full test run before final backend/web-only patch | 83/83 suites; 1,042/1,042 tests passed |
| Final patch mobile impact | None; final patch touched backend/web only |
| `git diff --check` | Passed; only existing line-ending warnings were printed |
| Railway deployment | Success |
| Live backend `/health` | `status: ok`, correct `gitCommit`, outbox healthy |
| Live frontend behavior | New cancellation attribution and terminal decision-page behavior observed |

The backend health endpoint reported the exact release hash `5122ff9270023e33cac1cc076fdf9690929e6449`. The live frontend was verified by behavior that only exists in the final release: administrator attribution appeared and the stale confirmation content was absent after cancellation.

## 16. Scope exclusions and honest limitations

- Stripe and wallet payments were excluded by instruction. Their online charge, refund, settlement, and payout behavior is not certified by this COD run.
- The allowlisted 50-number WhatsApp pool verifies application behavior inside Rozare's admin test transport. It does not prove physical delivery by Meta or a carrier to fictional numbers.
- Historical long order IDs were not migrated. Only new orders use the short format.
- Exchange rates displayed before checkout depend on the application's current rate source/cache. The important order guarantee is that the accepted checkout rate and both parties' money snapshots are frozen afterward.
- This report certifies the controlled live scenarios and observed dashboard checkpoints, not every mathematically possible cart permutation.

## 17. Final verdict

**PASS.** On the live site, the buyer's order amount remains frozen in the checkout currency, while every seller sees the seller's own products and a frozen primary total in the seller store currency. Mixed PKR/USD orders reconcile exactly to the buyer total, seller shipping and statuses stay separate, selected options survive checkout, new order IDs are short, notification actors are correct, admin cancellation is direct, configurable trials work, and the final production release passed automated and live-browser regression checks.
