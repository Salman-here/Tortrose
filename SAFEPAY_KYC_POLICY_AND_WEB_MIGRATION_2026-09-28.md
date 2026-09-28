# Safepay KYC policies and website payment cutover

Date: 28 September 2026

## Release status: website/backend deployed; sandbox verification in progress

At the initial checkpoint, the website and installed mobile application had **not** been updated by this work. The last verified production website deployment before this release was `0d988e6cf34f0061c1576ba31d36ea987ca58de4` (`dpl_EeBNEKG42o2sm6uA9Lx3CgpNdPxD`, READY). The approved release is being prepared; deployment and sandbox end-to-end evidence will be recorded separately below after verification.

The merchant supplied and confirmed the following details after the initial local verification:

1. **ROZARE (SMC-PRIVATE) LIMITED**, trading as **Rozare**; website `https://rozare.com`.
2. Registered and principal business address: **House/Plot No. 143, Street 8, Jinnah Block, Bahria Town, Lahore, Punjab 54000, Pakistan**.
3. Support: **+92 320 1166402**, **support@rozare.com**; general company email: **hello@rozare.com**.
4. Pakistani governing law and competent courts of **Lahore, Punjab, Pakistan**, including applicable consumer courts where required by law.
5. Approved commitments: acknowledge complaints within **2 business days**, aim to resolve them within **7 business days**, and initiate an approved refund within **3 business days** after approval and required return inspection.

The merchant explicitly approved these timelines. Bank/card arrival time is expressly separate from Rozare's initiation time. No registered address, phone number, city, or transaction history was fabricated.

The policy config at `MobileApp/src/content/commercePolicyConfig.json` now has `publicationApproved: true`, and the publication preflight passes. The website deployment command continues to guard against incomplete business details. Safepay remains sandbox-only pending merchant approval.

### Approved release progress

- Source commit: `52e8c2266f753987ccb11c5ff4e5bf83ceb7adbc` — approved merchant policies and Safepay website checkout. Saved locally; both remote branches still matched the prior release before this commit.
- Android production-channel OTA published for runtime **1.0.13**: group `d82dcd1a-cee6-4a2c-b128-eaacabc50bc3`, update `01a0e8b9-51f1-78ca-b74d-7ea4d245b006`. [Expo release](https://expo.dev/accounts/rozare/projects/rozare/updates/d82dcd1a-cee6-4a2c-b128-eaacabc50bc3). No new native APK is required for compatible 1.0.13 installations. Installed-app verification is in progress.
- Web pre-release browser checks confirmed the exact address, Lahore/Punjab jurisdiction, both public email addresses, support phone and 2/7/3-business-day commitments. The draft notice is absent; phone-width policy pages had no horizontal overflow.
- Railway access was restored as `mzohaibiqbal00@gmail.com` in Ishan's workspace. Verified project `independent-vision`, service `hello-friend`, and sandbox credentials/webhook configuration. Enabled `SAFEPAY_WEB_ENABLED=true` without changing `SAFEPAY_ENV=sandbox` or the mobile flag.
- Commit `52e8c226` was pushed to both remotes. Vercel deployment `dpl_2HFctRWkL9TxHTmpRYvyAf53Y8wa` is READY, and Railway deployment `7b4a333e-8469-46f3-8ed7-03019dfa0af6` is SUCCESS. `/health` confirms this exact commit, MongoDB connected and the notification worker started. The authenticated web payment config reports enabled Safepay **sandbox**. Public `/terms` returns HTTP 200 with the approved address/jurisdiction and no draft notice.
- Live testing found a Wallet display contract omission: valid `safepay_payment` transactions were rejected by the website's reference-type allowlist. The account API returned HTTP 200 with USD 1.00 and PKR 2,000, but the page correctly hid unverified data. Added the three exact backend Safepay reference types and regression coverage, including enum parity and rejection of invented references and malformed money. No balances or historical records were changed by this correction. Release/retest evidence follows when complete.
- Wallet correction commit `90d131fc493a556380e3020986e21a7a20749405` is pushed to both remotes; Vercel deployment `dpl_AwHD2tMFybNLRiq3R1KrSXmrJRoB` is READY. Retesting the live Wallet showed **USD 1.00 and PKR 2,000.00**, with both earlier Safepay top-ups correctly displayed. All **278 website tests** passed after this correction.
- The live embedded Safepay form loaded **$1.00 USD**, showed the sandbox label, accepted test contact/card fields and required no separate Safepay account. Closing it before payment left balances unchanged. Reopening, including after the test browser session restarted, retained the same payment `6aba9232ed31475fad8c5722` and tracker `track_4dad3b5e-506e-4059-98e4-c3c258a6c22f`; no duplicate tracker or Wallet credit was created.
- **Payment completion is not verified.** The browser automation session restarted during submission, then subsequent browser attempts became unreliable. The backend's authenticated status query still reported `pending`, `TRACKER_STARTED`, USD 100 minor units and `isPaid: false`. The read-only database audit also showed no completed Wallet transaction and unchanged balances. Do not label this a completed payment test or submit a different payment to replace this unresolved attempt.
- A concrete local network issue was reproduced: Windows default DNS lookup for `rozare.com` returned **DNS server failure**, while querying resolver `1.1.1.1` returned public Vercel IP addresses. Both sidebar and Chrome browser navigation reported **ERR_NAME_NOT_RESOLVED**. No Windows DNS/security settings or certificate protections were changed. Public policy HTTP checks had already returned 200, and backend health confirmed the deployed commit and MongoDB connection.
- Code review also found that shared Safepay reconciliation and renewal workers were gated only by the mobile switch. They now run when either the web or mobile Safepay switch is enabled, so disabling mobile checkout does not stop web financial processing. Targeted regression: **4 suites / 40 tests PASS**. Added `Backend/scripts/auditSafepaySandboxAccount.js`, a read-only, QA-account-scoped audit that never exports checkout URLs, access tokens or card details.
- Rechecked publication preflight, website production build and all 276 web tests: **PASS**. Final legal/native parity and navigation tests: **34 PASS**.

## Scope and source material

- Reviewed the user-supplied Safepay email history, especially the 28 September KYC requests.
- Read both pages of `C:/Users/Salman/Downloads/templatetermsandconditions2023_1388taq.pdf`; rendered and visually inspected both pages. Clause 1 identifies the operator, addresses and contacts. Clause 8 concerns Pakistani governing law and a specified court jurisdiction.
- Reviewed Safepay's [Website Checklist](https://safepay.helpscoutdocs.com/article/79-website-checklist), [Express Checkout documentation](https://safepay-docs.netlify.app/build-your-integration/express-checkout/), and [refund guide](https://safepay.helpscoutdocs.com/article/141-how-to-refund-car-new).
- Considered the [current refund charges explanation](https://safepay.helpscoutdocs.com/article/174-what-happens-to-safepay-charges-when-i-issue-a-refund). No new buyer or seller processing fee was introduced.
- The user will handle the three-month transaction-history request. No work was performed on that request.
- The user confirmed that old records are test data. **No historical payment, order, balance, customer or subscription data was migrated, rewritten or deleted.**

This is an implementation and verification report, not a guarantee of legal sufficiency or Safepay merchant approval. Safepay still decides whether the policies and business model satisfy its review.

## Policy changes

Web and mobile use the same policy content and business configuration, rather than independently maintained copies.

| Web route | Native screen | Change |
| --- | --- | --- |
| `/terms` | `TermsOfService` | Operator identity, addresses/contact slots, seller-fulfilled marketplace model, pricing/currency, Safepay, subscriptions and consent, cancellation/refund references, Pakistani law/jurisdiction, complaints and mandatory consumer-rights safeguards. |
| `/shipping-policy` | `ShippingPolicy` | New dedicated policy: seller fulfillment, coverage, separate multi-seller shipments, checkout costs/ETAs, address accuracy, delays and non-delivery. |
| `/refund-policy` | `RefundPolicy` | New dedicated policy: saved item eligibility, return request/inspection flow, refund amount/destination, processing turnaround, card reversals, subscriptions/top-ups and complaint escalation. |
| `/cancellation-policy` | `CancellationPolicy` | New dedicated policy: unpaid/unshipped cancellation, paid-order refund requirement, multi-seller limitations, closing checkout, later payments and subscription renewal cancellation. |
| `/privacy` | `PrivacyPolicy` | Operator identity and explicit Safepay data handling: provider references, masked card data, billing contacts and consent; no raw card number/CVV storage by Rozare. |
| `/contact` | `Contact` | Legal operator/address/contact details and complaint handling commitments, using the same configuration. |

Added policy links to the website footer, checkout and related-policy navigation, and to mobile Settings, checkout, Docs and the policy screens. AI navigation recognizes the new policy routes. Added public routing/sitemap entries and server-rendered HTML for the four commerce policies so reviewers can access their text directly.

The older documentation gave generic Free/Standard/Express shipping days as if they were platform promises. It now explains that the actual seller's checkout estimate controls.

### Important correspondence with existing behavior

- A standard approved product return currently credits the buyer's **Rozare Wallet**, after the seller funds the exact approved refund and the backend verifies it. It does not automatically refund the buyer's original card. This is now disclosed in the policy and at checkout.
- Safepay original-payment reversals for unapplied/invalid card payments are a distinct process. The policy does not confuse these with Wallet refunds.
- Paid orders cannot be cancelled as though unpaid. Before shipment, the buyer contacts support for refund assistance. Eligible delivered items use the return process.
- Whole-order cancellation is unavailable once any seller's portion has shipped or been delivered.
- Closing a payment window is not proof of cancellation, failed payment or refund. Existing availability/reconciliation/refund logic remains authoritative.
- Subscription cancellation stops future renewal at the applicable period end; it does not automatically refund a previously used period.
- Item-specific policies cannot remove mandatory legal rights. The draft does not copy blanket liability exclusions from the template without qualification.

## Safepay website implementation

The website was still creating transactions with the previous provider. New client flows now use the existing Safepay backend contracts:

1. **Product purchases:** card selection sends `paymentMethod: safepay`, `paymentFlow: safepay_hosted`, `clientSurface: web`. Existing COD and Wallet checkout paths remain unchanged.
2. **Wallet top-ups:** use Safepay and verify the exact completed Wallet transaction amount/currency before showing a credit as successful.
3. **Payment Methods:** list the authenticated customer's masked Safepay cards; collect missing billing name, phone and country; require card-storage consent; open Safepay's secure card form; verify setup; support default selection and removal. An unavailable card list is not shown as an authoritative empty list.
4. **Seller subscriptions:** obtain a backend-owned quote, display the exact due-now/monthly price, saved card and renewal terms, require explicit consent, and check the specific operation before granting a success message. Included billing-card changes, pending-operation checks and failed-payment retry. Existing cancellation/downgrade/resume handling already dispatches according to the saved provider.
5. **Subdomain purchases:** use Safepay with a durable retry key and verify payment before refreshing ownership. An incoming `purchase=success` query no longer claims ownership by itself.
6. **Seller return funding:** card-funded Wallet refunds use Safepay, the existing immutable return calculation and the same verification-before-credit rules.

The shared web payment dialog embeds the allowlisted Safepay secure form and polls the authenticated backend. If a bank/browser needs it, a link opens that same secure form in a separate tab. This presentation still requires a real web sandbox charge and bank-authentication check after deployment; it is not claimed fully verified here.

### Backend/security boundaries

- Added independent web enablement through `SAFEPAY_WEB_ENABLED`; mobile retains `SAFEPAY_MOBILE_ENABLED`. No runtime flag was changed in this task.
- Preserved the sandbox/production separation and exact amount, currency, ownership, idempotency and settlement checks.
- Web returns use a fixed `https://rozare.com/safepay/return` destination. Incoming query parameters cannot mark a payment paid or redirect to a caller-provided site.
- Reopening a payment requires the authenticated owner. Web/mobile presentation changes do not create a second tracker.
- The client rejects malformed money, unknown identities/purposes, non-HTTPS URLs, lookalike hosts, credentials in URLs and environment mismatches.
- Payment success requires backend verification. Closing, an unknown response or a network interruption retains the attempt instead of assuming failure and charging again.
- Added bounded Safepay client timeouts so a stalled verification request cannot leave the dialog locked indefinitely.
- Added a cutover guard: after web Safepay enablement, older clients cannot create new previous-provider card orders, top-ups, saved-card setups, subscription checkouts/upgrades, subdomain purchases or return-funding checkouts. They receive a refresh/update instruction. Existing receipts and reconciliation are not disabled or migrated.

### Branding and AI

Removed the previous provider's customer-facing labels from the relevant web/mobile order, payment, subscription, Wallet, FAQ and documentation surfaces. Removed its website SDK dependencies and unused mode badge; replaced the website payment/frame allowlist with Safepay origins. Internal fields still needed to read existing test records were not relabelled as Safepay records.

Updated AI payment knowledge and its non-overridable financial guidance. Online card/Wallet requests are directed to secure checkout, not charged in chat. Added explicit handling for Safepay and Wallet tool requests and policy-page navigation. No AI moderation feature was added.

## Verification performed

| Check | Observed result |
| --- | --- |
| Initial Safepay regression suite | **PASS:** 11 suites, 124 tests. |
| Full backend regression | **PASS:** 235 suites, 3,493 tests at that checkpoint. |
| Final targeted backend checks after cutover guard and AI additions | **PASS:** 20 suites, 299 tests, including provider cutover, web ownership/return safety, billing, settlement, top-up recovery and AI routing/idempotency. This is a targeted rerun, not a second full-suite run. |
| Website tests | **PASS:** 276 tests, including exact-money/payment contracts, retry-key behavior, subscription verification and public/private SEO routing. |
| Full mobile regression | **PASS:** 106 suites, 1,197 tests at that checkpoint. |
| Final native policy/navigation tests | **PASS:** 3 suites, 33 tests after the additional policy-route mappings. |
| Website production build | **PASS:** client and SSR bundles, including pre-rendered policy HTML. |
| Android JavaScript export | **PASS:** Expo generated the Android Hermes bundle. This is not a new APK or OTA publication. |
| Policy publication guard | **PASS after merchant confirmation:** exact business/contact details, Lahore jurisdiction and approved service commitments are present. It correctly blocked the earlier incomplete draft. |

Initial test failures were stale assertions expecting the former provider SDK/copy or separate static legal arrays. They were updated to test the new Safepay/shared-policy behavior, then rerun successfully. Negative-path test logs about intentionally invalid state or unavailable local integrations are not evidence of production failures.

### Browser observations

Used the new local web UI. Policy pages were checked at desktop width and a **390 × 844** phone viewport. The Terms and Refund pages displayed their headings, full policy sections, links and the explicit draft warning. The phone Refund page had no horizontal overflow or error overlay. Browser error collection was empty on the checked pages.

The first authenticated check used local port 5182, which the production backend does not allow for CORS. Switched to the existing allowed port 5173; no CORS/security setting was weakened.

Signed into the existing Safepay QA seller using the normal browser login form, then performed read-only checks against the live backend:

- Payment Methods loaded the seller's saved **Visa ending 1111**, expiry **12/2030**. The card-storage consent remained unchecked; Add was disabled until consent.
- Subscription displayed the current Starter plan. Opening **Change billing card** showed **$0.00 USD due now**, **$9.99 USD/month**, the saved card and the explanation that changing the card neither collects payment nor changes the renewal date.
- Confirmation remained disabled without explicit renewal consent. Dismissed with **Not now**. No card was changed and no subscription or payment was submitted.

Evidence is under the ignored `test-assets/` directory:

- `safepay-policy-pdf-20260928/template-1.png` and `template-2.png`.
- `safepay-kyc-terms-20260928.png`.
- `safepay-kyc-refunds-mobile-web-20260928.png`.
- `safepay-kyc-web-saved-cards-20260928.png`.
- `safepay-kyc-web-subscription-review-20260928.png`.
- Backend/mobile JSON test reports and the website JUnit report named `safepay-kyc-*20260928*`.
- `safepay-kyc-android-export-20260928/`.

## Remaining before release

1. **Completed:** merchant supplied all business details and approved the timelines; the shared policy config and publication preflight are finalized.
2. Recheck the final legal wording, refund destinations and service promises with the merchant; Safepay may require further changes after review.
3. Run the publication preflight with the confirmed config. Ensure Vercel includes the shared policy source under `MobileApp` when building `Frontend`; the project-details connector had conflicting parameter schemas during this check, so that project setting was not verified.
4. Commit and push the reviewed source, deploy the backend/frontend in a controlled cutover, enable **web Safepay sandbox**, and verify the published policy URLs and Safepay frame/security headers. Keep live-mode activation separate from sandbox enablement.
5. Complete real sandbox web purchase, top-up, card setup/removal/default, subscription enrollment/change/retry/cancel, subdomain and return-funding checks, including close/resume, failed payment and provider authentication. Tests and read-only UI checks above do not replace those payment submissions.
6. Publish the approved mobile JavaScript update and verify the new policy screens on the installed app. No new native dependency was added, but release validation is still required.
7. Give Safepay the final public policy links/screenshots and updated recording when requested. The merchant supplies any transaction-history explanation directly.

No real card charge, bank payout, production Safepay activation, test-data migration or old-record cleanup was performed. The pre-existing `.gitignore` change was left untouched. Generated local build output is not a deployment.
