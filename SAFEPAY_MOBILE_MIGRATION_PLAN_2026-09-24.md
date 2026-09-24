# Safepay mobile migration — inspected scope and release gates

Status: implementation in progress. The user supplied the sandbox signing key on 25 September. Strict configuration/client, webhook verification/receipt modules and payment/event models now have 23 passing unit tests. The signed callback receiver is being deployed for a controlled protocol check. No app checkout has been switched and no Android build has been made yet.

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
