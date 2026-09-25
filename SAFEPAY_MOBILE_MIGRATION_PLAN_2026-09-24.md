# Safepay mobile migration — inspected scope and release gates

Status: implementation in progress, not ready for release. Account-free recurring charges were proved in Safepay sandbox on 25 September. Local changes now cover mobile checkout, Wallet funding, saved cards, recurring billing, subdomain ownership, seller-funded returns and verified order-refund accounting. The deployed version is still the callback foundation (`f88cb5c2`), and Railway was rechecked: `SAFEPAY_ENV=sandbox`, `SAFEPAY_MOBILE_ENABLED=false`, `SAFEPAY_SANDBOX_WEBHOOK_SCHEME=sha512-raw`. A newly reproduced provider cancellation/expiry issue is a release gate; see the last section. Broader reversal handling and actual mobile end-to-end release verification remain unfinished. No APK or mobile update has been published for this migration.

## Requested boundary

- Backend plus Android/mobile subscriptions and purchases should use Safepay **sandbox** first.
- Website checkout continues using Stripe until the later website migration.
- Preserve existing money calculations, seller-native balances, trials, plan prices/promotions, stock, coupons, refunds and notification behavior.
- Deliver a new downloadable Android build only after the integration is configured and verified.

## Account inspection

The opened `https://getsafepay.com/dashboard/home` sidebar tab is signed in to the **Rozare production merchant dashboard**. The page explicitly states that it cannot accept live payments until onboarding is completed. Developer settings expose the merchant's public/secret-key controls; no keys were changed or copied into application configuration.

The documented sandbox dashboard is separate: `https://sandbox.api.getsafepay.com/dashboard/login`. The user signed into it after the initial inspection, and the Rozare dashboard visibly shows **TEST MODE**. Existing sandbox server credentials were read privately and placed only in a Git-ignored local server environment file. No key values are recorded here or included in mobile code. The user explicitly approved enabling sandbox webhooks and registering the backend endpoint.

## Current payment paths identified

| Flow | Mobile entry | Backend entry / contracts |
| --- | --- | --- |
| Buyer product checkout | `CheckoutScreen.js`, Stripe PaymentSheet, idempotent checkout helpers | `orderController.js`; exact server-repriced order totals, frozen FX/seller money, stock/coupon reservation and signed settlement |
| Wallet top-up | `WalletScreen.js`, Stripe PaymentSheet | `walletController.js`, `walletService.js`; immutable top-up identity, funding provenance, exact native balances and liability settlement |
| Saved cards | `PaymentMethodsScreen.js`, `StripeContext.js` | `/api/payment-methods`; customer ownership, explicit consent and cancellation cleanup |
| Seller plan checkout | `SellerSubscriptionScreen.js`, hosted checkout | `subscriptionController.js`; Starter/Elite prices, introductory periods, FIRST100 reservations and entitlement ledger |
| Upgrade / Meta add-on | Seller subscription screen, Stripe next action | Proration, pending payments, frozen plan-change identity and authoritative paid activation |
| Downgrade / cancellation / resumption | Seller subscription screen | Scheduled period-end downgrade/cancellation, undo, bonus/free-period and founder-rate rules |
| Subdomain purchase / renewal | `SellerSubdomainManagementScreen.js`, hosted checkout | `subdomainPurchaseController.js`; exact slug ownership, frozen price/term and refund/dispute attribution |
| Return and cancellation settlement | Order/return screens | `orderCancellationService.js`, return services, wallet/seller risk services and durable notifications |
| Return links and result screens | `PaymentSuccessScreen.js`, app links and subscription return screen | Payment status is verified on the backend; returning from checkout must never grant money/access by itself |

Stripe is present in persisted schemas and lifecycle logic, not just the button label. `Order.paymentMethod`, `WalletTransaction.referenceType`, saved-card ownership, entitlement ledgers, risk/refund handling and mobile result handling must all recognize the new provider. Historic Stripe records must remain attributable to Stripe and must never be retried against Safepay.

## Safepay evidence gathered

Primary vendor resources:

- [Hosted checkout integration](https://safepay-docs.netlify.app/build-your-integration/express-checkout/): server-created tracker and authentication token, then hosted checkout; signed payment events determine completion.
- [Money](https://safepay-docs.netlify.app/concepts/money/): payment amounts use minor units; PKR, USD, GBP and EUR are included in the documented payment currencies. Merchant-specific availability still needs sandbox verification.
- [Subscription integration](https://safepay-docs.netlify.app/build-your-integration/subscriptions/): customer-authorized hosted subscription checkout and asynchronous recurring-payment events.
- [Webhook types](https://safepay-docs.netlify.app/developers/webhooks/webhook-types/): payment, refund, authorization, void and subscription lifecycle events.
- [HMAC guidance](https://safepay-docs.netlify.app/developers/webhooks/verify-hmac-signatures/).
- [Official Node SDK](https://github.com/getsafepay/safepay-node): subscription reference is included in the checkout URL; subscription objects support trial and period-end fields.
- [Official PHP subscription implementation](https://github.com/getsafepay/sfpy-php/blob/main/lib/Service/SubscriptionService.php): retrieval, update, cancellation and resumption endpoints; immediate cancellation is terminal, so it must not be confused with Rozare's period-end cancellation.
- [Token management](https://safepay-docs.netlify.app/concepts/tokenization/manage-tokens/): Safepay customer payment methods have their own provider-owned identities. Existing Stripe card tokens are not Safepay tokens.

The official `@sfpy/node-core@0.3.5` and `@sfpy/node-sdk@3.0.2` tarballs were downloaded and inspected in `test-assets/safepay-sdk-research/`. They were **not installed as application dependencies**.

## Items that need verification before implementation is enabled

1. **Sandbox access and keys:** sandbox merchant public key, server secret and webhook HMAC secret, kept server-side and separate from future production values. Do not use the opened production credentials for sandbox.
2. **Webhook signing discrepancy:** the subscription guide demonstrates SHA-256 over raw body; the HMAC guide/PHP SDK demonstrate SHA-512; Node SDK 3.0.2 signs serialized `request.body.data`. Confirm the exact sandbox payload/header contract. Do not broadly accept guessed variants or trust an unsigned event envelope for settlement.
3. **Recurring billing parity:** validate trial periods, customer correlation reference, cancellation-at-period-end, upgrades/proration, downgrades and undo/resumption using actual sandbox responses. Do not silently replace an automatic renewal with manual one-time payments or change existing plan benefits.
4. **Create/retry recovery:** verify how Safepay correlates/retrieves an uncertain tracker or subscription creation. An HTTP timeout is not evidence that the provider created nothing.
5. **Authoritative money:** compare exact amount, currency, environment, merchant and immutable internal reference before paid status, Wallet credit, stock consumption, seller earnings or subscription/subdomain entitlement.
6. **Provider separation:** new mobile attempts select Safepay; website/new Stripe and historical Stripe callbacks remain supported. Cross-channel mutations must route by the saved record's provider, not merely a request header.
7. **Sandbox isolation and later cutover:** test credentials/transactions must not be mistaken for production funding. Switching environments must be an explicit configuration and verification step.

## Verification matrix for the implementation phase

- Single- and multi-seller orders; PKR/USD/GBP/EUR; options, coupons, shipping/tax; zero-value orders and COD unchanged.
- Successful, declined, interrupted, expired and repeated checkout; delayed/duplicate/out-of-order webhook events; forged signature/amount/currency/reference rejected.
- Wallet top-up exactly once, repeat status polling, cancellation/late-payment races, refunds and funding provenance.
- Subscription enrollment/trial/renewal failure/recovery; upgrades/add-ons; downgrade/cancel at period end; resumption; FIRST100 eligibility and lost-rate rules.
- Subdomain initial purchase/renewal, retries and provider-specific refunds.
- Mobile browser return, Android back/app restart, safe external URL validation, notifications and updated provider wording.
- Existing Stripe website regression tests before deployment.
- Real sandbox end-to-end verification before building an APK; record build ID, runtime/version and download URL only after build success.

## Runtime findings

- Sandbox plan/subscription searches and short-lived checkout authorization succeed with the existing credentials.
- The Payments 2.0 API rejects arbitrary metadata keys (observed HTTP 500, `unsupported meta key rozare_reference`). The adapter now uses the supported `order_id` and `source` fields and will keep purpose/owner/money in Rozare's own immutable payment record.
- Hosted checkout defaults to `entry_mode: flex` in this account. The adapter does not force the older raw-card-entry setting from some examples.
- Exact PKR minor-unit creation/retrieval succeeded for unpaid tracker `track_6f019a51-e952-4143-87f8-c7bb4473adc3`: PKR 100.00 / 10,000 minor units. Earlier minimal-contract probe: `track_9a5f2dcd-4a62-4ed6-ad37-0e228fa288cf`. Neither probe was charged, linked to a Rozare order, or used to grant balances/entitlements.
- Webhooks were enabled in the **sandbox** after explicit user approval. `https://rozare.up.railway.app/api/safepay/webhook` was registered successfully. It currently has **NO EVENT** subscriptions, so it will not dispatch payment notifications before the receiver is ready.
- The Sandbox "View shared secret" dialog exposes an empty signing-key field. Both its copy action and revealed field returned no key, including after refreshing the dashboard and after registering the endpoint. The existing server API secret is valid (authenticated plan/subscription reads and short-lived authorization succeeded); it must not be guessed to be the separate webhook signing key.
- No key was rotated, no unsigned-event workaround was enabled, and no payment was captured. Existing Stripe website/mobile payment behavior remains active until the new migration is complete.

## Signing-key handoff (resolved 25 September)

The user placed the sandbox webhook secret in the Git-ignored local configuration and replied Done. Presence was verified without printing it. Its actual signing scheme still needs confirmation with a provider-generated event; production keys remain unused.

After the key is available, verify the exact signature contract using a genuine Safepay sandbox event, then finish order/Wallet/subscription/subdomain/return-settlement integration, accounting and client screens, regression testing, live sandbox tests, and the requested Android build. The unconnected scaffolding is not a completed migration.

No production-ready or build-complete claim is made while the remaining release gates are open.

## 25 September continuation — verified progress

- `f88cb5c2651197094142d062e7b06e4adcf3c36e` was pushed to both existing remotes. Railway and Vercel reported successful deployment. The website's Stripe checkout was not changed.
- The sandbox endpoint now subscribes to all 18 available v2 payment/authorization/void/subscription events. Legacy v1 event types were not selected.
- The test-webhook API requires a 40-character identifier (`evt_` plus UUID). Diagnostic event `evt_ef3076b4-6159-4cdb-b692-2e8f41c7b09c` returned success; the backend logged **only `sha512-raw` matched**, signature length 128, version 2.0.0 and the correct merchant. No secret or signature was logged, and the diagnostic event could not enter financial processing.
- The selected signature scheme was added to private local configuration and Railway's staged variables. The mobile enable flag stays false. No production credentials are used.
- Payment recovery now uses the documented `/reporter/api/v2/payments` query with indexed `states[n]`, `meta_keys[0]=order_id` and its exact reference. The provider limits pages to 30 records. Recovery of the existing unpaid probe was verified without creating another tracker.
- Local backend additions: immutable payment attempts; exact reference/merchant/currency/environment/amount checking; leased, transactional order and Wallet completion; duplicate-event protection; ownership-protected status/reopen routes; secure app return bridge; durable background event/recovery processing; separate Safepay seller-revenue buckets without changing native currency snapshots. Refund/dispute handling currently quarantines funds for review and still needs full reconciliation implementation before release.
- Local mobile additions in progress: system-browser Safepay checkout, strict provider URL validation, backend-verified return screen, buyer checkout and Wallet top-up wiring. Subscription/saved-card/seller-purchase flows and remaining Stripe cleanup are not complete.
- Tests observed passing so far: 33 callback/client/state tests; 7 transactional payment-service tests; 132 existing/new checkout and seller-accounting regression tests. These are automated tests, not proof of a completed real sandbox payment. Additional tests continue as implementation changes.

### Subscription capability and sign-in check

A sandbox-only test plan was created: `plan_f7f1884c-1393-4cb4-87cf-d3155f1a2f66`, USD 1.00, monthly, one trial day, one billing cycle. It is not linked to a Rozare seller and has not been paid or used to grant access.

The official `/checkout/subscribe` URL correctly redirects to `/checkout/auth/login` and preserves the correlation reference. The checkout explicitly requires a Safepay **shopper** login, separate from the authenticated merchant dashboard. A non-blocking sign-in handoff was requested; the subscription checkout tab remains open.

Important capability finding: a test `PUT` attempting to change that plan's amount and `apply_amount_change_on_existing_subscriptions` returned HTTP 200 but a subsequent GET still showed amount 100 and the flag false. Those changes were ignored. The documented plan-update schema does not include price changes. Existing subscription upgrades, downgrades and proration therefore must not be implemented by assuming this API updates prices. The supported subscription-change flow still requires verification.

### Genuine sandbox card and signed-payment callback (PASS, gateway layer only)

The existing PKR 100.00 probe `track_6f019a51-e952-4143-87f8-c7bb4473adc3` was completed through Safepay's browser form using the vendor's documented sandbox Visa card and fictional contact/billing details. Saving the card was left unchecked. The page returned to Rozare.

An independent provider read confirmed `TRACKER_ENDED`, quote/charge/balance of 10,000 PKR minor units, and successful enrollment, authorization and capture. The test gateway reported fee 634 and net 9,366 minor units; the customer charge remained exactly PKR 100.00. No merchant-fee deduction was added to seller accounting as part of this migration.

Rozare's database contains the verified, durable sandbox callback `evt_d789ed1a-e981-4168-824c-3c2f56ccba6f` (`payment.succeeded`, received 2026-09-25 05:09:44 UTC). The handler verified its raw-body signature before storing it. It remains pending because business processing is intentionally disabled and this gateway-only probe has no Rozare order/payment-attempt record. It granted no seller revenue, Wallet credit or entitlement.

Railway deployment `badf24a1-8393-45f4-9105-1c055d549843` successfully applied the pinned `sha512-raw` configuration and disabled the diagnostic probe. Its application commit is still the callback foundation, not the unfinished local migration.

Additional automated verification passed: 7 real-database settlement tests (order, cancellation, four Wallet currencies, dispute hold), the expanded no-charge tests, and 133 existing payment/Wallet/coupon/funding-provenance regression tests. Mobile checkout URL/status tests and order-presentation tests passed. One pre-existing payment-result UI test exceeded its default 5-second limit during a combined run; it passed on an isolated rerun with a 20-second test limit, without changing that screen's verification behavior. The four admin money-validation tests passed, including Safepay/Stripe combined revenue.

The PKR 100.00 gateway probe was then refunded in full using Safepay's documented API. A subsequent provider read showed `TRACKER_REFUNDED` and zero remaining charge balance. Rozare received and verified refund event `evt_943e159d-0f30-4581-9d0c-0271fa873d70`, with `refund_amount=10000` and `currency=PKR`. This remains a gateway-only test and is not evidence that the unfinished Rozare return/refund integration is complete.

Further local runs: 81 mobile checkout/Wallet/seller-money tests and 11 web admin/native-balance tests passed. Android export initially reached 2,359 modules but the restricted host denied execution of the installed Hermes compiler. The approved retry successfully compiled all 2,359 modules into an Android Hermes bundle in `test-assets/safepay-android-export`. The full website build and both prerendering steps also passed. These are local compilation checks, not an APK build or a published update.

### Current handoff state

- Final targeted Safepay backend run: **48 tests passed across six suites**, including a regression proving that replay cannot replenish an already-spent Wallet funding lot.
- All newer application changes described above are local and uncommitted. The only live application commit for this migration is still `f88cb5c2`; its verified sandbox receiver is configured, and `SAFEPAY_MOBILE_ENABLED` remains **false**. The existing website and released mobile payment flows have not been switched.
- The small local website changes are read-only compatibility for identifying Safepay-funded orders/revenue from the app, not a website checkout migration.
- The subscription shopper sign-in handoff is open in the sidebar's **Safepay Checkout** tab. Its short-lived checkout link may need refreshing after sign-in; the browser session itself can be reused. Never request or print the user's password.
- Still required: verify Safepay's supported recurring-plan change/proration flow; implement subscription lifecycle and entitlement parity, saved-card management, subdomain purchases and return settlements; complete reversal/refund accounting; verify cancellation/expiry and recovery on actual hosted sessions; exercise real Rozare order/Wallet/seller flows on Android; then commit/deploy, enable the sandbox rollout, build an APK and provide its download link. Do not enable or publish the current partial migration as a completed release.

## Account-free recurring payments — verified 25 September

The user asked to avoid a separate Safepay account, continue if supported, and otherwise stop. The native hosted-plan flow requires a Safepay shopper login (also stated in Customer Terms section 8.2), but Safepay separately documents merchant-managed customers and tokenized recurring charges. These are different integration paths.

Primary sources checked:

- [Shopper types](https://safepay-docs.netlify.app/concepts/shoppers/): merchant-managed customers use their merchant account, not a separate Safepay login.
- [Tokenization and recurring payment types](https://safepay-docs.netlify.app/concepts/tokenization/introduction/): merchant-managed tokens support later subscription payments.
- [Official Authorization API example](https://apidocs.getsafepay.com/#6145b078-c3e7-4621-88de-373187bf6147): the **200 - subscription-mit with chaining** example uses `mode: subscription`, `entry_mode: mit`, `payload.payment_method.tokenized_card.token`, and explicit authorization/capture. This is the documented recurring mode, not an unscheduled-payment workaround.

Concrete sandbox evidence:

1. Created fictional customer `cus_8be70ee1-49fb-4afd-be6e-ff35355febd0` with `is_guest=false`, without a Safepay password/account.
2. Opened a zero-amount instrument checkout. It showed card/billing fields directly, with no Safepay login or signup.
3. First instrument `track_df20a105-f8fd-40f8-9dde-269a0c1dad4c` was completed without selecting permanent storage. Its token correctly had `max_usage=1`; this is insufficient for renewals.
4. Repeated with explicit **Securely save this card for faster payments** consent: `track_7f4743bd-51b5-420f-a908-51ecda00f97e`. Independently retrieved token now has `max_usage=-1`, card ending 1111, expiry 2030, and the expected merchant/customer binding. No separate Safepay account was created.
5. Created recurring tracker `track_81d633be-c0f3-43d5-9404-0152e50818b7` for PKR 100.00, `mode=subscription`, `entry_mode=mit`, using that customer.
6. An execution safety check initially rejected a charge command because it could not verify an interpolated token. That attempt did not execute. A read-only provider ownership/fingerprint check was performed; the retried command independently retrieved the token, checked its pinned fingerprint/merchant/customer, and checked the exact tracker/environment/currency/amount before making the charge.
7. Provider returned HTTP 200. An independent GET confirmed `TRACKER_ENDED`, successful authorization/capture, and exactly 10,000 PKR minor units charged.
8. Rozare durably received signed success event `evt_3dc794ad-cf37-44f0-9726-2c549d917039` at 2026-09-25 06:12:37 UTC. This is still a standalone gateway probe, not a Rozare subscription activation.

**Decision:** continue with merchant-managed recurring billing. Rozare will own plan terms, billing periods, trials, retries and cancellations; Safepay owns the authorized card tokens and processes each documented recurring charge. Native Safepay hosted-plan signup will not be used for the mobile subscription flow. Existing prices, promotions and timing rules must remain unchanged. The previous shopper-login handoff is no longer required. End-to-end implementation and release are still pending.

### Reuse, USD and cleanup verification

- The same reusable card also completed a second recurring-mode charge: `track_6847d55b-6f56-4601-99ee-f5d874deb21d`, USD 1.00. An independent read confirmed `TRACKER_ENDED`, `mode=subscription`, `entry_mode=mit`, and quote/charge/balance of 100 USD minor units. No password, Safepay shopper login, or new card entry was used for either recurring charge.
- Both recurring probes were fully refunded, each using its original charged currency. Safepay independently showed `TRACKER_REFUNDED` and zero balance for PKR 100.00 and USD 1.00. The refund API accepted USD directly even though the provider's separate base-settlement quote was PKR; application refunds must use the verified charge currency, not guess from the settlement base.

- The reusable sandbox probe card was then removed, and its customer wallet was independently verified empty. Its old token is no longer available for reuse. The transaction/refund audit history remains intact.
- Local implementation now includes merchant-owned customer/card setup, explicit reusable-card consent, account-free saved-card management, frozen subscription quotes and agreement, introductory periods, exact-cent proration, shared FIRST100 capacity, anchored monthly renewals, period-end cancellation/resumption/downgrade, and guards against duplicate provider billing. Initial billing lifecycle tests passed (nine database-backed scenarios); these additions still require broader review, negative-path coverage, live app tests and release verification.
- Existing promotion, checkout-claim and subscription-presentation regression tests passed alongside the new client/billing-math tests (85 tests in that run). The recurring route uses the documented subscription/MIT mode, never a disguised unscheduled charge.

## Further implementation and verification — 25 September

These changes are local and uncommitted, not deployed or published as an Android release. The working branch remains `main`. Earlier chronological sections describe earlier progress, not the current completeness claim.

### Account-free subscriptions and saved cards

- Added Rozare-owned billing quotes and explicit recurring consent. Safepay stores the reusable card; Rozare owns the agreed price, trial, UTC billing anchor and invoice identity.
- Kept the existing Starter/Elite prices, eligible 30/45-day introductory periods, FIRST100 shared capacity, Meta add-on, one-time Starter bonus and period-end cancellation/downgrade rules.
- No card entry or card-saving action alone activates a subscription. A zero-value instrument authorization is distinct from a paid order.
- Added deliberate retry of a definitively declined renewal, with a fresh owned-card selection and price confirmation. A timeout or unknown authorization outcome cannot create a second charge attempt.
- Added subscription-card replacement without charging or extending the period. Card deletion and billing use a shared transaction fence.
- Preserved cancellations that arrive during an already-started charge: the funded period can complete, but subsequent renewal remains cancelled.
- Added a provider ownership guard so a delayed old Stripe checkout cannot replace a Safepay subscription projection. Website subscriptions are not automatically migrated.

### Seller one-time payments and refund safety

- Mobile subdomain purchase/renewal now uses Safepay's hosted checkout. The unchanged price is USD 15 for three calendar years.
- Safepay ownership contributions have their own ledger. Shared website/cron ownership calculations combine Stripe and Safepay contributions, while old Stripe identifiers remain Stripe-only.
- A renewal extends existing paid ownership instead of overlapping it. A full verified reversal removes only the relevant contribution. Unknown/partial/disputed ownership events remain held for review.
- Seller card-funded return settlement now has a Safepay path. It reuses the existing immutable return amount, seller lock, final-return shipping allocator and idempotent buyer Wallet credit. It does not fabricate Stripe objects.
- Example tested: two PKR 2 partial returns with PKR 3 shipping refund PKR 2 and PKR 5 respectively. The buyer receives PKR 7 total; shipping is counted once.
- Added exact provider-evidence checks for order refunds: charge, capture, refund receipts and remaining balance must all reconcile in the original charged currency. A PKR settlement quote cannot substitute for a USD receipt.
- Example tested: a USD 10 order whose seller entitlement is PKR 2,800 receives USD 2.51 and USD 7.49 refunds. Cumulative seller reversal is exactly PKR 2,800, not a fresh live-FX conversion. Repeated reconciliation creates no extra debit or notification.
- Refund receipts have an immutable event record with exact buyer delta and seller shares. Notifications reference those snapshots.
- Wallet-funding reversals and seller return-funding reversals still take the fail-closed review/hold path. Full automatic reconciliation of those cases is not yet claimed complete.

### Mobile and compatibility

- Removed the active native Stripe provider, dependency and Android pinning plugin. The two obsolete local adapter/plugin files were removed; their previous versions remain recoverable from Git.
- Updated current mobile payment wording, return funding and subdomain screens to Safepay. Historical Stripe order labels/return handlers remain provider-correct.
- Website checkout remains Stripe. Its seller/admin money readers understand Safepay revenue so new app orders do not disappear from cross-surface reporting.
- Mobile information-parity tests now explicitly account for this intentional provider difference; unrelated policy and legal content remains aligned.

### Verification evidence

| Check | Result |
| --- | --- |
| Full mobile suite | 99 suites, 1,147 tests passed |
| Broad backend run | 231 of 232 suites passed; 3,431 of 3,432 tests passed on that checkpoint |
| Diagnosed broad-run failure | The COD-policy test called a real external FX provider and stopped on `EXCHANGE_RATES_UNAVAILABLE`, before reaching the policy assertion. Added a deterministic trusted FX fixture; the original COD rejection assertion now passes. No production FX safety check was weakened. |
| Final focused backend rerun after refund/return changes | 16 suites, 278 tests passed, including Safepay, existing Stripe reversal/entitlement paths, returns, subdomains and the corrected COD-policy test |
| Android Hermes export | Passed; 2,296 modules. The first attempt was blocked by the local sandbox's executable permission; the approved compiler retry succeeded. This is not an APK or a device end-to-end test. |
| Website production/SSR build | Passed |
| Credential scan | 101 changed/new non-asset files checked; no sandbox credential values found. Private environment file remains Git-ignored. |
| Live rollout configuration | Read-only Railway verification: sandbox; mobile rollout false; SHA-512/raw webhook scheme |

Machine-readable local test artifacts: `test-assets/safepay-mobile-current.json`, `test-assets/safepay-backend-current.json`, `test-assets/safepay-final-targeted.json`. These artifacts are not release bundles. The broad backend suite was not rerun in full after the final focused changes, so its earlier totals must not be represented as a fresh all-green full run.

## Release gate: Safepay hosted cancellation does not close the observed tracker

### Exact sandbox reproduction

1. Created an unpaid standalone probe for PKR 100, not tied to a Rozare order or balance: `track_61575efe-0b84-49b4-a3a4-de030b94ac9d`, reference `rozare-cancel-probe-1790302812300`.
2. Opened the provider-hosted checkout. It displayed the amount, email/card payment path and **Cancel payment**.
3. Clicked **Cancel payment**, then **Yes** in Safepay's own confirmation. Safepay returned to Rozare.
4. Independently read the tracker using the merchant API. It remained `TRACKER_STARTED`, with no charge.
5. Reopened the same original checkout URL. Safepay presented the payment form again. No payment was attempted or charged during this probe.

This proves that this observed cancel redirect is not evidence of a terminal payment state. It does not prove an additional charge was made. The current code correctly preserves the pending attempt/reservation and does not treat a redirect, app Back button or timeout as a verified cancellation.

Why it blocks a finished release: releasing stock, a coupon, a return-shipping reservation or a subdomain lock while the old checkout remains payable can allow a late charge against a cancelled allocation. Keeping the reservation indefinitely avoids that financial race but is not an acceptable finished abandonment experience.

Reviewed the official tracker-state and Order/Cancellations API documentation and the official Node SDK. `TRACKER_CANCELLED` and `TRACKER_EXPIRED` are documented terminal states; the documented cancellation methods inspected are authorization reversal, captured-payment refund and void. The inspected setup/SDK contract does not establish a merchant-controlled expiry/cancel operation for an uncharged hosted tracker. No guessed endpoint or unsupported field was used.

Required provider clarification: **What supported merchant API or setup option terminally cancels/expires an unpaid Payments 2.0 hosted tracker, so the old checkout URL can no longer authorize or capture? Is the hosted Cancel button expected to leave `TRACKER_STARTED`? What reliable expiry applies to abandoned sessions, and how are in-flight authorizations handled?**

No support message has been sent, no production credentials/payments were used, and no new code deployment, mobile OTA or APK was released. The account-free recurring approach is verified; this separate cancellation gate and remaining end-to-end/reversal work must be resolved before calling the migration complete.
