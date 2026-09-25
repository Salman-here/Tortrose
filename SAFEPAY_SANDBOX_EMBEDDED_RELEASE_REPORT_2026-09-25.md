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

- Deploy the current backend with sandbox credentials, then verify actual mobile flows before declaring readiness.
- Complete provider-refund, reversal, dispute and recovery coverage. Some Wallet/return-funding/provider-risk cases deliberately hold money for review; they are not silently cleared or represented as automatically reconciled.
- Unpaid subdomain/return settlement locks remain resumable but require further abandonment/expiry coverage.
- Compatible dependency patches removed the high-severity npm findings. Four moderate audit entries remain in the existing navigation dependency chain (`decode-uri-component`); npm proposes a breaking navigation upgrade. No unrelated major upgrade was applied.
- No real card charge, real bank payout, Play Store publication or physical-device push delivery is claimed.
