# Safepay checkout pause and paid seller billing

Date: 8 October 2026, Asia/Karachi. **Implementation and the described Sandbox verification completed.**

This is the follow-up requested after the go-live audit. It covers safe checkout pausing and paid subscription renewal/plan-change verification. All provider activity is Safepay **Sandbox**. Production Safepay activation, a real-payment pilot, test-account deletion and separate Sandbox Wallets are outside this task and were not performed.

## Changes released

| Commit | Problem | Change |
|---|---|---|
| `b89eed74` | Turning off both card-checkout switches also stopped financial workers and some existing-agreement controls. | Workers depend on valid selected-environment provider/webhook configuration, independently of the two new-checkout switches. Existing owned verification/resume, subscription cancellation/resumption/downgrade/card management remain available. New payment agreements, card setups and fresh billing quotes/acceptances stay gated. |
| `f2044b76` | Previous paid billing coverage did not run the complete adapter-to-billing-engine chain for several recovery/plan-change cases. | Real local MongoDB transactions and the actual provider adapter/engine now test paid enrollment, renewal, declined invoice/retry, lost replies, paid upgrades, Meta changes, credits, downgrade and cancellation during capture. Only external HTTP replies are controlled in those automated cases. Adds a read-only masked QA audit and an explicitly guarded Sandbox clock fixture. |
| `ca7875d9` | Live Android showed 31 paid days remaining but the expired introductory end date in its access sentence. | Paid access uses `currentPeriodEnd`; only an actual introductory state uses `freePeriodEndDate`. Rendered tests include active, cancellation scheduled, downgrade, introductory and missing-date cases. |
| `2af7574c` | Removing a USD 3.99 funded Meta add-on offered USD 4.00 credit because two proration legs rounded independently. | New quotes freeze the add-on rate and cap removal credit at the verified funded add-on value. Acceptance rechecks the frozen proof in a transaction. Unsafe unaccepted quotes expire; accepted/paid history is not rewritten. Credit-funded re-add/removal and later full-month funding are covered. |
| `7efab001` | The website's pending-downgrade undo banner was nested inside a card hidden from subscribed sellers. | Moves the notice and Keep Elite action into the subscribed view, displays the actual current-period end, disables redundant scheduling and retains the ability to cancel future renewal while a downgrade is scheduled. Nine whole-component rendering/handler regressions cover the reachable UI. |

These application commits are pushed to both main remotes. Backend health verified `7efab001`; Vercel successfully published the website fix. Existing unrelated primary-checkout email/WhatsApp-template drafts and generated build assets were preserved and excluded.

## Agreed pause semantics and automated boundaries

- A pause prevents a new Safepay purchase/top-up/setup/paid agreement or new quoted billing charge on the disabled surface. Wallet/COD money rules are not changed.
- An already owned, frozen payment attempt may still be verified/resumed. It does not become a new purchase or receive a different amount/card/reference.
- Durable signed webhooks, cancellation refunds and already-authorised recurring invoices continue during a two-surface pause, including server restart.
- An existing subscriber can stop/resume renewal, schedule/undo downgrade and change the owned billing card. These operations retain the original access/consent/ownership checks; card removal protections are not relaxed.
- Missing/invalid selected-environment keys or webhook configuration stop workers. Sandbox keys cannot substitute for Production keys or vice versa.
- Automated coverage includes all web/mobile flag combinations, missing/invalid flags, environment isolation, transient webhook recovery, exact-once refund submission/recovery, old invoice identity, no unpaid entitlement, cancellation races, uncertainty without recharging and original retry period preservation.

## Live case 1: new checkout paused, real Sandbox renewal completes

Dedicated existing QA seller: `rozare-safepay-seller-20260925@mailinator.com`, store `6ab76b67f1585bb3833af082`, product currency **PKR**. Billing is separately priced in **USD**.

Before: Starter introductory period, USD 9.99 monthly afterward, owned reusable Visa 1111, automatic renewal true, no paid renewal operation. Original introductory end was 26 October. No invoice was manually marked paid.

1. Released the safeguard; both GitHub deployment statuses succeeded and backend health matched the released commit.
2. Temporarily set `SAFEPAY_WEB_ENABLED=false` and `SAFEPAY_MOBILE_ENABLED=false` while retaining `SAFEPAY_ENV=sandbox`. Railway pause deployment `e1259049-5613-4f26-ab31-8d36bf650ff9` succeeded. A configuration read showed both flags false and financial workers enabled.
3. In the actual seller website, attempted Upgrade to Elite through its preliminary confirmation. The server rejected the new quote with **Card payments are temporarily unavailable on this surface**. No charge or new quote was committed.
4. Applied the dedicated clock fixture. It only moved this QA subscription's projected introductory boundary/renewal anchor to `2026-10-08T03:53:39.183Z`. It did not alter prices, consent, card, invoices, payment statuses, product orders, inventory or balances. A durable before/after QA receipt is saved. This is accelerated fixture time, not thirty elapsed live days.
5. Without a manual payment submission or fake payment state, the deployed recurring worker created and completed one normal **USD 9.99** renewal while both checkout flags were false.

| Evidence | Observed value |
|---|---|
| Billing operation | `6ac713d75fb3c975a80e65ad`, renewal, applied |
| Payment | `6ac713d75fb3c975a80e65b4`, paid/applied |
| Merchant reference | `billing:6ac713d75fb3c975a80e65ad` |
| Provider result | `TRACKER_ENDED`, subscription/MIT |
| Quote and capture | **999 USD minor units**, exactly USD 9.99 |
| Paid access | **8 October → 8 November 2026**, original monthly boundary preserved |
| Next charge | 8 November, USD 9.99 |
| Payment review/refund state | No risk, no refund, no failure |
| Store | Active; product currency remains PKR |

The real Android emulator visibly received **Subscription updated / Rozare Starter is now active / Charged: $9...**. The website subsequently showed Active. Seller Dashboard still showed PKR 22,393.62 gross sales, 30 received orders and one product; the subscription expense did not create a marketplace sale.

The refreshed Safepay TEST MODE merchant ledger independently showed USD 9.99, Complete, Subscription and the exact billing reference above. This was a real Sandbox provider capture, not a locally invented paid state.

**Result: PASS for the actual paused-checkout background renewal and exact provider/application money.**

Evidence: `test-artifacts/billing-pause-web-new-quote-blocked.png`, `billing-paused-native-renewal-push.png`.

## Live case 2: cancellation while paused preserves the paid month

On the actual website, selected Cancel Subscription → Cancel Plan while both checkout channels remained paused. The page displayed **Cancellation Scheduled / 31 more days / end on 8 November 2026 / Keep Subscription**. The cancellation stops future renewal, not the already paid period. No second charge or immediate access removal was observed.

The Android Refresh showed **Ending ·31 days remaining**, establishing cross-channel state. It also exposed the separate wrong-date sentence described in `ca7875d9`. Source inspection confirmed that refresh could not repair it: the old code preferred the historical introductory end over the paid end. The correction was published as a compatible Android OTA and actually loaded. The same subscription then visibly showed **8 November** in both its paid-access sentence and cancellation card, despite retaining the historical 8 October introductory date in the database.

Android's **Resume subscription** action then returned **Subscription renewal resumed**. The native page became Active; a read-only provider/database audit showed auto-renewal true, the same paid period and monthly 999, and still only one paid renewal operation. It did not restart a free trial or enroll/charge again.

OTA: group `12318048-a5bf-4fd8-a7e5-7451d93296bf`, Android update `01a119b9-8c89-7e73-830a-ce8fae18bcdd`, runtime 1.0.13, installed APK 1.0.13/code 17. [Published update](https://expo.dev/accounts/rozare/projects/rozare/updates/12318048-a5bf-4fd8-a7e5-7451d93296bf). The app was closed/reopened through Android SDK commands without wiping account/data. The corrected visible behavior establishes activation; a target-update log identifier was not independently obtained, so no such log proof is claimed. No new APK was needed.

**Result: PASS after fixing and live-retesting the date sentence.** Evidence: `test-artifacts/billing-paused-web-cancel-preserves-paid-period.png`, `billing-native-paid-period-date-corrected.png`.

Checkout flags were set back to **true/true** after these pause checks. The later repeated pause/restoration deployments and final selected environment are recorded below.

## Processor declines versus normal plan prices

Safepay's [official API testing table](https://apidocs.getsafepay.com/) specifies amount-driven negative cases: 405100 minor units for insufficient balance, 400400 for stolen card and 405400 for expired card. These are not Rozare's USD 9.99/21.65/25.65 plan prices.

Normal prices are not changed to force a decline. A separate, one-shot, Sandbox-only gateway probe uses the owned QA card and an explicit QA reference. It does not create a Rozare invoice, change subscription price or credit/debit Wallet/seller funds. Actual application decline/successful-retry behavior is separately exercised through real database transactions and the real adapter/engine with controlled external HTTP responses. The distinction will remain explicit in final results.

First provider-only probe, `qa:billing-decline:20261008:insufficient`: USD 4051.00 special test amount, subscription/MIT, provider HTTP 403, `TRACKER_STARTED`, no charge, not ambiguous. Original/current subscription monthly price remained 999. The first probe logged only a generic rejection, so its precise issuer-reason wording is not asserted from HTTP 403 alone. No repeated authorization was submitted.

Additional provider-only probes:

| Reference suffix | Official special amount, USD minor units | Actual provider result |
|---|---:|---|
| `stolen` | 400400 | HTTP 403; TRACKER_STARTED; no charge; safe diagnostic matched `stolen`, not an authorization-configuration error. |
| `expired` | 405400 | HTTP 403; TRACKER_STARTED; no charge; safe diagnostic matched `expired`, not an authorization-configuration error. |

Reopening the insufficient probe reused its durable journal and made only a provider read: `chargeSubmissionReused=true`, still no charge. The probe helper never prints raw provider bodies, tokens or saved-card IDs. These large numbers are Sandbox test vectors, not real charges or altered Rozare plan prices.

The normal-price declined-renewal → seller-consented retry → paid entitlement chain is tested with the actual payment adapter, billing engine and real MongoDB transactions, with controlled external HTTP. It includes observed HTTP 403 as well as 400/402/422, preserves the original invoice period, and proves one successful capture/application. **A real merchant-ledger normal-price decline followed by success was not forced or claimed.**

## Current automated verification

- Backend final money-source full run: **255 suites /3875 tests PASS**, successful exit and parsed JSON `success=true`, zero failed suites/tests.
- Android final date-correction full run: **116 suites /1300 tests PASS**, successful exit. An initial new downgrade test supplied the raw database object instead of the API's string DTO; the fixture was corrected to the actual contract and the entire suite rerun green.
- Website full regression after the downgrade-UI correction: **504 tests PASS**, successful exit. The new whole-page regression first reproduced seven failing assertions on the old component; after the fix, all nine new cases and the complete website suite passed. Production Vite build, SSR bundles and policy prerenders also completed successfully.
- These independent full runs total **5679 passing tests**. Focused subsets are not added again. Live downgrade-boundary/provider/UI reconciliation subsequently passed as recorded below.

No real card charge, real bank settlement, real bank payout, real-money refund or production merchant approval is claimed by this report. Sandbox outcomes and projected clocks cannot establish those real-world facts.

## Live case 3: website Starter → paid Elite

The preliminary upgrade led to a populated billing review: due now USD 11.65, recurring USD 21.65, owned Visa 1111. Confirm was disabled before consent. **Not now** dismissed it without a payment or plan change; the unaccepted quote was retained and reopened at the same frozen USD 11.65. After checking the displayed consent and confirming once, the button became busy/disabled and the plan changed only after verified payment.

| Component | Frozen USD minor units |
|---|---:|
| Unused Starter credit | 998 |
| Remaining Elite service | 2163 |
| Due now, 2163−998 | **1165** |

- Quote/operation `6ac71bf03a86ef91425c04ca`, computed 04:28:32 UTC, accepted 04:32:21.272 UTC, applied 04:32:26.579 UTC.
- Payment `6ac71cd53a86ef91425c0a80`, exact capture 1165 USD minor units; reference `billing:6ac71bf03a86ef91425c04ca`.
- Provider TRACKER_ENDED, subscription/MIT, no refund/risk/failure. Merchant UI independently showed **USD 11.65 /Complete /Subscription**, same reference.
- The Oct 8→Nov 8 paid period and next boundary did not restart. Monthly rate 2165, planElite, Meta false.
- Website showed Current Plan Elite; Android Refresh showed Elite and the permanent Elite tools. The base Starter list's 6 featured products is followed by the Elite-specific 12-product override; this was inspected rather than mistaken for a money/entitlement bug.

**Result: PASS.** Evidence: `billing-web-upgrade-quote-11-65.png`, `billing-web-elite-upgrade-paid.png`.

## Live case 4: Android paid Meta add-on

From active Elite, Android's Include Meta draft showed USD 25.65 while clearly retaining **Your current plan USD 21.65** until applied. Apply opened a populated, nonempty review: due nowUSD 3.99, recurringUSD 25.65, Visa 1111. Confirm remained disabled until consent; one confirmation disabled repeat inputs during processing. The app displayed **Subscription updated** after verified success.

Frozen calculation: remaining Elite+Meta 2562 − unused Elite 2163 = **399 USD minor units**. Quote was computed 04:43:02 UTC and did not silently reprice at the later acceptance.

- Operation `6ac71f563a86ef91425c1ad7`, accepted 04:45:34.874 UTC, applied 04:45:39.786 UTC.
- Payment `6ac71fee3a86ef91425c1ea1`, capture 399 USD minor units; reference `billing:6ac71f563a86ef91425c1ad7`.
- Provider TRACKER_ENDED, subscription/MIT; merchant UI independently showed **USD 3.99 /Complete /Subscription**, same reference.
- Elite+Meta, monthly 2565, paid period/next boundary unchanged. No real advertising request, approval or ad spend was triggered; that is a separate seller/admin workflow.

**Result: PASS.** Evidence: `billing-native-meta-quote-3-99.png`.

## Live case 5: discovered add-on over-credit, fix and retest

The first web removal quote offered **USD 4.00 future credit** immediately after the USD 3.99 add-on capture. I did **not** accept that quote; clicked Not now, preserved the evidence and fixed the source. The apparent cent came from independently rounded full-plan proration legs. Repeated add/remove cycles must not create money.

`2af7574c` verifies the current owned Sandbox contract, exact period, original rate and applied paid invoice. Future credit is limited to the actual funded add-on allowance. Paid enrollment/renewal can fund a full add-on month; a partial upgrade only funds its calculated component; introductory free service funds no credit. Reusing genuine prior billing credit is supported without minting more credit. A new fully paid month gets a new funded allowance.

Actual live retest after release:

1. The old unaccepted quote `6ac721633a86ef91425c29b7` was explicitly expired on replay, with no payment or credit. UI said **Choose your plan again to review a fresh quote**.
2. Fresh quote `6ac72cc6e4b40b2ff1756e26` displayed dueUSD 0.00, monthlyUSD 21.65 and future credit**USD 3.99**. Consent was required.
3. Confirm applied at 05:40:33.638 UTC without creating a card payment. Plan became Elite without Meta; credit 399, monthly 2165, same Oct 8→Nov 8 period, version 13.
4. The frozen proof referenced the actual source operation `6ac71f563a86ef91425c1ad7`, allowance 399, original add-on monthly 400. This fresh quote's raw calculated credit was also 399, so its live cap adjustment was 0. The specific raw 400→capped 399 branch is proven by real-database automated regressions, not misrepresented as a nonzero adjustment in this later live quote.

**Result: Original quote FAIL; fixed implementation/retest PASS.** Evidence: `billing-web-meta-overcredit-before-fix.png`, `billing-web-meta-credit-corrected-3-99.png`.

## Live case 6: saved-card partial order refund during a second pause

Temporarily paused both new-checkout flags again. Railway deployment `7454fe8a-cd04-45cb-aa3f-d54462aacbc5`,05:19:01.289 UTC, succeeded; config showed Sandbox, web=false/mobile=false, workers true.

Earlier mixed QA order **ORD-1791396309121**, database `6ac689d5aa0ee55b9c02764a`, original USD 33.11 products +5.72 shipping =**38.83**. Atlas's USD 34.50 portion remained Confirmed. The QA seller's mug 3.61 +shipping 0.72 =**4.33** was still cancellable. The original buyer Visa 1111 had been removed previously; the current shopping default was Mastercard 1096. Refund still correctly addressed the original charge, not the new default card.

Actual buyer order UI: clicked **only the QA store's** cancel action, selected Original Card instead of default full Wallet refund, reviewed processing fee 0.28/net 4.05, checked the deduction consent and confirmed once. The active order page automatically changed In progress→**Refund completed USD 4.05 /feeUSD 0.28**, without reload, navigation, manually settling the payment or calling a worker from the test script.

- Request 05:24:22.565 UTC; cancellation journal `6ac729061e6ff4f402d0eb26`; provider refundedAt 05:24:25 UTC.
- Original payment `6ac689d6aa0ee55b9c027664`: capture 3883, refunded 405, remaining 3478 USD minor units, WalletRefund 0, no risk.
- Actual provider TRACKER_PARTIAL_REFUND; refreshed TEST MODE merchant UI independently showed **USD 38.83 /Partial refund /order:6 ac 689 d 5 aa 0 ee 55 b 9 c 02764 a**.
- Buyer original order total 38.83 stayed immutable; remaining purchase 34.50, cancelled portion 4.33, retained processing 0.28; 34.50+4.05+0.28=38.83.
- Buyer Wallet USD 30.69 /PKR 5840.05 /EUR 1 /GBP 0 stayed unchanged.
- Mug stock 9→10 and totalSales 21→20, once; no Atlas stock/status/shipping change.

| QA seller PKR accounting | Before | After | Explained change |
|---|---:|---:|---|
| Gross online | 7198.92 | 6000.64 | Remove frozen cancelled portion 1198.28 |
| Processing fee+tax | 385.49 | 308.00 | Remove that portion's 77.49 fee |
| Pending online net | 4227.81 | 3107.02 | Remove 1120.79 net |
| Withdrawable | 585.62 | 585.62 | Existing available funds unchanged |
| Reporting revenue estimate | 22393.62 | 21195.34 | Cancelled 1198.28 no longer sales revenue |

This does not introduce a second withdrawal fee or Wallet credit. The ordinary deployed cancellation-refund worker settled it while new checkout was disabled. Both flags were restored true/true after this case, restoration deployment `90609b99-5022-40fb-a929-c410df3d1327` succeeded.

**Result: PASS.** Evidence: `billing-paused-buyer-card-refund-completed.png`, `billing-merchant-paid-billing-and-paused-refund.png`.

## Live case 7: cross-channel downgrade, undo and credited renewal

Android Downgrade to Starter displayed the period-end consequences and an explicit Keep Elite/Schedule downgrade choice. Schedule returned success, preserving Elite, the existing paid period, credit 399 and all three paid captures. Website reload exposed that its undo banner was unreachable, even though the server schedule was correct.

After `7efab001`, the live website visibly showed **Switch to Starter scheduled /Keep Elite benefits until 11/8/2026 /Keep Elite**. Clicking Keep Elite returned **The scheduled downgrade was cancelled**. Audit confirmed pendingDowngrade null, cancelledAt null, autoRenew true, monthly 2165, credit 399, same period, version 15 and no additional charge. Android Refresh retained Elite. This is a verified real UI state change, not an inferred API capability.

The final repeated pause used Railway deployment `c65a282e-f2e6-4339-b98c-696d3ee38ee4`,05:50:03.465 UTC, SUCCESS. Both flags werefalse and workers true. In the Android app, toggled Include Meta and tapped Apply Meta ads change: an actual **Checkout unavailable /Card payments are temporarily unavailable on this surface** alert appeared. No new quote/payment or entitlement was committed; refreshing restored the real Elite plan.

While still paused, the website scheduled Starter again and displayed the reachable notice, disabled **Starter scheduled** button and **Cancel Subscription**. Tested cancelling the entire renewal while this downgrade was pending:

- UI became Cancellation Scheduled/Ending through 11/8; the downgrade was cleared.
- Read-only audit: Elite active, monthly 2165, credit 399, autoRenew=false, nextChargeAt=null, pendingDowngrade=null, original paid period unchanged, version 17; **still exactly three paid captures**.
- **Keep Subscription** on the website resumed the same agreement while paused, then the website rescheduled Starter successfully. No charge or trial reset was performed by these management actions.

Applied the guarded QA clock fixture once for cycle 1 at 05:58:38.338 UTC, retaining the cycle/key and original period start; it submitted zero charges and changed no payment status. The ordinary deployed billing worker then processed the period-end downgrade while both new-checkout switches remainedfalse.

| Next-period calculation | USD minor units |
|---|---:|
| Frozen next Starter monthly price | 999 |
| Previously funded add-on credit applied | −399 |
| **Actual next card capture** | **600** |
| Remaining credit | 0 |
| Following monthly price | 999 |

- Operation `6ac73119494972b9b3a1678a`, kind downgrade, applied 05:58:55.165 UTC.
- Payment `6ac73119494972b9b3a16791`, paid/applied, exact capture 600 USD minor units, no refund/risk/failure.
- Merchant reference `billing:6ac73119494972b9b3a1678a`.
- Actual provider TRACKER_ENDED, subscription/MIT, quote/captureUSD 6.00; merchant TEST MODE UI independently showed **USD 6.00 /Complete /Subscription**, same reference.
- PlanStarter, monthly 999, Meta false, credit 0, cycle 2, autoRenew=true, no pending downgrade/payment/failure; paid access Oct 8 05:58:38.338→Nov 8 05:58:38.338 UTC.
- The adjusted timestamps are deliberate accelerated fixture time; they are not thirty elapsed days or a changed customer period on an ordinary account. Both clock changes have durable before/after receipts.
- Website showed Starter Current Plan. Android Refresh showed **Rozare Starter /Active /through Nov 8**, Starter features and the existing account's already-expired Elite bonus state. Expired bonuses were not silently regranted by paid downgrade.
- All original three billing payments and their amounts remained unchanged. There were exactly four paid captures: **9.99+11.65+3.99+6.00 = USD 31.63**. Removing the add-on created billing credit, not a fifth charge or seller-sale earning.

**Result: PASS after fixing and live-retesting the web undo visibility.** Evidence: `billing-web-downgrade-undo-visible.png`, `billing-paused-native-new-quote-blocked.png`, `billing-paused-cancel-pending-downgrade.png`, `billing-native-paid-starter-after-credit.png`, `billing-web-starter-after-paid-downgrade.png`, `billing-merchant-four-paid-subscription-captures.png`.

## Final balance, delivery and cleanup readbacks

After all four subscription captures and the order refund, the actual website Payments page and Android Payments & Revenue screen independently showed:

| Seller PKR amount | Website | Android | Result |
|---|---:|---:|---|
| Gross online earnings | 6000.64 | 6000.64 | PASS |
| Processing fee+tax | 308.00 | 308.00 | PASS |
| Pending online net | 3107.02 | 3107.02 | PASS |
| Available to withdraw | 585.62 | 585.62 | PASS |
| Delivered COD | 5598.36 | 5598.36 | PASS |
| Total delivered revenue | 17996.32 | 17996.32 | PASS |
| Estimated revenue | 21195.34 | 21195.34 | PASS |

Android Dashboard also showed PKR 21195.34,30 orders,1 product, matching the post-cancellation report. The subscription purchases remained separate USD billing expenses; they did not debit/convert the seller's PKR sale balance or invent sales. Available 585.62 stayed below the existing PKR 2000 withdrawal minimum; no bank withdrawal/transfer was performed in this task. The final read-only refund audit still showed stock 10, totalSales 20, one 405-cent card refund, WalletRefund 0 and unchanged buyer Wallet. No later double refund/restock was observed.

Delivery evidence for this QA subscription and its billing operations since Oct 8:

- Durable outbox: **13 delivered per channel**—2 cancellation notices plus 11 payment/lifecycle notices—for in-app, push, email, WhatsApp. The scope had no pending/retry/dead delivery or error code at this readback. Lifecycle notices include scheduling/resumption;13 is **not** a claim of 13 charges.
- The Android OS's first real heads-up subscription-renewal notification was visually observed and saved. Other push rows mean dispatcher/provider delivery acceptance, not independently observed display of every notice on a physical phone.
- Email delivered rows mean sending-provider acceptance; every external email inbox was not opened to prove final mailbox placement.
- The test number pool recorded 12 matching outbound subscription/Starter/Elite WhatsApp copies. These are **virtual QA inbox records**, not proof of delivery to 12 physical WhatsApp phones. The durable outbox remains the complete lifecycle ledger; the text-search count is not used as an exact one-to-one delivery assertion.
- A read-only audit found **zero currently active/free-period Sandbox Meta-inclusive contracts** after the QA seller's downgrade; no other existing active Meta contract was left waiting on the new funded-credit proof.

Final restoration deployment `dd082efd-5f00-48c3-9bf0-37dbda09768f`,05:59:54.204 UTC, **SUCCESS**. Runtime configuration read: `SAFEPAY_ENV=sandbox`, web=true, mobile=true, workers true. Backend health matched `7efab001`. Railway CLI was restored to **tech@eyekonit.com** after every scoped operation. Production Safepay was never enabled. No account deletion, password reset, real bank payout, extra wallet system, Stripe-removal rewrite or real-money pilot was performed.

Evidence: `billing-native-final-earnings-unchanged.png` and the merchant/renewal/refund images above. Screenshots are local test artifacts under the primary checkout's `test-artifacts/`; generated assets and unrelated work were not added to application commits.

## Edge-case coverage and what the evidence establishes

| Case or invariant | Verification method | Result |
|---|---|---|
| Disabled web and mobile reject new paid quotes | Actual website and Android UI with both flagsfalse | PASS |
| New order, Wallet top-up, card setup, domain/subscription agreement entry points stay gated | Controller/feature-flag regressions,72 switch combinations across Sandbox/Production-config fixtures | PASS; not 72 live merchant transactions |
| Existing owned payment status/reopen/card management stay allowed | Actual controllers with mocked service boundaries; ownership/config/surface negatives included | PASS |
| Existing signed financial event/refund processing continues after paused startup | Durable real-Mongo webhook-queue tests plus actual Sandbox recurring captures and partial card refund | PASS |
| Missing, invalid, cross-environment credentials stop work without fallback | Feature-flag/config/controller and durable-worker tests | PASS |
| Transient webhook retry is retained and then recovered | Durable real-Mongo worker tests | PASS |
| Paused cancel/resume/downgrade/undo preserve funded access | Actual web/Android management actions and current provider/database readbacks | PASS |
| Paid upgrade and Meta addition use frozen quoted due amounts | Actual web/Android consent and Sandbox captures 1165/399 | PASS |
| Dismissed/expired quote grants no entitlement or charge | Actual Not now/reopen, expired unsafe quote, real-engine regressions | PASS |
| Add-on removal cannot create more credit than funded | Live 399 allowance proof; real-DB raw 400→399, fully credit-funded re-add/removal and new-month funding regressions | PASS |
| Next scheduled downgrade uses frozen price and credit once | Actual worker capture 600/credit 399, Sandbox merchant, website, Android | PASS |
| Declined first/renewal payment grants no unpaid access; retry needs fresh consent | Actual engine/adapter plus real DB with controlled external HTTP 400/402/403/422; exact original period preserved | PASS under controlled-HTTP test boundary |
| Official insufficient/stolen/expired processor rejection | Three actual Sandbox provider-only probes; no charge, no plan-price rewrite | PASS as gateway rejection checks; not a normal-price Rozare UI retry journey |
| Lost paid/pending response does not submit a second capture | Actual engine/adapter + real DB, controlled lost-response provider fixture | PASS |
| Cancellation before/after capture claim is race-safe | Real-DB engine/lifecycle tests, no future renewal and preserved funded access | PASS |
| Stale/foreign quote, card deletion race, invalid money or tampered credit proof | Ownership/transaction/strict-money regressions | PASS |
| Calendar 31 st, February, leap-year anchors; excessive missed billing does not catch up silently | Billing-math/lifecycle tests | PASS |
| Scoped refund preserves other sellers, stock, Wallet and fee conservation | Actual Sandbox buyer cancellation, merchant, real DB, web readback plus concurrent-cancellation/refund-response regressions | PASS |
| Paid access dates and reachable web undo | Actual loaded OTA and released website, whole-component rendering regressions | PASS after fixes |

## Scope of the completion claim

The requested pause safeguards are implemented/released, and the described paid billing, refund, management and credit scenarios have passed. The verification skill influenced the work by tracing UI→server→provider→stored money→UI, and by stopping at the observed date, over-credit and hidden-undo defects to fix and retest them instead of trusting a success toast.

This is **not a mathematical guarantee that every possible future payment or device will work**, and it is not a claim that every row above was a separate live UI transaction. The normal-price declined-invoice retry and lost-response/race cases use controlled external HTTP; their internal adapter, engine, transactions and invariants are real. Renewal dates were accelerated on one explicitly scoped disposable Sandbox subscription. Real production charges, settlement, bank payout/card-refund arrival, merchant approval and every physical-device delivery remain outside the evidence. No recommendation here silently enables production payments.

Read-only/guarded diagnostic helpers retained with the report: `auditSafepayBillingQa.js`, `auditSafepayPauseOrderQa.js`, `probeSafepaySandboxBillingDecline.js`, `prepareSafepayBillingQaClock.js`. Probe and clock helpers are Sandbox-only, named-QA-account-only and journaled; the first two audits only read. No new public diagnostic endpoint was introduced.
