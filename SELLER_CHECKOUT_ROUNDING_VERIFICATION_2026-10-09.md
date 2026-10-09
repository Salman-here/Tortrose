# Seller checkout rounding: implementation and live verification

Date: 9 October 2026. This report covers the new seller-native pricing and seller order deduction display on the hosted Rozare website, backend and Android app. Safepay remains Sandbox. The checkout, cancellation, held-fund return, COD refund-funding and separate-item refund cases below were executed against the hosted services and verified against saved accounting records. This is scoped verification of these changes, not a claim that every possible platform scenario or real payment has been tested.

## Agreed rules

Convert each seller's complete native portion directly to the buyer currency with full precision, round that portion upward once, then add the seller portions into the checkout total. Product prices, shipping and native coupon discounts remain exact in the seller's original frozen currency. Buyer tax cents retain the existing tax policy. New seller FX adjustments are zero.

The buyer sees ordinary checkout prices and the final total, without a separate rounding charge. The small remainder is recorded internally, outside seller sales revenue and analytics. Rozare collects the online remainder; for COD, the seller collects it. Old order money is not rewritten.

Full cancellation and return refunds use the actual frozen buyer payment, including its rounded cents. Partial returns preserve each item's full frozen refundable allocation, as confirmed by the user. Tiny partial-return FX effects are accepted; the buyer's item refund is not reduced to protect the remaining seller amount. COD balance-funded returns cost the actual collected amount converted directly using the original rates. Online held-fund refunds reverse the original native credit.

The existing online deduction remains 6.2% plus PKR30 per checkout for Safepay and Wallet purchases. Its frozen seller allocations are displayed as one combined Processing fee plus tax amount, beside the original net order amount. These are original order terms, not a current withdrawable-balance claim.

## Before and after

Previously a converted buyer amount could be rounded in USD and then converted again into a seller's native currency. A seller could therefore see a small positive or negative FX adjustment even though the product's native price had not changed.

New orders have an exact native snapshot and a private per-seller ceiling snapshot. At the illustrative rate of USD1 to PKR300, two separate sellers each charging PKR301.20 receive separate USD1.01 buyer allocations. The checkout is USD2.02, while each seller's recorded native gross remains PKR301.20. Two such items belonging to one seller instead produce one USD2.01 seller portion; their frozen item cents are USD1.01 and USD1.00.

New web and Android checkout screens obtain a validated read-only backend quote before allowing payment. Quotes do not create orders, reserve inventory or coupons, or move money. Obsolete responses after account/cart changes are discarded. Actual placement rechecks the current source prices, stock, shipping, coupons and rates before committing.

### Changed flows and source locations

| Flow | Source locations | Result |
| --- | --- | --- |
| Buyer quote and order creation | Backend/routes/orderRoutes.js; controllers/orderController.js; middleware/paymentCreationLimiter.js | New POST /api/order/quote, separate quote rate limit, authoritative totals on both quote and placement |
| Exact conversion and seller pricing | Backend/services/moneyMath.js; sellerCheckoutRoundingService.js; orderMoneyService.js | Full-precision rational conversion, per-seller ceiling, exact native version2 ledger, component allocations that sum to the invoice |
| Saved order contract and payment validation | Backend/models/Order.js; controllers/PaymentController.js | Immutable private reconciliation, version2 validation, relevant payment projections retain the snapshot |
| AI checkout calculation | Backend/services/aiActionExecutor.js | Same pricing rule for COD preview and placement; necessary order projections updated |
| Native coupons | Backend/services/couponUsageService.js | Native coupon terms/reservations stay exact; buyer allocated discount cents are not rederived from a rounded line price |
| Buyer privacy | Backend/services/buyerOrderPresentationService.js | Internal rounding and native/fee ledgers removed from buyer DTOs |
| Refund funding and balances | Backend/services/returnService.js; sellerNativeAccountingService.js | Online refunds reverse native credit; COD funding uses actual collected buyer refund at original direct rates; cumulative refunds do not duplicate liabilities |
| Website checkout | Frontend/src/components/layout/Checkout.jsx; hooks/useCheckoutQuote.js; utils/checkoutQuote.js | Backend-quoted lines and totals, exact reconciliation checks, payment blocked until current quote is ready, refresh on repricing |
| Android checkout | MobileApp/src/screens/CheckoutScreen.js; hooks/useCheckoutQuote.js; utils/checkoutQuote.js | Same quote validation and totals; preparation uses baseSubtotal so the quote cannot retrigger preparation |
| Seller order details | Frontend/src/components/layout/OrderDetail.jsx and utils/orderItems.js; MobileApp/src/screens/shared/OrderDetailManagementScreen.js and utils/orderPresentation.js | Seller-owned native gross, original combined fee and net rows; dynamic COD collection/buyer-currency labels; old version1 adjustment presentation retained |
| Verification | Backend/scripts/auditSellerCheckoutRoundingQa.js; runSellerRoundingQa.js; backend/web/mobile regression tests | Authenticated read-only Sandbox ledger evidence and narrowly scoped disposable QA fixtures |

No new rounding fields were added to buyer, admin or seller analytics screens. Existing analytics and balance services receive the preserved native order amounts. Seller fee rows describe the original payment, even if it was subsequently cancelled or returned; the Payments page remains the source for the current available balance.

## Releases

| Commit | Change |
| --- | --- |
| 982b7205 | Native pricing, exact per-seller buyer ceiling, immutable private reconciliation, read-only quotes, COD refund funding, and seller-owned fee/net rows on web and Android |
| b6aa7edc | Sandbox-only read-only verification helper for the designated QA accounts |
| 8784cf7a | Mobile delivery/tax preparation depends on base prices rather than quoted subtotal cents, avoiding a quote-triggered preparation loop |
| c0e2ceeb | Correct cancellation attribution in the seller's partial-order view and compact verification evidence |

These commits were pushed to both GitHub main remotes. Railway and Vercel commit checks are successful for c0e2ceeb. Safepay web and mobile flags are enabled for Sandbox; Stripe is disabled. Dormant Stripe implementation remains preserved.

Final evidence and QA helpers were pushed in29c51417. Its Railway deployment13594016-4284-4733-9df9-4fcde38565a7 is SUCCESS. Vercel deployment dpl_2VXKzSJAtZwiGZ59eKN63QXXpLvi is READY in production with rozare.com aliases. Both GitHub commit checks are successful. The primary main checkout and both main remotes were synchronized while preserving unrelated local edits.

Android code17, version/runtime1.0.13 was installed in the QA emulator. The latest published Android update is group 442c14fe-6be3-4f49-8447-0525e9ba464e, update 01a1205e-0e0b-79f5-ab82-3eab00e304fc, containing the 8784cf7a app source. The later cancellation-label repair is served by the backend and does not require another native build.

## Verified hosted orders

The three products were a Green Safepay QA Travel Mug, Nova's Insulated Steel Bottle and Atlas's Minimalist Wallet. All used standard shipping.

| Seller | Native products | Native shipping | Native gross | Frozen buyer portion |
| --- | ---: | ---: | ---: | ---: |
| Safepay QA Store | PKR1000.00 | PKR200.00 | PKR1200.00 | USD4.34 |
| Nova Nest Market | PKR1690.00 | PKR300.00 | PKR1990.00 | USD7.19 |
| Atlas Aura Goods | USD29.50 | USD5.00 | USD34.50 | USD34.50 |

Buyer subtotal USD39.21 plus shipping USD6.82 equals USD46.03. The saved per-seller allocations sum to USD46.03 exactly. Every new native adjustment is zero. The saved rate for these orders is USD1 to PKR277.02; no rounded intermediate USD amount is used to reconstruct native earnings.

### Website COD

Order ORD-1791542191100, database6ac8c3af53a11e9702d06072, was placed through the website. The database confirmed stock deductions, retained Green selection, native totals and USD46.03 total. Buyer Wallet was unchanged at USD30.69.

Cancelling only Nova's unshipped portion required no refund. Nova was cancelled; the other two shipments remained pending. The buyer's amount due on delivery became USD38.84. The original frozen order money was retained.

### Website saved card

Order ORD-1791542604764, database6ac8c54c53a11e9702d06d75, was paid through the website with the saved Sandbox Mastercard ending1096 and completed the mock bank challenge. Rozare recorded paid and confirmed; the authenticated provider tracker was TRACKER_ENDED with USD4603 minor units captured. The three native grosses remained exactly PKR1200, PKR1990 and USD34.50.

The frozen online deduction was USD2.96. Native seller allocations were PKR77.42 for the QA store, PKR127.32 for Nova and USD2.22 for Atlas. Native net amounts were PKR1122.58, PKR1862.68 and USD32.28 respectively.

The cancellation preview offered full Wallet refund USD46.03 or original-card refund USD43.07 after processing fee USD2.96. Full Wallet refund was selected and completed for all three portions. Wallet rose from USD30.69 to USD76.72. No original-card refund was requested in this case.

### Android Wallet

Order ORD-1791544625014, database6ac8cd31e0e3b7e7b5b90a3b, was placed by the signed-in buyer in the Android app. The app displayed USD46.03 in checkout and its paid order history, retained Green, and displayed the three frozen store totals. Wallet debit was USD46.03, leaving USD30.69.

The Android cancellation of Nova's portion showed only the Wallet destination, with full USD7.19 refund and no deduction. It completed, restored Nova's product stock, left QA and Atlas confirmed, and raised Wallet to USD37.88. Nova's current online earnings, deduction and pending/withdrawable balances returned to zero. The order's original native gross and original fee/net presentation remained unchanged for audit.

### Seller website

Nova's seller order view contained only its bottle and standard shipping. It displayed native subtotal PKR1690, shipping PKR300, total PKR1990, buyer portion USD7.19, original processing fee plus tax PKR127.32, and original net PKR1862.68. No new FX adjustment row appeared.

Verification exposed an existing partial-cancellation presentation defect: a seller-scoped cancelled status could be described as via email even though the cancellation came from the buyer's app. The seller view now uses the durable cancellation reference to identify the account cancellation, without altering the whole order or other sellers. The deployed website now shows Cancelled by buyer from account.

The Android seller account was also signed in through the installed app. Its seller order management and detail screen for the two-variant order displayed PKR1100 per product, PKR2200 original total, Buyer ordered in USD / USD7.95, original Processing fee plus tax PKR166.04 and original Net order amount PKR2033.96. No new FX adjustment row appeared. These values stayed frozen after the product price was restored and both items were returned.

After all the new returns, the Android Payments screen independently matched the native ledger: available PKR283.67, total online earnings PKR8098.45, processing fee plus tax PKR463.00, and pending online net funds PKR5351.78. Delivered COD revenue was PKR6200.76. This screen was read-only; no new withdrawal or bank transfer was submitted.

### Android saved card and original-card partial cancellation

Order ORD-1791550971663, database6ac8e5fb432b3d2c10237648, was placed and paid through the Android app using the saved Sandbox Mastercard ending1096. The Android payment review showed USD46.03 and the app reached Payment confirmed after mock bank authentication. The saved backend payment was paid/confirmed with USD4603 minor units captured.

The Android cancellation of Nova's portion offered a gross USD7.19 refund, combined processing fee USD0.46 and original-card refund USD6.73. The final action stayed disabled until the buyer acknowledged that deduction. After submission, only Nova's portion was cancelled. The authenticated provider tracker was TRACKER_PARTIAL_REFUND; refundedMinor was673, Wallet refund was0, and the other shipments remained confirmed. Buyer Wallet stayed USD37.88.

### New-version online return from held funds

The QA and Atlas portions of Android Wallet order ORD-1791544625014 were moved through processing, shipped and delivered using the normal scoped seller APIs. These were explicitly simulated QA fulfillment updates, not real shipments or direct database rewrites.

QA's PKR1200 stayed held for its saved14-day return window. Atlas has no returns and its net USD32.28 became available after delivery, raising available USD76.71 to USD108.99. Nova's cancelled portion stayed excluded.

The Android buyer requested QA's full Green mug return, RET-1791552446753-487138, database6ac8ebbe432b3d2c1023a730. The seller website showed Refund held order funds, without requiring a new card payment or withdrawable earnings. Completing it credited the entire USD4.34, including shipping and the frozen rounded cents. Wallet rose USD37.88 to USD42.22. The seller's native PKR1200 credit was reversed; available PKR585.62 stayed unchanged. Replaying the accept API returned the same completed request with no second credit or debit.

### Android COD return funded from seller balance

For an affordable test, QA's mug was temporarily priced at PKR301.20 with free shipping. Android placed order ORD-1791553771473, database6ac8f0eb432b3d2c1023d756, with USD1.09 due on delivery. Its recorded native gross remained PKR301.20 and its private collector was seller. Simulated delivery was recorded using the normal seller API.

The Android buyer requested return RET-1791554603981-19DC6F, database6ac8f42b432b3d2c1023fdfe. The seller website accepted it using seller balance. The buyer received USD1.09 in Wallet, rising USD42.22 to USD43.31.

The actual collected amount converted directly at the original rate is USD1.09 times PKR277.02 = PKR301.9518, funded to the nearest native cent as PKR301.95. The seller's available balance fell PKR585.62 to PKR283.67. The saved native funding metadata was version2 and nativeDebitMinor30195. Exactly one completed seller debit and one completed Wallet credit were present; replaying accept did not create another.

### Android COD return funded by Safepay card

A second Android COD order, ORD-1791555021958, database6ac8f5ce432b3d2c10241900, used the same PKR301.20 native price and USD1.09 buyer payment. Its Android return was RET-1791555162719-102A93, database6ac8f65a432b3d2c1024259a.

The QA seller chose Pay by card on the hosted website. The embedded form explicitly showed Safepay Sandbox and USD1.09. The official dummy card completed mock authentication. The return finished as returned, with fundingSource card. Safepay payment6ac8f690432b3d2c102429bb was paid for109 minor units, and its authenticated tracker was TRACKER_ENDED for USD109 minor units.

Buyer Wallet rose USD43.31 to USD44.40. There was exactly one completed USD1.09 Wallet credit and no seller balance debit for this return. Seller available balance stayed PKR283.67.

### Same-seller two-item rounding and full separate returns

QA's mug was temporarily set to PKR1100, with two separate variants, Green and Blue, quantity1 each, and free shipping. The cart's base converted subtotal was USD7.94. The authoritative per-seller ceiling quote was USD7.95, split into Green USD3.98 and Blue USD3.97.

The emulator initially ran a cached earlier update and reproduced the quote/preparation loop: USD7.94 and USD7.95 alternated and payment stayed disabled. Restarting the installed app without clearing data loaded the published preparation repair. The Android checkout then stayed USD7.95, retained both variants, and enabled payment. No further financial source change was needed.

Android Wallet order ORD-1791556236682, database6ac8fa8c432b3d2c102452da, paid exactly USD7.95. Wallet fell USD44.40 to USD36.45; native order gross stayed PKR2200, with zero adjustment and frozen fee USD0.60. After simulated delivery, PKR2200 remained held and available balance stayed PKR283.67.

The Android buyer requested and received two separate full frozen item refunds:

| Return | Variant | Buyer refund | Native reversal |
| --- | --- | ---: | ---: |
| RET-1791556685400-88F71F /6ac8fc4d432b3d2c102460af | Green | USD3.98 | PKR1101.38 |
| RET-1791556947324-87ED12 /6ac8fd53432b3d2c10246d46 | Blue | USD3.97 | PKR1098.62 |
| Total | Both | USD7.95 | PKR2200.00 |

After the first refund, Wallet was USD40.43, the remaining PKR1098.62 stayed held, and a new return was disabled until the active request completed. After the second, Wallet returned to USD44.40, the order hold became zero, and available balance stayed PKR283.67. The two native reversals sum exactly to the original PKR2200. This deliberately follows the user's choice to keep full frozen item refunds: intermediate partial-return native amounts can differ slightly from each original item's price. It does not alter the original sale's native product prices or add a new FX adjustment.

Both returns used held order funds through the seller website, with no additional card charge or withdrawable balance debit. The Android return panel refreshed to the verified completed status.

### Live four-currency quote matrix

After restoring the mug to PKR1000, the read-only hosted quote endpoint was checked for COD, Wallet and Safepay in each supported currency. The same PKR1000 product and PKR200 shipping produced:

| Buyer currency | Products | Shipping | Total, all three methods |
| --- | ---: | ---: | ---: |
| PKR |1000.00 |200.00 |1200.00 |
| USD |3.61 |0.73 |4.34 |
| EUR |3.22 |0.65 |3.87 |
| GBP |2.73 |0.55 |3.28 |

All12 responses reconciled exactly. PKR-to-PKR stayed unchanged; other totals used direct full-precision conversion and a single seller-portion ceiling. These were live quotes, not12 additional card charges. The actual payment/refund UI cases above were USD checkouts involving PKR and USD stores; the automated mixed-native matrix covers all four currencies.

## Automated verification

- Full backend: 259 suites,3935 tests passed, with output rounding-backend-final-20261009.json.
- Cancellation label, access, analytics and export follow-up: 4 suites,101 tests passed after the later label repair.
- Final focused money/rounding, COD funding and read-only/no-charge checkout run:4 suites,119 tests passed, output rounding-focused-final-20261009.json. Expected error-path logs inside these tests were assertions, not hosted payment failures.
- Final website regression run:519 tests passed, including both JavaScript and MJS suites and the preparation dependency contract.
- Final Android JavaScript regression run after the preparation repair:119 suites,1321 tests passed, output rounding-native-final-20261009.json.
- Website production build, SSR/prerender and merchant policy publication check passed. Android production export and both update publications succeeded.

Specific tests cover all four supported buyer currencies with four mixed native sellers for COD, Wallet and Safepay; exact same-currency prices; fixed buyer tax cents; free/no-charge orders; native coupon conservation and 99% coupon reservation; source/snapshot tampering; stale quote responses after account switching; old version1 adjustments; full frozen item partial returns; scoped fee privacy; and COD cumulative funding.

A database-backed COD test at USD1 to PKR300 verifies that collecting USD1.01 for native PKR301.20 requires a PKR303 balance debit to fund the full Wallet refund, exactly once. A separate card-funded COD return test verifies full USD1.01 Wallet credit without a seller balance debit. The additional hosted UI cases above independently verified the actual saved rate of PKR277.02 and USD1.09.

## Scope and cleanup

The Safepay QA Travel Mug's temporary PKR301.20 and PKR1100 prices were restored to its original PKR1000 price through the seller edit API and rechecked through the seller catalog. Old and newly placed order snapshots kept their original prices, allocations, options, shipping and return deadlines.

The original multi-seller COD order still has QA and Atlas pending after Nova's cancellation. The Android multi-seller card order still has QA and Atlas confirmed after Nova's card refund. They were intentionally left in those verified states, not force-cancelled or rewritten. All return requests created by this verification are completed.

No real card charges, real bank transfers, iOS UI execution, physical-device push delivery or every possible WhatsApp AI conversation are claimed. Sandbox payment tracker reads were authenticated with the configured merchant client; no production payment switch was performed. Existing platform tests include saved return deadlines and holds across an unresolved return, but this verification did not wait14 real days for the new hosted orders.

The new pricing logic is also used by backend AI COD preview/placement. That change was covered by server regression tests; the hosted UI evidence here is the website and Android flow, not a new WhatsApp conversation test.

## Local testing environment

C drive lacked the emulator's required free space. A separate writable QA copy was prepared on F drive at F:\Rozare-QA-20261009 and the RozareQA locator points there. The original C drive userdata remains16171991040 bytes and was not deleted or wiped. The original locator is backed up at F:\Rozare-QA-20261009\RozareQA-original-locator.ini.

The APK installation succeeded after the user's explicit retry instruction. The app was signed in through Android input, and its notification permission was granted. After a later emulator disconnection, the same F drive AVD was restarted without wipe flags; the installed app remains present. Testing uses browser controls and Android SDK only, without controlling the full Windows desktop.

Screenshot evidence is saved in the primary project at test-artifacts/seller-rounding-20261009. Existing unrelated account/email/WhatsApp/template edits in the primary worktree remain uncommitted and were not included in these releases.

Useful screenshot files include buyer-cod-three-sellers.jpg, buyer-card-three-sellers.jpg, android-wallet-checkout.png, android-card-payment-confirmed.png, android-card-refund-choice.png, android-card-partial-refund.png, web-held-return-completed.jpg, web-cod-balance-return-completed.jpg, web-cod-card-return-completed.jpg, android-two-lines-stable-wallet-checkout.png, web-partial-return-final.jpg and android-seller-native-fee-net.png. Intermediate loading/debug captures are not payment proofs.

The final Android balance proof is android-seller-final-balances.png. The task-owned headless emulator was shut down through the Android SDK after its checks, without wiping its data or changing Android Studio's settings. Railway's saved profile was restored to EYEKONIT after the Rozare checks.

Sandbox dummy card data came from [Safepay's official test-card instructions](https://safepay.helpscoutdocs.com/article/41-dummy-card-information). The report and committed helpers contain no passwords, session tokens, payment checkout authentication URLs or bank challenge codes.
