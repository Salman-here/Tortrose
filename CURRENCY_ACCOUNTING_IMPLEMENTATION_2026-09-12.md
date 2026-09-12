# Store currency and native seller accounting implementation

Status: in progress; not deployed or production-verified.

## Agreed rules

- Confirmed store currency changes convert and save regular/sale prices, shipping fees, fixed coupon discounts, coupon minimums and discount caps atomically at one reviewed rate snapshot. Percentages, inventory, delivery days and expiry dates do not change.
- The preview is bounded: counts, three product examples, shipping/coupon summaries, rates, expiry and the existing 60-day cooldown. Modified terms require a new preview.
- Every new order requires and saves a complete trusted checkout snapshot for USD/PKR/EUR/GBP. Same-currency prices are not converted.
- Existing order amounts/currencies are immutable. Future orders use the currency at placement, even if they become paid/delivered after a store change.
- Historical revenue reports use each order's original rates, not current rates. Reporting does not change actual balances.
- Seller funds accrue and are debited/reserved separately in each order's frozen seller currency. No implicit USD balance or self-service balance conversion.
- Manual withdrawal amount, balance currency and bank currency must match. Reserve once; approval is not payment; payment needs transfer evidence; uncertain outcomes remain reserved.
- Minimums: USD 5, PKR 2000, EUR 5, GBP 5. Static, not FX-derived.
- Tax and payment-processing fee policy are outside this change. Preserve existing calculation/ownership policy.
- Old test data will not be deleted or rewritten as a shortcut. Versioned legacy withdrawal records retain their signed terms.

## Work sequence and verification

1. Shared pricing conversion plan, stale-data protection, web/mobile/AI preview contracts.
2. Complete checkout snapshots and historical revenue reporting, including exports and AI summaries.
3. Native balances, refunds/reversals, same-currency manual withdrawals and admin controls.
4. Web/mobile display parity and minimum validation; no balance-display/withdrawal-limit mismatch.
5. Focused/regression tests, builds and cross-currency/race/rounding cases; deployment and live UI verification where accessible.

Verification results, limitations, release commits and examples will be recorded here as the work progresses. No automated test is to be reported as a completed bank payout or a physical-device notification test.

## Implementation progress (local, not yet released)

- Added `storeCurrencyTermsService`: owner-scoped shipping/coupon conversion, preview fingerprints, same-snapshot amounts, representability checks, full validation and transactional writes. Preserves redemption counters, percentages, delivery settings and expiry dates.
- Manual store settings now use the same persisted owner-bound preview/confirmation as AI. Old pending transitions require a fresh review; no-token confirmation does not bypass it. Website and mobile carry the preview token internally.
- Every new web/AI order requires trusted full rate snapshots. AI now also persists explicit seller product currency and seller-native money, matching web checkout. The earlier AI path relied on reconstruction.
- Added first-insert pricing guard sharing Store write locks; rechecks current product/shipping terms before insertion and triggers the existing explicit checkout-reprice flow. Historical callbacks/retries are not repriced.
- Historical report aggregation, seller analytics, store/subdomain metrics, coupon metrics and order exports now use order snapshots. Product report allocations share order-level rounding.
- Added version-2 native withdrawal accounting. Balances use frozen seller-native entitlements, separate currency buckets, same-currency reservations and static minima. Withdrawals use no FX quote. Legacy signed withdrawals remain versioned and retain old authorization logic; ambiguous legacy reservations quarantine new payouts rather than being guessed into a native bucket.
- Seller-funded returns debit their original native bucket. Reversal liability is accumulated per original order/provider risk track; separate refund and dispute exposure is not incorrectly globally capped. Negative availability is exposed as a same-currency deficit.
- New withdrawal amount/currency/bank destination are authenticated together in existing encrypted payout envelopes. Existing approval/processing/evidence/manual-review/retry transitions remain in place.
- Web/mobile payment screens select native balances independently of store reporting currency. The amount label, static minimum, available value, request body and retry key use that selected balance currency. Responses are additionally bound to the authenticated seller identity.
- Admin payments show native-currency totals and per-seller balances; signed payout details stay exact. Unverifiable seller data is explicitly listed and excluded, not silently shown as zero.
- Documentation and AI tool descriptions explain native balances, historical analytics, same-currency manual payouts and the expanded store conversion scope.

## Verification so far (not final release verdict)

- Web Node tests: 221 passed, 0 failed after the current UI contract updates.
- Website production Vite/SSR/prerender build passed once; rebuild required after subsequent documentation/UI changes.
- New pure native accounting suite: 32 passed, including all 16 supported seller/buyer currency pairs, native balance separation, withdrawal statuses, cumulative refunds, deficits and historical rates.
- New Mongo replica-set integration suite: 10 passed, including a bounded 300-product preview with shipping/coupons, stale mutations, four currency minima, exact reservations/replays and simulated manual payout proof lifecycle.
- Return and Stripe-risk regression rerun plus native suite: 107 passed. This found and fixed independent refund/dispute exposure handling.
- Web/AI checkout and new native integration rerun: 129 passed, including explicit price reconfirmation, zero-total orders, idempotency, complete snapshots and frozen AI seller money.
- Existing currency service unit suite: 23 passed; request tests now exercise persisted-preview semantics, shared plan/commit unit tests remain, with real transactional coverage separately.
- Initial full mobile regression: 1,094 passed / 1 old FX-withdrawal contract assertion failed. That assertion was updated; targeted native screen interaction and safety rerun passed 7 tests. Final full mobile rerun is still needed.
- New native mobile screen test rendered the real Payments component, selected an existing PKR balance in a USD store, showed the PKR 2,000 minimum and submitted an exact PKR request. A wrong-seller summary was rejected.
- Full backend regression is running; changed-contract tests and any genuine regressions are being triaged. Do not count the initial full run as passing.
- No commits, pushes, deployments, mobile OTA publications, live purchases or real bank transfers have been made for this update yet.

## September 13 checkpoint — release verification still in progress

- Final mobile regression artifact: **93 suites, 1,097 tests passed, zero failures**. An earlier cold-render onboarding timeout passed on its own rerun and then in the complete fresh run; no onboarding assertion was removed.
- Updated website: **230 tests passed**; the complete Vite/SSR/prerender production build passed again after the final payment-screen changes.
- Android/Hermes export succeeded (`test-assets/native-currency-android-export`). This is build evidence, not a hands-on device verdict.
- Expanded native accounting and Mongo integration rerun: **66 passed**, covering all currency directions, shared admin/web/mobile response contracts, static minima and exact reservations. Two final coupon-preservation cases were added afterwards and are running.
- AI ordering rerun: **69 passed**. Natural-conversation/controller rerun: **36 passed**, including actual clock context on web/mobile/WhatsApp. A live test-coupon setup exposed an AI-invented past start date for "today"; the model now receives the actual server timestamp and creation instructions say to omit startDate for an immediate start. New live verification of that fix is pending.
- Payment-screen review removed obsolete live-FX-estimate copy; nonzero approved/review reservations, reversals, credits, holds and deficits are displayed in the selected native balance currency. Client validation checks exact balance arithmetic, not just currency labels.
- Admin totals include native-currency order counts and reject duplicate identities. A failed seller aggregation cannot partially contaminate marketplace totals.
- The long backend run ended without a final JSON report after the runtime interruption. It is **not** counted as a successful full run. The complete suite is now running in four independent Jest shards with saved reports, without the expensive open-handle tracing option.
- Code remains local at this checkpoint; the live backend is still commit `4acf0e112341bcc1cc63afe6f3693b3b37d16831`.

### Live baseline and setup (old deployed version)

- Dedicated seller: `rzais90501@mailinator.com`, **Mobile AI Forge 90501**, product currency PKR; account display currency USD. No admin account was used as a buyer.
- Products: Aurora Thermal Travel Mug PKR 3,664.50 / stock 22; Alpine Vacuum Lunch Jar PKR 2,614.50 / stock 16; Meridian Bamboo Desk Lamp PKR 4,399.50 / stock 11.
- Shipping: standard PKR 275.00, four days, active. Store revenue baseline PKR 7,439.26 from two delivered orders.
- Old delivered order `ORD-1788584058484` (`6a9ba07a5257ed5786710ac5`) visibly shows Black / 350ml, PKR 3,664.50 + PKR 275.00 = **PKR 3,939.50**. Another delivered order `ORD-1788583360941` shows PKR 3,499.76. These records will remain unchanged.
- Two test coupons were created through ordinary seller AI requests and verified on the coupon dashboard: `FXSEP12FIX` (PKR 100 fixed discount, PKR 1,000 minimum, PKR 200 cap) and `FXSEP12PCT` (10%, PKR 2,000 minimum, PKR 300 cap). Each permits ten uses, once per buyer. Their visible expiry is September 21 locally (saved date September 20 UTC). The fixed coupon editor confirmed its saved money fields. Both must be deactivated after testing.
- The in-app browser's native date picker crashed its tab during coupon setup; no form was saved from that attempt. A new tab recovered the authenticated session; coupon setup continued through the website AI and was verified in the normal seller UI.
- Dedicated buyer `rzaib90501@mailinator.com` is signed in. One Aurora mug, **Silver / 500ml**, is in the cart at PKR 3,664.50. **No new order has been placed yet.** Checkout, store change, post-change order checks and release verification remain pending.
