# Saved-card lifecycle: website and Android

Started 7 October; final checks completed 8 October 2026 (Pakistan time). Environment: live Rozare, **Safepay Sandbox only**. This is a separate follow-up to the completed withdrawal/COD-return report.

Status: **PASS for the saved-card lifecycle and live Sandbox flows explicitly recorded below.** Saving, reuse, card selection/defaults, removal/protection and interruption recovery were actually exercised. This is not a claim that production approval, every possible issuer/card type, real settlements, iOS or future renewals were tested.

## Actual UI checks completed so far

| Check | Observation | Result |
| --- | --- | --- |
| Fresh website card setup | QA buyer added public test Visa ending 1111, expiry 12/2030, with both Rozare consent and the provider storage checkbox selected. The reusable card appeared in Payment Methods. | PASS |
| Website default | Make default changed Visa 1111 to Default. Android subsequently showed the same default. | PASS |
| Fresh Android setup | QA buyer added public test Mastercard ending 1096, expiry 03/2028, inside Rozare. Completed the bank's Sandbox authentication. Android displayed Card saved securely and two cards. | PASS |
| Provider ownership/storage | Read-only provider audit confirmed both cards on the buyer's owned Sandbox customer. Both had max_usage -1 and valid future expiry, not a one-day single-use token. | PASS |
| Android default | Set Mastercard 1096 as default. Android displayed the updated default; the website wallet's selector offered Mastercard 1096 by default. | PASS |
| Native removal cancellation | Opened Remove saved card? for this task's test Visa 1111, then chose Keep card. Both cards remained. | PASS |
| Actual removal / protected billing-card rejection | Native test Visa removal persisted on web; active Atlas subscription card removal was rejected. | PASS |
| Actual repeated saved-card charges | Six completed captures across web/native Wallet top-ups and purchases, including non-default Visa reuse and default Mastercard reuse. | PASS |

Web setup record: `6ac671a254393991d3c615f3`. Native setup record: `6ac6710a54393991d3c6116c`. Both became authorized/applied instrument verifications for PKR 0, with no Wallet financial effect.

## Findings and implementation

1. Ordinary order, Wallet, subdomain and return-funding payments did not attach the account's consented merchant customer. They therefore could not use the stored-card profile. Commit `fd691245` attaches only the authenticated owner's ready, consented, same-environment profile. Existing attempts retain their original binding, including older null/guest-style bindings. No older data was migrated.
2. Linking a customer alone prefilled contact details but the hosted page still showed blank card-number/expiry/security-code fields. Commit `bfc27319` added an explicit web Wallet card selector, immutable payment/tms binding, reusable-card ownership checks and removal protection for in-flight selected-card payments. The provider accepted TMS tracker setup, but the hosted UI still did not supply the actual stored-token authentication journey.
3. Commit `cc1104a7` adds an explicit saved-card review and Safepay's official 3DS authentication component, pinned at version 0.3.7. Reading the review does not capture money. Clicking Pay performs the selected, owned card's payer-authentication setup; bank verification/capture is handled by Safepay. Fulfillment/credit still requires Rozare's existing verified provider-money reconciliation. New-card checkout and subscription renewal remain their existing separate paths.

The new review uses a short-lived payment-specific ticket and a separately delivered, paired session grant. Copying its URL alone does not reveal or charge the saved card. Neither is an account login token. Bank setup context is encrypted and excluded from normal database serializers. Unknown setup responses are not automatically resubmitted. Product/Wallet selectors were added on both web and Android. A changed card on an already-frozen attempt is rejected rather than silently replacing its payment.

## Verification recorded before live saved-card charges

- Website: 495 automated tests passed; full client/three-SSR/prerender build passed.
- Android: 116 suites / 1,295 tests passed. Physical-device and iOS verification are outside this follow-up.
- Backend: preceding full run passed 249 suites / 3,816 tests. New saved-card/crypto/CIT tests passed separately; a full final run will be recorded after the final repairs.
- Narrow checks covered ownership, same-environment binding, old-attempt preservation, tampered or missing session grants, URL-only access rejection, encrypted-context integrity, exact frozen money, no capture on review/setup, uncertainty retention, and paid/local-cancelled rejection.

## Completed live matrix and explicit boundaries

- Completed and reconciled web/Android saved-card purchases and top-ups using both saved test cards.
- Checked non-default/default selection, same-card reuse, close/resume, incomplete bank verification, explicit recovery, exact-once Wallet/order/inventory effects and merchant ledger references.
- Checked mixed-seller calculations and actual seller order/Payments/Analytics UI; native same-currency purchase retained its Green option.
- Removed this task's finished test Visa and verified the result on both surfaces. Rejected active subscription-card deletion. Separate actor lists plus automated ownership/forgery guards covered account isolation; no direct live foreign-card API mutation is claimed.
- Code deployed/pushed and compatible Android OTA actually exercised. Real production charges/refunds, bank settlement, physical-device/iOS behavior, Google Pay/Raast/other unselected payment rails, future renewal charges and saving a card inline during a normal new-card purchase were not tested in this follow-up. Earlier new-card/Wallet/COD reports retain their own separate scope.

## Saved-card charges now verified

### Website Mastercard: USD 2.03 — PASS

Payment `6ac683e5aa0ee55b9c024d11`. Selected the saved Mastercard ending 1096, saw the frozen USD 2.03 review, approved Pay and completed the Sandbox bank challenge. No PAN or CVC was re-entered. Wallet increased USD 22.50 → 24.53, exactly 2.03.

Read-only provider/local verification: payment mode **payment**, entry mode **tms**, TRACKER_ENDED, captured 203 USD minor units, applied once. Exactly one completed Wallet credit of USD 2.03, balanceAfter 24.53. Earlier unpaid test attempts remained uncharged with no Wallet effects. [UI evidence](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-web-wallet-credit-2-03.png).

### Website non-default Visa: USD 2.04 — PASS UI and provider/local records

Kept Mastercard as the account default but explicitly selected Visa ending 1111. Review showed **Visa ending 1111 / USD 2.04**. Approved the payment without PAN/CVC entry. Provider completed without a manual challenge. Wallet increased 24.53 → 26.57; its completed transaction row showed +2.04. The selected non-default card was not replaced with the default card.

Payment `6ac685cfaa0ee55b9c025adf`: paid/applied, payment/tms, TRACKER_ENDED, captured 204 USD minor units; exactly one completed Wallet credit 2.04 with balanceAfter 26.57.

### Android Visa reuse: USD 2.05 — PASS UI and provider/local records

Selected the saved, non-default Visa in the actual Android Wallet selector. The in-app review showed **Visa ending 1111 / USD 2.05**, with the billing address prefilled. Approved Pay without entering PAN/CVC. The sheet returned to Wallet, amount input reset after verified success, and USD balance displayed **28.62**.

Payment `6ac68627aa0ee55b9c025d93`: paid/applied, payment/tms, TRACKER_ENDED, captured 205 USD minor units; exactly one completed Wallet credit 2.05 with balanceAfter 28.62. The same saved Visa was actually reused on web then Android. Across all three new top-ups: **22.50 + 2.03 + 2.04 + 2.05 = 28.62**. PKR 5,840.05 / EUR 1.00 / GBP 0 unchanged. [Native UI evidence](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-native-visa-credit-2-05.png).

### Android release

Production-compatible update group `47547c1b-e3f9-4b94-b14b-4a594d90a314`, Android update `01a11771-87fa-745c-96b0-10938fe0dabf`, runtime 1.0.13, commit `cc1104a7`. After SDK restart, the actual Android Wallet showed the new Mastercard/Visa/New-card selector. Native USD 2.05 Visa top-up and PKR 1,000 Mastercard product purchase both completed and reconciled. No new APK/native module was required. The final recovery repair is backend-only and is compatible with this OTA.

## Concurrent-state observation

The first web QA tab navigated away and its form amounts changed outside the root agent's expected sequence. A separate background tab was created. No changed amount or another actor's payment is counted as a root-executed successful payment. All new financial success claims must be backed by an exact payment/order reference and a verified result.

## Website mixed-currency, two-seller purchase — PASS buyer UI and persisted money

Order **ORD-1791396309121**, database `6ac689d5aa0ee55b9c02764a`, payment `6ac689d6aa0ee55b9c027664`.

I added Atlas's USD 29.50 Minimalist Wallet and the QA store's PKR 1,000 mug, explicitly chose **Blue**, and selected paid shipping for both stores (Atlas USD 5 / 2 days; QA PKR 200 / 5 days). The USD buyer checkout displayed **33.11 products + 5.72 shipping = 38.83**. Selected the non-default saved Visa 1111; review showed that card and USD 38.83. Approved Pay without PAN/CVC re-entry.

Buyer order detail showed **Paid / Confirmed after verified Safepay payment**, one purchase with two separate seller shipments:

| Store | Buyer products | Buyer shipping | Buyer seller total | Frozen seller-native total | Seller processing fee + tax | Held net |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Atlas Aura Goods | USD 29.50 | USD 5.00 | USD 34.50 | USD 34.50 | USD 2.24 | USD 32.26 |
| Safepay QA Store | USD 3.61 | USD 0.72 | USD 4.33 | PKR 1,198.28 | PKR 77.49 | PKR 1,120.79 |

The QA seller snapshot retained **PKR 1,000 product + PKR 200 shipping − PKR 1.72 FX/cent reconciliation = PKR 1,198.28**. This is the existing rounding rule, not a new change. Buyer allocations **34.50 + 4.33 = 38.83** exactly. Blue appeared in its buyer shipment group. The payment captured exactly **3,883 USD minor units** and was paid/applied once, with no cancellation/refund or risk state.

Checkout fee snapshot: **241 percentage minor units + 11 converted fixed minor units = 252 USD minor units**. Seller buyer-fee allocations **224 + 28 = 252**. No new per-withdrawal fee or new rounding rule was introduced.

Inventory: Atlas wallet stock **20 → 19**, totalSales 11; mug stock **11 → 10**, totalSales **19 → 20**. Buyer Wallet remained **USD 28.62 / PKR 5,840.05**, confirming the Card order did not also debit Wallet.

Seller accounting read-only proof: Atlas online gross **205.97 → 240.47**, total deductions **2.24 → 4.48**, pending net **106.98 → 139.24**, available **76.71 unchanged**. QA online gross **5,000.64 → 6,198.92**, deductions **216 → 293.49**, pending net **2,199.02 → 3,319.81**, available **585.62 unchanged**. Confirmed but undelivered funds were not added to withdrawable balances. The seller UI and native-purchase follow-ups are recorded below.

Live security check: opened a copied saved-card review URL in a fresh browser tab without its separate session grant. It displayed **“A copied link cannot use your saved card”**, revealed no amount/card data, and offered no Pay form. [Blocked copied-link UI](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-copied-link-blocked.png).

## Android same-currency PKR purchase — PASS payment, inventory and seller money

Order **ORD-1791397974856**, database `6ac69056aa0ee55b9c02a195`, payment `6ac69058aa0ee55b9c02a1b2`.

I selected PKR in the Android currency selector, searched naturally for Safepay, chose the mug's **Green** option in its required option picker, and added one to the cart. Cart/checkout retained Green and showed **PKR 1,000 product + free shipping + zero tax = PKR 1,000**. Used the saved default Mastercard 1096; the in-app review showed that card and the same PKR 1,000 amount. Approved Pay and completed the issuer Sandbox challenge without entering PAN/CVC. The app displayed **Payment confirmed / Order secured** and the order reference.

Read-only records showed exactly **100,000 PKR minor units captured/applied once**, order paid/confirmed, no refund/cancellation/risk state. Same-currency seller allocation stayed **PKR 1,000**, adjustment **0**. Fee **62 + 30 = PKR 92**, held net **PKR 908**. Mug stock **10 → 9**, totalSales **20 → 21**, exactly one unit. Buyer Wallet remained USD 28.62 / PKR 5,840.05: the saved-card purchase did not also debit Wallet.

Actual PKR seller Payments UI after both purchases showed **online gross 7,198.92**, **processing fee + tax 385.49**, **pending net 4,227.81**, **withdrawable 585.62 unchanged**, and **estimated revenue 22,393.62**. These matched the read-only accounting service exactly. New undelivered revenue stayed pending. [Seller Payments UI](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-qa-seller-payments-after-two-orders.png).

Actual PKR seller mixed-order detail showed only its Blue mug, product 1,000, its own standard/5-day shipping 200, reconciliation −1.72, total 1,198.28 and buyer equivalent USD 4.33. It did not show Atlas's product or shipping method in this payload. Orders were newest-first and marked Paid after verified Safepay payment.

## Final release automated verification recorded so far

- Backend: **250 suites / 3,825 tests passed**.
- Website: **495 tests passed**, full client/three-SSR/prerender build passed.
- Android: **116 suites / 1,295 tests passed**; compatible OTA actually loaded and its new selectors/payment screen were exercised.

These are release-test results plus the separately recorded live Sandbox flows; automated counts do not substitute for live card-removal/protection and merchant-ledger observations. The final recovery repair's full backend result is recorded below.

## Final interruption/recovery test and repair — PASS

Payment **`6ac6a2a4aa0ee55b9c032297`**, Wallet amount **USD 2.07**, default Mastercard 1096.

1. Opened review and closed it before Pay. Wallet remained **28.62**; record stayed ready, captured **0**, appliedAt null, no Wallet effect.
2. Reopened through the same Wallet UI. The review path contained the **same payment ID**, not a second payment. Initiated bank verification. The challenge did not complete and the issuer/SDK returned an authentication failure. Again no capture or credit occurred. The attempted nested cancel action had tooling timeouts; its resulting failure was observed, rather than counted as success from the click alone.
3. Found a real recovery defect: old bank setup context stayed locked/expired while Safepay's tracker remained **TRACKER_ENROLLED / PAYER_AUTH_VALIDATION**. Commit **`c03f1968`** adds explicit **Retry bank verification**, using the official SDK's **Order.Configure.reset** (`PUT /order/payments/v3/{tracker}`) only for the same owned, uncaptured payment/tms tracker. It does not create a new tracker, change price/currency/customer/card, authorize MIT, bypass 3DS or silently retry unknown mutations. Unknown reset responses remain claimed and are recovered only through verified provider state.
4. Deployed the repair and reopened the original payment. The UI explained that the previous verification was incomplete and retry would use the **same payment/card/amount**. Explicitly clicked Retry; Safepay reset the existing tracker and presented a fresh issuer challenge. Completed it. The original payment became paid/applied with captured **207 USD minor units** and exactly **one** completed Wallet credit **2.07**, balanceAfter **30.69**.
5. Refreshed the Wallet rather than starting another payment. The final balance/effect count remained unchanged. Final Wallet equation: **22.50 + 2.03 + 2.04 + 2.05 + 2.07 = 30.69**. Card purchases did not debit Wallet; PKR **5,840.05**, EUR **1**, GBP **0** remained unchanged.

Final merchant refresh also showed **USD 2.07 / Complete / hosted / Wallet reference ending cb51f20774d417b49a8979e0 / QA buyer**, alongside the original five Complete rows. Thus all six completed captures are independently visible in the merchant UI. [Six-capture ledger](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-six-complete-captures-merchant-ledger.png).

[Recovered payment UI](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-recovered-payment-single-credit-2-07.png). Official reset implementation: [Safepay node-core Configure](https://github.com/getsafepay/node-core/blob/main/src/resources/Order/Configure.ts).

## Final release / preservation

- Application commits: **fd691245**, **bfc27319**, **cc1104a7**, **c03f1968**, pushed to origin/main and tortrose/main. Backend health confirmed code **c03f1968623f8c9983a8e0a47f683bfa04997bff** live.
- Final backend: **250 suites / 3,832 tests passed**. Website: **495 tests + full build passed**. Android: **116 suites / 1,295 tests passed**. Total **5,622** automated tests, plus the named live Sandbox flows.
- Existing FX/freezing/fee/return-hold/manual-withdrawal rules and old orders were preserved. Dormant Stripe implementation was retained but not used by these new flows. No old-data migration, real card charge, bank payout, subscription cancellation or native dependency/build change was performed.
- Removed only the disposable buyer test Visa 1111 from stored payment methods, not its paid transaction history; it can be added again through the normal Sandbox setup flow. Buyer default Mastercard and Atlas protected billing card remain.
- Buyer website Payment Methods was reloaded after native removal and showed only its remaining Default Mastercard 1096, matching Android. Native buyer order detail showed **PKR 1,000 / Confirmed / verified Safepay payment / Green option / 5-day free shipping**. The different USD mixed order retained its original USD totals.
- Unrelated local email/WhatsApp-template drafts, auth/reset files, generated assets, older reports and testing outputs were not included in application commits. Railway profile was explicitly switched back to **tech@eyekonit.com** and GitHub CLI to **EYEKONIT**.

## Seller UI and merchant ledger follow-up — PASS

- QA seller Analytics displayed **PKR 22,393.62 recognized revenue / 18 recognized orders / 21 units / PKR 1,244.09 average**, matching the accounting/inventory totals after the two new orders. It did not relabel these amounts as USD despite the header's separate shopping-currency control.
- Atlas order detail displayed only its wallet: **USD 29.50 + USD 5 / standard, 2 days = USD 34.50**. No QA mug or other seller's shipping appeared. Payments showed **USD gross 240.47 / combined deductions 4.48 / pending net 139.24 / available 76.71**. 90-day Analytics showed **341.96 / 10 recognized orders / 10 units / 34.20 average**; 30-day scope showed 270.46, as older orders fall outside that date range. No fee was double-counted in analytics.
- The authenticated Safepay Sandbox **TEST MODE** merchant ledger showed all five exact new references **Complete**: native order `order:6ac69056aa0ee55b9c02a195` for PKR 1,000; hosted mixed order `order:6ac689d5aa0ee55b9c02764a` for USD 38.83; mobile Wallet reference ending `dfe5133fac8573ab7f9137aa` for USD 2.05; hosted Wallet ending `cfe5ec24cb09ffe961777a02` for USD 2.04; hosted Wallet ending `0c34f0433989f5699d10c847` for USD 2.03. All belong to the QA buyer. [Merchant UI proof](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-five-captures-merchant-ledger.png).

## Removal and subscription protection — PASS

- Android: removed only this task's disposable test Visa 1111 after its payments finished. The UI displayed **Card removed**, then only the original default Mastercard 1096 remained. Earlier Keep card cancellation had preserved both cards. Paid order/payment history was not deleted.
- Atlas: its own saved-card list showed its distinct, existing Mastercard 1096, not the buyer's two-card profile. Its Starter introductory subscription remained current. Confirmed Remove on that billing card was rejected with **“Change your subscription card or cancel renewal before removing this card. Pending payments must finish first.”** The card remained Default, and no subscription was cancelled/changed. Closed the test dialog with Keep card. [Protected-card rejection](C:/Users/Salman/Desktop/hello-friend/test-artifacts/saved-card-active-subscription-removal-blocked.png).

Some unrelated COD/display totals changed during the run outside these five identified payment references. They are not attributed to this saved-card work. The new order/product/fee and Wallet deltas above are tied to exact persisted references, rather than assuming all account activity came from this agent.
