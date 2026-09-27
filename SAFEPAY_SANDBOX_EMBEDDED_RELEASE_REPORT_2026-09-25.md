# Safepay sandbox mobile migration — release verification

## Current status

Implementation and live verification are still in progress. Do not interpret a successful APK build or unit-test run as proof that every live flow is complete.

The website checkout remains Stripe. All new mobile card purchases are routed to Safepay sandbox; real Safepay production payments are not enabled.

## Confirmed build

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

## Verification checkpoints

| Check | Observed result |
| --- | --- |
| Full mobile tests | **101 suites, 1,159 tests passed** |
| Full backend tests after embedded/deferred-stock work | **232 suites, 3,439 tests passed** |
| Later account-deletion/recurring ownership guards | **37 targeted tests passed**; final broader rerun still needed after subsequent edits |
| Android Hermes export | **Passed**, 2,304 modules |
| Native build configuration | **Passed** |
| EAS signed APK build | **Passed** |
| Emulator install and initial home screen | **Passed** |
| Actual embedded sandbox payment, subscription and seller flows | **Pending** |

Test examples already passing locally: valid late payment reserves stock once; sold-out late payment schedules one refund; changed native price leaves the frozen order untouched and takes the refund path; explicitly cancelled order stays cancelled; refund timeout does not issue another refund; partial/final return shipping is refunded once; multi-currency order refunds conserve original seller-native money.

The earlier account-free capability probe completed two sandbox recurring payments from the same explicitly saved test card, one PKR and one USD. Both were refunded, and the probe card was removed. That establishes provider capability, not a completed in-app end-to-end subscription test.

## Remaining release checks and limitations

- Current backend is deployed with sandbox credentials. Complete actual mobile payment flows before declaring readiness.
- Complete provider-refund, reversal, dispute and recovery coverage. Some Wallet/return-funding/provider-risk cases deliberately hold money for review; they are not silently cleared or represented as automatically reconciled.
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
