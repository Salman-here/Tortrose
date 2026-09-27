# Safepay sandbox mobile migration — release verification

## Current status

Implementation and live verification are still in progress. Do not interpret a successful APK build or unit-test run as proof that every live flow is complete.

**Build checkpoint:** Android **1.0.13 (17)**, build `3e1f80b0-5f42-4f6f-b9d4-ab18baa6ccf3`, finished successfully with the clock-correction retry-key and Payment Methods fixes. The downloaded APK's signature/package checks passed, it installed successfully on the emulator without clearing data, and the home screen, retained seller login and saved-card screen passed the installed-build smoke check. Build 16 was cancelled, and builds 15/16 are superseded as the final download recommendation. The Payment Methods fix is also published as a compatible Android update and verified on the emulator for both buyer and seller. Payment verification is still being completed; this is not a production-payment release.

The website checkout remains Stripe. All new mobile card purchases are routed to Safepay sandbox; real Safepay production payments are not enabled.

## Current sandbox APK — 17

- [Download Android APK 1.0.13 (17)](https://expo.dev/artifacts/eas/n1aVqph68KuXKBGUvCnO9ywFqFlVdY_6RGJlXWfB1W8.apk)
- [Expo build details](https://expo.dev/accounts/rozare/projects/rozare/builds/3e1f80b0-5f42-4f6f-b9d4-ab18baa6ccf3)
- Package `com.rozare.app`, version **1.0.13**, Android version code **17**, runtime **1.0.13**.
- Built from commit `7530c0b4`. Minimum Android SDK 24, target SDK 36; includes arm64-v8a, armeabi-v7a, x86 and x86_64.
- Local artifact: `test-assets/rozare-safepay-1.0.13-17.apk`, **112,795,359 bytes**.
- SHA-256: `eab9f8992d9d4d73ffe0eb389e198ead4bfcdd3d077dd8e373562120b3865f0d`.
- Android APK Signature Scheme v2 verification passed with one signer. No Play Store release or production card charge was performed.
- The later first-card billing-contact correction is delivered by backend deployment and a compatible Android update for runtime **1.0.13**; it is not part of APK 17's original embedded bundle. Existing build-17 installations can receive it without reinstalling.

## Earlier verified build — 14 (historical checkpoint)

- Android app version: **1.0.12**, version code **14**, runtime **1.0.12**.
- Expo build: `8740a7f2-131e-4e40-89fd-255a3c5221e2`, completed successfully.
- [Build details](https://expo.dev/accounts/rozare/projects/rozare/builds/8740a7f2-131e-4e40-89fd-255a3c5221e2)
- [Test APK](https://expo.dev/artifacts/eas/_SyZPcNBXNjF-7fnYBbVI2UCzxr_0FC-Z7-uJf-fR_k.apk)
- APK downloaded locally and installed successfully on `RozareQA` Android emulator. Home screen rendered correctly.
- The build used the local working tree. Expo's recorded Git revision `f88cb5c2` is the parent commit, not a claim that the new mobile source was already committed at build time.
- Backend/server secrets, Backend/Frontend source and test-assets were excluded from the mobile archive. No server key is embedded in the app.

## User-approved checkout policy

An abandoned checkout is not automatically invalid. Reuse the same payment attempt when it is still valid. Never create another payment merely because the panel closed.

New Safepay orders freeze buyer and seller money at checkout but do not hold product inventory or coupon capacity indefinitely before payment. Before reopening and again during verified fulfillment, check the original native product price, seller status, store delivery availability, options, shipping and stock. During fulfillment, atomically reserve all items and coupon capacity. If the purchase cannot be fulfilled, do not fulfill a partial order: record a durable full-refund request to the original card.

Explicit buyer cancellation remains authoritative. A later capture for that cancelled purchase goes to the refund path, not order reactivation. Unknown payment/refund responses are reconciled on the same provider tracker rather than blindly retried.

Safepay's hosted Cancel button was observed returning to Rozare while leaving an unpaid tracker `TRACKER_STARTED`. The user-approved late-payment policy resolves the earlier requirement to block all progress waiting for provider cancellation support. It does not mean a redirect is payment proof.

## Embedded mobile checkout

- Payment UI opens in a full-screen in-app WebView with a close control and visible sandbox label.
- Card entry stays on Safepay's secure page; Rozare never receives raw card details.
- Provider URLs remain only in memory, not navigation state or device storage.
- All close, back, error and provider-return paths verify the owned payment with the backend. No page URL or WebView message can mark an order paid.
- An explicit URL policy blocks insecure/custom-app links, while HTTPS bank authentication can proceed. No app bearer token is injected into payment content.
- The native Stripe SDK and its Android pinning plugin were removed; historical Stripe records remain readable.

## Latest verification checkpoints

| Check | Observed result |
| --- | --- |
| Full mobile tests, including billing-contact and subscription-review dialog fixes | **104 suites, 1,189 tests passed** |
| Full backend regression, including billing-contact recovery | **234 suites, 3,472 tests passed** |
| Notification authority/recovery regression | **77 targeted tests passed**, plus four worker tests after rolling-deployment recovery adjustment |
| Android Hermes export | **Passed**, 2,304 modules |
| Native build configuration | **Passed** |
| EAS signed APK build | Build 17 **passed**, downloaded and signature-verified; build 16 cancelled |
| Emulator install and initial home screen | **Passed** for build 17; seller login and saved card preserved |
| Payment Methods opening and refresh | **Passed on Android** with the latest runtime-1.0.13 update; buyer empty-card state loads and refreshes without the render exception |
| Actual embedded sandbox wallet payment | USD 1.00 **paid and displayed**; the separate clock-recovery issue found during retry is fixed and regression-tested |
| Product payment, delivery accounting, full refund | **Passed via live API + provider browser**, exact PKR 1,200.00 flow; not claimed as native order-entry coverage |
| Saved card, Starter trial, cancel/resume, subdomain purchase | **Passed via live API + provider browser**; native seller card/Starter display and actual subscription push also verified |

Test examples already passing locally: valid late payment reserves stock once; sold-out late payment schedules one refund; changed native price leaves the frozen order untouched and takes the refund path; explicitly cancelled order stays cancelled; refund timeout does not issue another refund; partial/final return shipping is refunded once; multi-currency order refunds conserve original seller-native money.

The earlier account-free capability probe completed two sandbox recurring payments from the same explicitly saved test card, one PKR and one USD. Both were refunded, and the probe card was removed. That establishes provider capability, not a completed in-app end-to-end subscription test.

## Remaining release checks and limitations

- Current backend is deployed with sandbox credentials. Complete actual mobile payment flows before declaring readiness.
- Still not established by live native tests: full product-order entry/checkout from the app, declined-card and interactive 3DS challenge paths, paid plan renewal/upgrade/Meta add-on/downgrade, and the full mixed-currency/multi-seller payment matrix. Automated coverage and API/provider-browser checks are identified separately above.
- Complete provider-refund, reversal, dispute and recovery coverage. Some Wallet/return-funding/provider-risk cases deliberately hold money for review; they are not silently cleared or represented as automatically reconciled.
- The refunded test order retains its historical paid/delivered status in the order view; refund notifications and the seller payment-reversal ledger reflect the refund, but a dedicated order-detail refund summary has not been implemented or verified in this phase.
- **Separate mobile display issue observed:** Store Subdomain's “Recognized revenue” tile follows the shopping currency instead of the store currency. With this PKR store and USD shopping preference it displayed **USD 4.33**, while seller Dashboard/Payments correctly displayed **PKR 1,200.00** historical revenue. The screen requests subdomain analytics using `CurrencyContext.currency`. Ownership and payout balances were unaffected. This is not marked PASS or changed by the Payment Methods crash fix.
- Unpaid subdomain/return settlement locks remain resumable but require further abandonment/expiry coverage.
- Compatible dependency patches removed the high-severity npm findings. Four moderate audit entries remain in the existing navigation dependency chain (`decode-uri-component`); npm proposes a breaking navigation upgrade. No unrelated major upgrade was applied.
- No real card charge, real bank payout, Play Store publication or physical-device push delivery is claimed.

## Live verification update — 26 September

- Commit `8a46920d` was pushed to both configured GitHub repositories using the existing repository account. Railway deployed it successfully; `/health` reported that revision and a connected database.
- Safepay is enabled **in sandbox only**. The website card checkout remains Stripe.
- Fresh buyer `rozare-safepay-buyer-20260925@mailinator.com` was created through the normal browser signup and actual emailed OTP. Its authenticated config response confirmed Safepay sandbox enabled. No admin account was used as the buyer.
- A second fresh account, `rozare-safepay-seller-20260925@mailinator.com`, entered the seller-onboarding flow and received its real email OTP; store completion is still being verified.
- Live logs exposed a provider-adapter bug missed by the earlier plain-object mocks: spreading a Mongoose payment document dropped getter-backed amount/currency/ownership fields during provider validation. Explicit immutable-field extraction fixes this while keeping every merchant/environment/reference/money check enforced.
- Checkout retry errors could also escape the Express handler because its async recovery helper was returned without `await`. Both ordinary replay and duplicate-key recovery now return controlled errors.
- Regression tests exercise an actual Mongoose payment document and the async controller failure path. **52 focused tests passed** for that fix; **45 service tests passed** before the controller extension.
- Android UI verification still requires the emulator to be reopened and the fresh test buyer signed in after the PC/session interruption. The installed signed APK is preserved; this is not a claim that its full payment UI has passed yet.

## Further verified results — 26 September

- Commit `cc8c0677` was pushed to both repositories and deployed successfully. Live health reported `cc8c06777a79ed882806fd2bee6d07b4c24c1433`.
- Final complete backend rerun: **232 suites, 3,441 tests passed, zero failures** (`test-assets/safepay-final-backend-20260926.json`).
- **Wallet top-up PASS (live API + provider browser, not an embedded Android payment):** the fresh buyer completed a **PKR 2,000.00** sandbox card checkout. Payment `6ab7696cf1585bb3833ae3c8`, provider tracker `track_969e462f-a5e7-4137-a190-d8c99b03994d`, reached `paid` / `TRACKER_ENDED`; the status API reported `webhookProcessed: true`. Wallet transaction `6ab76b53f1585bb3833aefe2` credited exactly PKR 2,000.00. A later status poll and wallet reload returned the same transaction, one credit only, PKR 2,000.00 and USD/EUR/GBP zero.
- **Fresh seller onboarding PASS:** `rozare-safepay-seller-20260925@mailinator.com` verified email and WhatsApp through the normal browser flow. Reserved test WhatsApp number `+12025550120` received its OTP in the admin test inbox. Store `6ab76b67f1585bb3833af082` / `safepay-qa-store` is PKR with Pakistan visibility. No admin account was used to buy or sell.
- **Catalog/shipping setup PASS:** created the test-only Safepay QA Travel Mug, product `6ab76c69f1585bb3833af7d9`, with a previously generated image, PKR 1,000.00 price and 12 stock. The backend returned approved moderation and the correct native currency. Free delivery and standard delivery at PKR 200.00 / 5 days were saved and independently read back. No order against this product has yet been verified in this phase.
- **Reusable card setup PASS (live API + provider browser):** payment `6ab76c3df1585bb3833af686` authorized card storage without a charge. The explicit provider save-card checkbox was selected. The owned card API returned a usable Visa ending 1111, expiry December 2030. No separate Safepay signup was requested.
- **Starter enrollment PASS (live API):** operation `6ab76cd8f1585bb3833afacb` applied exactly once with zero due now, 30 free days, USD 9.99 monthly afterward and Safepay automatic renewal. The subscription status independently showed a free period ending `2026-10-26T06:58:14.833Z`. Attempting to delete its active billing card returned HTTP 409 `CARD_IN_USE`; no card was removed. This does not yet verify a paid renewal or the mobile subscription UI.
- **Android balance display PASS:** after the user signed in on the reopened emulator, the actual Wallet screen displayed PKR 2,000.00 and USD 0.00 separately, matching the API.

### Android input/startup interruption — not yet resolved end to end

The wallet amount field did not accept automated or user laptop-keyboard input, and no on-screen keyboard appeared. No payment was submitted from that field. The emulator later stopped. No host emulator crash report was found; the exact reason it stopped is unconfirmed. The app amount field is a normal editable `TextInput`, without an explicit disabled or hidden-keyboard prop.

The AVD had `hw.keyboard=no`. It was changed locally to `yes` to enable hardware-keyboard support; this is an emulator configuration change, not an app/backend change. A restart and input verification are still required. Android Studio's restart also encountered a stale startup socket/owner lock referencing nonexistent PID 21204. The obsolete `.pid` file was preserved as `.pid.stale-20260926-165708`; moving the stale `.port` socket failed, and automated removal was blocked. No emulator data, APK or saved accounts were wiped. Native checkout testing remains pending until the emulator can be reopened and input works.

Subscription email/WhatsApp delivery, additional payment currencies, late-payment/refund flows and actual embedded completion still need live verification. API/test passes above must not be presented as proof that these remaining UI flows passed.

## Recovery and notification fixes — 27 September

- Android Studio startup was recovered by stopping only the verified hung Studio startup processes and using a fresh IDE cache directory. Its setup wizard detected the existing SDK and reported "Nothing to do! Android SDK is up to date." No SDK download, emulator wipe or app reinstall was needed. Previous Studio settings were backed up by Studio under `AndroidStudio2026.1.3-backup/2026-09-26-17-14`.
- The preserved RozareQA emulator reopened with APK 1.0.12 (14) and the buyer still signed in. Hardware-keyboard support was enabled. The floating Android keyboard menu's "Show on-screen keyboard" option restored the normal numeric keypad; the actual wallet field retained the entered `1`.
- **Native payment check found an issue, not PASS:** opening a USD 1 top-up showed the in-app secure-payment sheet, then "Payment screen interrupted" before card entry. Closing it safely checked backend status, retained the unpaid attempt, and left USD balance zero and PKR balance 2,000. No native payment was submitted.
- Mobile recovery handling now blocks unsupported links without tearing down a still-valid card form. Native loading failures retain an error category/numeric code without logging or displaying provider auth URLs. **19 targeted mobile tests passed.** Live retry remains necessary.
- Live subscription verification found a genuine missing-notification bug: Safepay billing/subdomain/refund notices shared event names with Stripe, but the delivery authority validator accepted only Stripe aggregates. Dedicated Safepay validation now checks the original owner, exact immutable amount, source record, timestamp, environment/binding and current lifecycle state. Existing Stripe validation is preserved.
- Seller lifecycle notifications now retain the exact transition/version and are suppressed after a conflicting change such as cancel then resume. Safepay messages use recognized WhatsApp sender categories, not preference-key names; the proven early immutable subscription envelopes are mapped safely during delivery. Buyer refund messages now contain the authoritative related order required by WhatsApp delivery.
- A bounded startup recovery requeues only verified receipts that the old provider-specific validator rejected; delivered and unrelated skipped notifications stay untouched. **77 targeted backend tests passed** covering real settlement/outbox records, delivery, stale-state suppression, altered recipient/money rejection and single requeue. Broader backend rerun is in progress. Deployment and notification delivery will be verified separately.

### Deployment and delivery evidence

- `c9cb7073` and the rolling-deployment recovery follow-up `cb7265a4` are pushed to both repositories; the live health endpoint reports `cb7265a419fc70ebe9511fa102992e05f9a92844` and a connected database.
- Complete regression runs: **232 backend suites / 3,445 tests passed**, **101 mobile suites / 1,160 tests passed**, no failures. The periodic-recovery follow-up also passed all four notification-worker tests separately.
- Android OTA update group `0de473d7-ebe9-4028-a9f0-f9672d2f5a26` was published for runtime **1.0.12**, Android update `01a0e02c-c934-7ba8-8c49-63b9590ed6d5`. The emulator downloaded it and the app was reopened to activate it.
- **Embedded form load PASS on retry:** the retained USD 1.00 attempt `6ab85be8f1585bb38340cf17` / `track_adca4437-70b5-4186-af3d-198d900e46e8` displayed the Safepay form within Rozare. The form accepted the test buyer email, +1 test phone, and sandbox card details. No external browser was used for this native form. Completion remains pending at this checkpoint. The first failure had no safe diagnostic code, so the exact original failure cause is not claimed as proven.
- The rollout briefly overlapped old/new workers: after the new validator requeued four rows, an old worker rejected two again. Recovery now checks the narrowly scoped old rejection every 60 seconds, still revalidating each receipt and never requeueing delivered rows. After recovery, the original Starter receipt is **delivered in-app, email and WhatsApp**. The seller's public test mailbox actually shows "Subscription trial started", and the admin test WhatsApp inbox contains the same USD 0.00 trial message.
- **Seller push NOT TESTED:** the receipt's push row was correctly skipped with `PUSH_DESTINATION_UNAVAILABLE` because that fresh seller has not signed into an app installation. This is not proof of device delivery.

### Current payment-completion blocker

- The user approved submitting the USD 1.00 native sandbox payment. The app's card form accepted Safepay's Visa test card, December 2030 expiry and test billing information. The optional provider save-card checkbox was left unchecked; no Safepay signup or password was required for this payment. Checking that optional box on an anonymous checkout can display a Safepay password field; Rozare's separate merchant-owned saved-card flow does not require it.
- A separate live-backend **PKR 1,200.00** product checkout was also prepared and submitted on Safepay's browser form, not counted as a fully native product-order test. Order `ORD-1790468423717` / `6ab861479a51aa1b72cddb46`, payment `6ab861489a51aa1b72cddb55`: PKR 1,000.00 product plus PKR 200.00 shipping, zero tax/discount/FX adjustment. The saved seller-native summary is exactly PKR 1,200.00. Stock remained 12 while unpaid, as required by the deferred-inventory policy.
- **Completion BLOCKED / NOT PASS:** both native USD and browser PKR forms remained processing after submission. Safepay's authentication-setup API returned HTTP 200, with next action `PAYER_AUTH_ENROLLMENT`. Its external Cardinal device-collection request to `cas.client.cardinaltrusted.com/centinelapi/V1/Cruise/Collect` did not report completion in the browser network trace. The generated authentication token was still within its validity period. A read-only HTTPS connectivity check reached that host, but that does not prove the actual POST/authentication flow works.
- Independent Rozare status checks continued to report `TRACKER_STARTED`, pending/unpaid for both exact payment IDs. There was **no USD wallet credit, no stock reduction, and no fake paid state**. No duplicate payment was created to work around the pause. No 3DS step was bypassed or mocked. The provider/network cause is not conclusively identified, so native success/3DS completion, paid product fulfillment and late-paid refund coverage remain unverified live.
- An updated sandbox APK **1.0.13 (15)** is being prepared with the checked-in fixes. Build configuration and 18 release-configuration tests passed. This is a test build, not a claim of payment-completion readiness.

### Additional final checks

- **Cross-account isolation PASS:** the fresh seller requested the buyer's USD payment-status URL while authenticated as the seller; the backend returned HTTP 404, without payment details.
- **Live subscription cancel/resume PASS (API, not mobile UI):** cancellation set automatic renewal false, resumption restored it, and both retained Starter/free-period status and the exact original funded period end. No payment was collected or trial extended by those actions.
- **Unpaid-state conservation PASS:** the buyer still has USD 0.00 and PKR 2,000.00, with one completed wallet transaction. The new unpaid product order has no stock reduction. This does not substitute for a completed native charge/fulfillment test.
- The laptop exhibited an intermittent DNS failure for Railway's control-plane domain during diagnostics. The Cardinal host was reachable by an independent browser GET, so the reason its actual authentication POST did not finish cannot be attributed confidently to DNS alone. The emulator clock was also observed about three hours ahead of host UTC; browser UTC matched the host and its checkout still stalled. Neither observation establishes a complete root cause.
- Restarting the virtual phone corrected its clock to within two seconds of host UTC without clearing app data. This fixes that testing-environment issue; it does not establish payment completion.
- New APK build `e71545ef-5137-4ccc-886c-c59ff0c140bc` is running from commit `f8c217dc`, version **1.0.13**, version code **15**, runtime **1.0.13**. [Build status](https://expo.dev/accounts/rozare/projects/rozare/builds/e71545ef-5137-4ccc-886c-c59ff0c140bc). The preceding APK 14 remains preserved.
- The new build subsequently **finished** and was downloaded as `test-assets/rozare-safepay-1.0.13-15.apk` (112,795,243 bytes). SHA-256: `d7c37e384e7616e60bc2bef4744db5404d546fbd6f80f8834b60b18a89a694ed`.

### Successful product-payment retry (supersedes the PKR blocker above)

- Reopened **the same** PKR payment through the authenticated reopen endpoint, which issued a fresh checkout link without a second payment record. Submitted the provider's browser form again. Safepay then showed "Paid successfully"; the backend independently returned `paid`, `TRACKER_ENDED`, PKR 120,000 minor units. This establishes success on retry, not the exact cause of the first provider pause.
- Buyer and seller authenticated order-detail APIs both showed **PKR 1,000.00 subtotal + PKR 200.00 shipping = PKR 1,200.00**, with zero tax, discount and reconciliation adjustment. The seller's persisted native summary matched exactly. Product stock went **12 → 11** and `totalSales` became **1**.
- The test seller progressed this test order through processing, shipped and delivered using the normal seller-authorized API. No real shipment was made. After delivery, the seller payment summary showed **PKR 1,200.00 Safepay delivered revenue and PKR 1,200.00 available balance** in the PKR bucket. Its USD bucket remained zero. PKR analytics showed one paid/delivered order, one unit sold, revenue and average order value PKR 1,200.00.
- The paid-order notification outbox recorded delivered **buyer in-app, push-provider acceptance, email and test WhatsApp**, plus **seller in-app, email and test WhatsApp**. Seller push remained skipped for no registered installation. Push-provider acceptance is not a claim of physical-device receipt.
- The original USD 1 native top-up remains a separate pending attempt and is being retried on the corrected emulator clock. No successful native charge is claimed yet.

### Full card refund and real notification display

- Submitted **one full sandbox refund** of the paid PKR 1,200.00 order through the existing verified Safepay client. The provider returned `TRACKER_REFUNDED`; the normal backend reconciliation independently reported `refundedMinor: 120000`, currency PKR.
- Seller accounting preserved the historical PKR 1,200.00 delivered sale and recorded exactly **PKR 1,200.00 payment-reversal debit**. Available/withdrawable PKR balance became **zero**, with zero deficit and no unresolved payment-risk hold. The original order money was not rewritten into another currency.
- Both the buyer and seller test WhatsApp inboxes received their own PKR 1,200.00 refund message. The actual Android emulator displayed a **"Card refund completed" push banner** from Rozare, with the PKR 1,200.00 amount. This confirms emulator receipt, not physical-device delivery.

### Native USD success and discovered clock-correction edge case

- **Native form → payment → wallet display PASS on retry:** Safepay completed a USD 1.00 payment within Rozare; the sheet closed automatically and Wallet showed **"Balance added" / USD 1.00**, with PKR 2,000.00 unchanged. The completed transaction is `6ab86a7d92df1ae933c1df35`, payment `6ab867c892df1ae933c1cd45`, tracker `track_9051e6a5-d77d-4391-8a39-1dd6af511866`.
- **Important correction to the expected replay:** database inspection showed that this was a second local attempt, not the original pending USD attempt. Only one USD transaction was charged/credited; original `6ab85be8f1585bb38340cf17` remains unpaid. The emulator clock had moved backwards by three hours; the shared retry helper rejected an existing key with a future `createdAt` and generated the next key. This is a real edge-case bug, not a successful idempotent replay.
- Corrected the retry helper to retain a structurally valid unresolved key after a backwards clock correction, while keeping terminal markers and the existing age window. Added tests for the exact three-hour rollback, legacy-key migration, and rotation only after an explicit terminal marker. **62 targeted tests passed.** A replacement build 16 will include the correction; no retroactive claim is made that the original live retry used it.
- The complete mobile rerun after that fix passed **101 suites / 1,162 tests**. Commit `0a1168b1` is pushed to both repositories; the live backend health reports that revision. Build **1.0.13 (16)** is queued/running as `9e3254c0-e1e9-4091-ada2-068f69c9a142`. Android OTA group `2f12d40a-4ba5-4940-9f51-cf1a2fbe265c` was published for runtime 1.0.13 with the same fix.
- APK 15's package/version and v2 signing verification passed, and it installed successfully over the existing app with data preserved. Build 16 remains the intended final sandbox artifact because it bundles the clock correction directly.

### Seller subdomain purchase

- **PASS (live API + Safepay browser):** payment `6ab86c8ac44c5358f05e659f` charged exactly **USD 15.00** in sandbox. Safepay returned `TRACKER_ENDED`, and the authenticated ownership endpoint showed the existing `safepay-qa-store.rozare.com` owned for exactly three calendar years, from `2026-09-27T01:12:00.532Z` to `2029-09-27T01:12:00.532Z`.
- The database contains one confirmed Safepay ownership grant (`6ab86d60c44c5358f05e6b33`), currency USD, captured minor amount 1500. This purchase is independent of the store's PKR product currency and does not create product-sale revenue.
- Seller-side native UI and push verification still requires signing the fresh seller account into Android; the buyer account has been used for all buyer payment checks. No admin account was used as a purchaser.
- Its in-app, email and WhatsApp ownership receipts were recorded delivered; seller push was skipped because that account has no registered app installation.

### Live negative-path checks

- Negative Wallet top-up: HTTP 400 `WALLET_TOP_UP_AMOUNT_INVALID`.
- Unsupported CAD Wallet top-up: HTTP 400 `WALLET_CURRENCY_NOT_SUPPORTED` (supported currencies remain USD/PKR/EUR/GBP).
- Buyer attempting seller-subscription enrollment: HTTP 403 `SELLER_REQUIRED`.
- Buyer attempting to delete the seller's saved card: HTTP 404 `CARD_NOT_FOUND`; the seller's card remained intact.
- Re-reading the completed refund left one refund record, PKR 120,000 minor units, one seller allocation and one corresponding PKR 1,200.00 reversal debit. Both recipient notification sets delivered except the seller's unregistered push channel.

### User-reported Payment Methods crash

- Android logs confirmed `ReferenceError: Property 'config' doesn't exist` at `PaymentMethodsScreen`. Its status indicator still referenced removed Stripe configuration state; this happened during rendering, before saved-card loading could finish.
- Replaced that indicator with the actual card-loading/error state. Added real screen-render tests for buyer/seller roles, empty cards, masked saved-card details/default selection, and load-error/retry behavior. **Four new screen tests passed.** A scope-based JavaScript identifier check across 26 migration-modified mobile source files found no remaining unbound identifiers.
- Requested cancellation of in-progress build 16 because it did not contain this late-reported fix; replacement build 17 and an Android runtime-1.0.13 update will include it. Native re-verification is required before marking this screen fixed live. No saved card or account data was deleted.

### Payment Methods correction verified on Android — 27 September

- Commit `7530c0b4` is pushed to both repositories, and the backend health response reports that exact revision with MongoDB connected. No change to website checkout was made for this fix.
- The complete mobile regression run passed **102 suites / 1,166 tests**, zero failures (`test-assets/safepay-final-mobile-cardsfix-20260927.json`).
- Android update group `856eb976-6f76-40c4-ab83-cbe62b37cda5`, update `01a0e078-f370-7e94-a3b9-6e1eedd086b6`, was published to production channel for runtime **1.0.13**. The installed build 15 downloaded it; the app was reopened to activate it without clearing data.
- **Native opening PASS:** using the fresh buyer account, opened Profile → Payment Methods. The actual screen displayed “Your cards, protected by Safepay”, “0 cards ready” and “No card saved yet”. It no longer displayed the `config` ReferenceError or an error boundary.
- **Native refresh PASS:** tapped the header refresh button, observed the loading skeleton, then the correct empty-card state returned. Adding a new card remained disabled until explicit save-card consent; no card was added, deleted or charged during this retest.
- Build **1.0.13 (17)** is running from the committed correction, so the replacement APK will contain the fix even before an over-the-air update is downloaded. Seller native saved-card display still requires seller sign-in; the seller-role screen rendering and masked-card/default behavior are covered by the new regression tests, not presented as native seller verification.

### Seller Android verification after sign-in

- The user signed in to the fresh seller test account. **Native saved-card display PASS:** Profile → Payment Methods showed one Visa ending **1111**, expiry **12/30**, matching the live owned-card API. There was no opening/render error. The card had no default preference yet, so “Make default” was correctly offered. No card or billing preference was changed during this display check.
- **Account-switch push isolation PASS:** scoped read-only database checks showed the signed-out buyer with zero registered push tokens and the signed-in seller with one. This establishes registration ownership, not delivery by itself.
- **Seller Dashboard display PASS:** the native screen showed Safepay QA Store, historical revenue **PKR 1,200.00**, one order, one product, one delivered order and zero pending/processing orders, matching the saved test sale.
- **Native Payments & Revenue PASS:** available to withdraw **PKR 0.00**, historical Safepay delivered revenue **PKR 1,200.00**, and a separate **PKR 1,200.00 Payment reversals** deduction. All other revenue/deduction buckets were zero. The PKR balance stayed PKR, the minimum withdrawal displayed **PKR 2,000.00**, and withdrawal was disabled with no available amount/bank account. No withdrawal or payout was submitted.
- **Native Starter display PASS:** the Subscription screen showed “Rozare Starter”, “Introductory Period”, “Safepay secured”, and the correct **26 October 2026** period end.
- **Seller subscription push PASS on emulator:** used the normal seller-authorized API to cancel sandbox automatic renewal, retaining Starter access and the exact existing period end. The Android notification tray later showed “Subscription renewal cancelled” and the correct **USD 9.99/month** amount. Tapping it opened the Subscription screen. Device arrival was delayed by roughly two to three minutes after provider acceptance; it was not immediate. The corresponding in-app, email and test WhatsApp records also delivered. This verifies an API-triggered lifecycle event reaching native UI, not the native cancel button.
- Restored automatic renewal through the normal seller API. The response independently showed `automaticRenewal: true`, `status: free_period`, and unchanged end `2026-10-26T06:58:14.833Z`. No charge, new plan or trial extension was created by this cancel/resume check.
- Resume notices also reached the in-app/email/test WhatsApp delivery states and push-provider acceptance. A scoped database check found **zero new seller payment records** during this cycle. Only the cancellation notification was visually confirmed in Android; do not count provider acceptance alone as a second observed device receipt.
- **Installed APK 17 smoke PASS:** Android package inspection confirmed version code **17** / version **1.0.13** after successful `install -r`. The app opened, the same seller remained signed in, and Payment Methods again showed the existing Visa ending 1111 without an exception. No account/app data was wiped.
- **Native subdomain ownership PASS:** APK 17's Store Subdomain screen showed `safepay-qa-store.rozare.com`, LIVE, OWNED, **1,096 days** remaining, purchase **27 September 2026**, and expiry **27 September 2029**. These match the live ownership API and single three-year Safepay grant. This verifies ownership rendering, not a native purchase-button checkout. The separate revenue-currency display issue on this screen is listed under remaining checks above.

### Fresh-account billing-contact rejection and retry-lock correction

- The user reported “Safepay could not complete this request” followed by “Your payment profile is being prepared” while adding a first card on a different test seller account.
- **Root cause reproduced against Safepay sandbox:** HTTP **400**, validation **`last_name: cannot be blank.`** The saved billing name contained one word. The old code accepted that name, sent an empty `last_name`, discarded the field-specific rejection, and retained its 90-second customer-creation lease after the definite failure. No card-setup payment existed for that failed account.
- The backend now requires billing first and last names before acquiring a lease or sending a customer request. Explicitly cleared fields cannot silently fall back to old profile data. The separate payment-profile contact does not rewrite the account, store name or saved shipping details.
- The first-card response supplies the signed-in account's own billing-contact draft. Mobile presents the fields before setup, prefills the existing phone/country, explains the first/last-name requirement, validates incomplete names locally, and preserves edits when refreshed. The form uses the existing keyboard-aware scroller.
- Provider validation is mapped to whitelisted field names and fixed safe messages; raw upstream errors/contact details/secrets are not persisted or returned. Definite 4xx rejections release only the originating lease immediately. Timeouts, 5xx and uncertain/mismatched responses retain the bounded protective lease and return a retry duration; the app shows a countdown and retains the same setup attempt.
- Added concurrency and safety regressions: simultaneous requests create once; stale failures cannot unlock another worker; delayed success cannot reopen a closed profile; missing consent cannot start provider work; existing profiles do not require contact entry again.
- Targeted checks: **50 backend tests** and **74 mobile tests passed**. Complete reruns: **234 backend suites / 3,472 tests** and **102 mobile suites / 1,173 tests passed**, zero failures. Android export also passed, 2,304 modules. Deployment/native results follow below.
- Commit `26eda71d` was pushed to both repositories. Live backend health reports `26eda71d7439a91edcefcf2f2d75e6d79356c957` and MongoDB connected.
- Published Android update group `2a70b5ae-284f-4dc2-bab9-873ccf229f19`, Android update `01a0e0c0-9bc1-7c9e-a47e-6a87706e794a`, production channel / runtime **1.0.13**. No native dependency, APK version, real-payment mode or website checkout change was required.
- **Backward-compatible live validation PASS:** before activating the new Android bundle, pressed Add a new card on the existing error screen. The updated backend returned the clear first/last-name message and the existing APK displayed billing correction fields. Read-only database verification still showed **zero card-setup payments** and no provider customer for that invalid-name attempt; the previous expired lease was not renewed.
- **Updated native form PASS:** activated the compatible update on installed APK 17 with the same seller still signed in. Payment Methods displayed editable billing name, phone and country fields before a setup request. The existing phone and Pakistan were prefilled; the one-word saved billing name remained available for correction rather than being silently replaced.
- The user authorized any test name. Entered **Rozare Test Seller** into the billing-name input only, selected the requested save-card consent, and pressed Add a new card through the Android UI.
- **Corrected live setup PASS:** the same previously failing account opened the embedded **Safepay sandbox card-entry form**, showing card number, expiry, CVC and billing-address inputs without a separate Safepay signup. The backend independently showed its customer profile **ready**, lease cleared, and no retained setup error. Exactly one zero-amount **PKR instrument/card-setup** record exists, `6ab884c70c2cdd21e7270de1`, status `ready`.
- This verifies customer creation and reaching card entry, **not completed card storage**. No card number was entered, no card was saved, and no payment or subscription charge was submitted. The existing account name and saved shipping name were independently checked and remained unchanged. The card form was left open for the user's own next test.

### Empty Android subscription-review dialog

- The user saved a card, returned to Subscription and tapped the Starter enrollment button. The overlay appeared as an empty narrow horizontal bar. The same failure was reproduced in the emulator.
- The modal panel had only `maxHeight`, while its keyboard-aware scroll child used `flex: 1`; Android laid out the panel at its padding height and clipped the review content. This was a display/layout issue, not evidence of a declined card.
- Replaced the modal's presentation with a dedicated review component that gives the panel a definite, safe-area-bounded height and tablet width cap. Its regular scroll body has a bounded parent. The header close button and bottom actions stay outside the scrolling content. Android's separate modal window no longer depends on the main screen's blur target.
- Plan prices, due-now amount, free days, credits, card selection, consent and the existing acceptance/reconciliation handlers are preserved. No backend/payment logic or native dependency was changed.
- Added actual component and screen interaction tests for the reported no-card → add-card → review sequence, card/consent gating, dismissal without subscribing, pending-action locks, billing-card change, and compact/landscape height changes. **29 targeted tests passed; the complete mobile run passed 104 suites / 1,189 tests.** Publication and updated native verification are pending at this checkpoint.
