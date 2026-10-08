# Dependency security and remaining Safepay Sandbox journeys

Date: 8 October 2026, Asia/Karachi.

**The four requested Sandbox journeys and final stable-runner verification are completed.** Payments and refunds reconcile under the existing frozen rounded-USD settlement policy. The additional EUR-to-USD-to-PKR rounding step is explicitly explained in section 5; no new FX accounting policy was silently substituted.

## 1. Scope and preservation

The actual website/Android UI, Safepay merchant ledger and reporter GET responses, frozen database records, stock and seller balances were compared. Live journeys were not simulated by marking records paid, invoking settlement manually or mocking provider success.

Safepay stayed **Sandbox**, both checkout surfaces enabled, dormant Stripe disabled. Real charges/bank payouts, merchant live approval/configuration and test-data deletion are outside this task.

Only QA accounts bought products or subdomain protection. Admin was used solely to reactivate Nova's expired test trial. Unrelated primary-checkout email/WhatsApp/auth/gallery drafts and generated assets were preserved and excluded from release.

## 2. Dependency security

Implemented:

- Multer **2.2.0 → 2.4.0**, with bounded files/fields/parts, field size/name and array indexes.
- Fixed safe multipart **400/413** errors; attacker field names, filenames and parser internals are not reflected. Unknown internal failures still reach the existing error handler.
- Axios **1.19.0 → 1.20.0** across backend, website and mobile.
- Compatible XML, IP/proxy-address, query-parser, brace-expansion, compression, shell-quote and source-map patches, selected by dependency branch.
- Additional compatible **js-yaml 3.15.2 / 4.3.2**, **Browserslist 4.28.7** and **@humanfs/node 0.16.8** tooling patches.

Existing 5 MB single-image and 15 MB-per-chat-file contracts remain. Malformed/oversized multipart, field/file counts, huge array indexes, prototype-shaped fields, MIME rejection, safe errors and a healthy following request were tested **only in isolated local Supertest**, never by attacking the live site. A generated DOCX extraction test verifies the patched Mammoth/XML path and confirms that argparse/sprintf CLI formatting is not loaded during extraction.

### Mobile URI decoder

Patched upstream decoder **0.5.0** is ESM-only; React Navigation 6/query-string 7 expects callable CommonJS. The install script verifies the exact upstream version and SHA-256, adapts only export packaging, retains the algorithm/license, is idempotent and rejects tampering/unknown source.

A fresh normal `npm ci` successfully ran this postinstall. Unicode, Urdu, malformed percent input and payment query literals are tested. The Android release source map contains the patched decoder/Axios and **zero modules** from node-forge, braces, sprintf-js and shell-quote.

### Audits and remaining warnings

Production-install dependency-tree audit:

| Project | Before task | Compatible patched result |
| --- | --- | --- |
| Backend | 12: 1 critical, 4 high, 7 moderate | 3 moderate; no high/critical |
| Website | 2 high | 0 |
| Mobile | 36: 1 critical, 26 high, 9 moderate | 27: 22 high, 5 moderate; no critical |

Full build/test-inclusive audit:

- Website: **0**.
- Backend: **33** inherited findings, 27 high/6 moderate, from the remaining **braces** test-tool and **sprintf-js** CLI leaves.
- Mobile: **46** inherited findings, 41 high/5 moderate, from framework/build/test **braces, node-forge and sprintf-js** leaves.

Parent packages are counted too; these are not that many independent customer-facing defects. Published patched leaf versions are unavailable in their compatible branches. Jest 30.5.2 removes a backend braces chain, but its compatibility run stalled this repository's harness and was not adopted. Only that task-owned test process was stopped—not the deployed service. The verified runner is pinned at **30.2.0**. The compatible YAML/lint/Browserslist patches remain.

Warnings are documented, not suppressed or universally called harmless. Build hosts should use trusted input/configuration; compatible upstream fixes must be revisited. Android bundle absence is runtime-inclusion evidence, not a guarantee about every build host.

Primary references: [Multer release](https://github.com/expressjs/multer/releases/tag/v2.4.0), [Multer maintainer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm), [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

## 3. Actual defects fixed during testing

| Problem before | Correction and live verification |
| --- | --- |
| “Use a new card” automatically attached an existing merchant-owned saved-card profile. Hosted checkout switched to shopper authentication while requesting merchant-only card-on-file enrollment, returning “this request requires merchant authentication.” Fresh authorization reproduced it. | Ordinary new-card purchases use guest checkout. Only an explicitly selected owned reusable card attaches its saved profile. Card setup/subscription bindings remain distinct. The post-fix GBP new-card purchase completed 3-D Secure. Existing payment identities were not rewritten. |
| Interrupted saved-card device collection could remain at STARTED/PAYER_AUTH_ENROLLMENT without a usable retry. | Explicit retry can reset that **uncaptured** setup and authenticate the same tracker/card/amount. Charged, authorised, paid and terminal payments cannot reset. Unknown reset outcomes are not blindly resubmitted. The exact Android USD payment recovered and captured once. |
| Global browser checkout draft could carry delivery details between signed-in accounts. | Account-scoped storage plus owner-keyed form remounting. Unowned old drafts are not imported. Only an explicit, expiring guest submission may hand off a draft once to its next sign-in. Live: same-account reload restored the seller QA draft; the separate buyer's name/address stayed blank. Guest handoff/expiry/storage failures are also unit-tested. |
| Closing Android ownership checkout could imply “No charge was made.” | Correct pending/review/closed wording. Actual close-before-pay showed **Ownership payment pending**, then resumed the same purchase and became verified ownership. |

No new subscription upgrade, bank payout, native permission or financial conversion policy was introduced.

## 4. Android USD multi-seller purchase: PASS

Buyer: **Safepay Buyer QA**.

Order **ORD-1791458354714**, database **6ac77c324e31b5b94a6ee17d**, payment **6ac77c344e31b5b94a6ee19b**.

Actual Android actions: select USD, add Atlas wallet, choose **Green** in the native mug option picker, select each store's paid standard shipping, select saved Mastercard ending 1096, review USD 38.83 and complete the bank challenge after recovering the interrupted setup.

| Buyer component | Frozen USD |
| --- | ---: |
| Wallet + mug products | 29.50 + 3.61 = **33.11** |
| Atlas + QA shipping | 5.00 + 0.72 = **5.72** |
| Tax/discount | 0.00 |
| **Captured total** | **38.83** |

| Seller | Buyer allocation | Seller-native gross | Native deduction | Net pending |
| --- | ---: | ---: | ---: | ---: |
| Atlas | USD 34.50 | USD 34.50 | USD 2.24 | USD 32.26 |
| QA store | USD 4.33 | PKR 1,199.76 | PKR 77.58 | PKR 1,122.18 |

Buyer allocations **34.50 + 4.33 = 38.83**. The complete-checkout deduction is **USD 2.52**, allocated **2.24 + 0.28**; PKR 30 is not charged separately per seller.

QA's native summary is **PKR 1,000 product + 200 shipping − 0.24 reconciliation = 1,199.76**. USD 4.33 × 277.08 = 1,199.7564, rounded to 1,199.76.

Safepay reports **TRACKER_ENDED**, capture **3,883 USD minor units**; merchant ledger source is **mobile / Complete**. The original order/payment/tracker survived retry. Android displays Payment confirmed, Green retained, and two store totals 34.50/4.33. Each web seller detail shows only its own product/shipping.

The order stays confirmed as a disposable QA purchase. No physical shipment or withdrawal was performed.

## 5. EUR product checkout/refund: PASS under existing FX policy

Order **ORD-1791454004711**, database **6ac76b344e31b5b94a6e65c2**, payment **6ac76b354e31b5b94a6e65d3**.

This was a **Green PKR-priced mug product order paid in EUR**, not a Wallet top-up:

**EUR 3.22 product + 0.64 shipping = 3.86 captured.**

Buyer selected Original card and acknowledged the fee:

**EUR 3.86 − 0.34 processing = 3.52 original-card refund.**

Website shows Refund completed. Safepay confirms capture **386**, refund **352**, remaining **34 EUR minor units**, one refund event and **TRACKER_PARTIAL_REFUND**. “Partial” is expected because the disclosed fee is retained. No Wallet credit was also created. Stock and seller earnings were restored on cancellation.

### Important existing extra rounding step

Saved rates: USD 1, PKR 277.08, EUR 0.893, GBP 0.757.

The current contract rounds EUR 3.86 / 0.893 to **USD 4.32**, then converts:

**USD 4.32 × 277.08 = PKR 1,196.9856 → 1,196.99.**

The native saved summary is therefore:

**PKR 1,000 + 200 − 3.01 reconciliation = 1,196.99.**

**Direct EUR-to-PKR conversion without intermediate USD-cent rounding would be PKR 1,197.68: a PKR 0.69 difference.** This is an existing design, not caused by this task. Tests pass against that ledger contract, not an unrounded direct-cross-currency policy.

Same-currency buyer/seller amounts bypass conversion. Source product/shipping prices remain frozen separately. Changing foreign-currency reconciliation should be an explicit, versioned new-order policy; old frozen records were not revalued here.

## 6. GBP new-card product purchase/refund: PASS

QA seller acted as a **buyer at Atlas**, not its own store.

Order **ORD-1791459852117**, database **6ac7820c71bfcb6bd94b9884**, payment **6ac7820c71bfcb6bd94b988f**.

**GBP 22.33 product + 3.79 shipping = 26.12 captured.**

The corrected new-card flow completed actual Sandbox bank authentication without a separate Safepay shopper password/account or a card-storage selection.

The final read-only profile check confirms this QA account still has a ready consented saved-card profile, while this new-card payment has no attached merchant customer. The fix did not remove its saved profile to make the test pass.

Atlas native gross: **USD 29.50 + 5.00 = 34.50**. Original native deduction/net pending: **USD 2.25 / 32.25**.

Buyer cancellation:

**GBP 26.12 − 1.70 processing = 24.42 original-card refund.**

Safepay confirms capture **2,612**, refund **2,442**, remaining **170 GBP minor units**, one refund event and PARTIAL_REFUND. Website **and Android** show Refund completed / GBP 24.42 → original card / fee GBP 1.70.

The full cancelled sale and seller fee are removed from Atlas earnings; seller funding is not needed. Android correctly permits this seller-role account to view its own buyer purchase.

Pre-fix GBP 3.28 diagnostic attempt **6ac771e54e31b5b94a6e978e** remains explicitly unpaid/uncaptured/unapplied. It is not counted as successful, has no stock/earning effect, and was not rewritten to conceal the failure.

## 7. Fresh Android subdomain purchase: PASS

Nova had no ownership grant and an expired/blocked test trial. Normal admin UI reset only this fixture for 30 days, ending 7 November. Android changed its removed/tombstone address to **novanest-qa-20261008.rozare.com**, displaying the 30-day address-change cooldown.

Payment **6ac76b244e31b5b94a6e654a**, tracker **track_1ea1cbda-f008-4a3d-80b0-a254b90af102**.

Android displayed USD 15.00 one time / three years. Closed before payment, saw the accurate pending message, resumed the same attempt, then completed the card/bank challenge.

Safepay: **1,500 USD minor units captured / TRACKER_ENDED / mobile source**.

Exactly one grant **6ac777e94e31b5b94a6ec28d**:

**8 October 2026 11:00:57.618 UTC → 8 October 2029 11:00:57.618 UTC.**

Android displays Protected for 1096 more days / Oct 8, 2029. Nova online/withdrawable remains **PKR 0**; existing recognized revenue remains **PKR 7,530**. Ownership is not invented as seller product revenue.

This is Rozare subdomain protection, not an external domain-registrar purchase or recurring subscription.

## 8. Seller dashboards and conservation

| Balance | Before | Final |
| --- | ---: | ---: |
| QA online gross | PKR 6,000.64 | PKR 7,200.40 |
| QA processing fee + tax | PKR 308.00 | PKR 385.58 |
| QA net pending | PKR 3,107.02 | PKR 4,229.20 |
| QA withdrawable | PKR 585.62 | **PKR 585.62** |
| Atlas online gross | USD 240.47 | USD 274.97 |
| Atlas processing fee + tax | USD 4.48 | USD 6.72 |
| Atlas net pending | USD 139.24 | USD 171.50 |
| Atlas withdrawable | USD 76.71 | **USD 76.71** |

Only the retained Android USD sale remains as new revenue. The EUR/GBP cancellations do not remain counted. QA web **and Android** Payments match the PKR figures; Atlas web Payments matches USD. Confirmed new money does not become immediately withdrawable.

QA dashboard revenue increased by its native **PKR 1,199.76**, to **22,395.10**. It shows 32 orders and 9 remaining mug units, correctly triggering low stock.

Atlas 30-day Analytics: revenue **USD 304.96**, recognized orders/units **9/9**, average **33.88**. Top products **138.00 + 119.96 + 47.00 = 304.96**. Online gross **274.97 + recognized delivered COD 29.99 = 304.96**. Its all-history reporting estimate **707.92** includes historical currency equivalents; it is not the native withdrawable balance.

QA Advanced Analytics is correctly plan-gated after bonus expiry. No upgrade bypassed that gate, and those premium metrics are not claimed as inspected.

Independent integer/rational checks verify component totals, buyer allocation sums, the existing USD-ledger native contract, combined fee/proportional shares, refund conservation and stock.

Final stock **mug 9 / wallet 18**, versus 10/19 initially: only one retained paid unit of each. Repeated reads do not create extra captures/refunds/grants/restocks.

Buyer Wallet stays **USD 30.69 / PKR 5,840.05 / EUR 1 / GBP 0**. Seller-as-buyer Wallet is zero in every currency. Card refunds did not also credit Wallet.

Order detail was inspected for native gross, product/option/shipping and buyer equivalent. Per-order seller fee values above were checked in frozen records; separate seller deduction rows are not currently rendered in the existing order-detail UI. Aggregate deduction/net amounts were verified in Payments. No new per-order deduction UI is claimed.

## 9. Tests, release and limits

- Backend: final clean installation and pinned Jest 30.2.0 repeat **257 suites / 3,895 tests passed**, zero failures, in 908.323 seconds.
- Website: **513 tests**, policy-publication guard and complete production client/SSR/policy builds passed.
- Mobile: fresh normal npm ci/postinstall succeeded; final clean-install rerun **117 suites / 1,310 tests passed**.
- A cold concurrent mobile run timed out one existing return-modal test; unchanged isolated and full warm reruns passed. No assertion or five-second timeout was weakened.
- Passing negative-path tests deliberately log invalid money, missing local Stripe configuration, provider failures and simulated push failures. Those logs are not production incidents.

Android [published update group df710289-903b-4c57-b796-68bcda6c3fa3](https://expo.dev/accounts/rozare/projects/rozare/updates/df710289-903b-4c57-b796-68bcda6c3fa3), update **01a11af2-aed2-793e-8abf-b7112e768da0**, runtime **1.0.13**, APK **1.0.13/code 17**. Production update channel does not mean production Safepay.

SDK app restart preserved data; the new pending-ownership wording visibly proves the update loaded. No new native dependency/permission/ABI change or APK is needed. A physical phone's update/push delivery was not independently verified.

Source changes are scoped and pushed to both existing repositories after checks; no force push or unrelated draft release. Dormant Stripe remains disabled/retained. Old financial records, wallets and earned currencies were not migrated. The unpaid buyer cart used for draft testing was cleared; paid/refund/ownership evidence remains.

The final tested code baseline is **8d67e573**. The following report, read-only evidence helper and EAS artifact-exclusion changes do not alter payment amounts or runtime money logic. Generated test results, export folders and screenshots are excluded from future native build archives.

Commits: **b310ff83** runtime security; **3bff4eee** compatibility/ownership wording; **a780a320** scoped audit/release hygiene/report-link correction; **12d7edd3** new-card binding; **d1c9ebd2** interrupted setup recovery; **635a98de** draft isolation; **df3eea65** compatible tooling plus runner trial; **8d67e573** restore/pin verified runner, retaining compatible patches.

Local proof directory: **C:/Users/Salman/Desktop/hello-friend/test-artifacts/**. Key files: security-all-four-merchant-ledger-20261008.png, security-native-usd-paid.png, security-native-usd-qa-allocation.png, security-native-subdomain-owned.png, security-native-ownership-pending.png, security-eur-refund-complete-20261008.png, security-gbp-refund-complete-20261008.png, security-native-gbp-refund-complete.png, security-native-qa-payments.png, security-atlas-web-payments-20261008.png and security-web-cross-account-draft-isolation-20261008.png.

Railway QA commands run reviewed **local read-only code** with authorised remote configuration. Provider/database GET evidence and actual deployed UI readbacks are distinct; this is not remote installed-package introspection.

The 6.2% + PKR 30 deduction is Rozare's specified policy, not an independently verified gateway invoice/statutory tax liability. Real issuer settlement/refund timing, bank transfers, merchant live activation, every device, generalized live DoS/load resistance and every future incident are not certified. No universal “100% safe” or changed direct-FX policy is claimed.
