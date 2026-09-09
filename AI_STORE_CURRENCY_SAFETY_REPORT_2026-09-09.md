# AI store currency safety — 9 September 2026

Status: **completed — deployed and verified for the scoped currency flows on web, Android and virtual WhatsApp.** Automated and live verification are recorded separately. No untested case is counted as a pass.

## Confirmed business rules

The seller may supply an individual price in a different supported currency. The AI converts and saves it in the store's currency, then explicitly states both the supplied and saved amounts. That is not a store-currency change. The user clarified this behavior after initially suggesting rejection of a mismatched currency.

A long-term store product-currency change is a separate action. It requires a preview, disclosure of existing-product conversion and the waiting period, and the seller's explicit confirmation in a later message. The user selected **60 days** between completed store-currency changes. Individual foreign-currency price inputs remain allowed during that period.

## Implementation

- Existing trusted product-price conversion remains in use. Creation, imports and individual price edits now return a mandatory disclosure containing the original amount/currency and saved amount/store currency. Final web, mobile and WhatsApp replies retain this disclosure even if the language model omits it.
- Added seller-only store-currency preview and confirmation tools. The preview holds server-calculated regular/sale prices for ten minutes. The server retains the quote; the model does not supply rates or reconstruct it.
- Confirmation is tied to the authenticated seller and the latest assistant's preview. Same-turn execution, unclear replies, questions, rejection, changed target currency, expired quotes and changed policy cannot authorize a conversion.
- Existing product conversion was extracted into one shared transaction boundary. The store and every affected product switch together. Product/catalog changes since review cause a fresh-preview requirement; partial conversion is rolled back. Confirming the same quote repeatedly reuses its committed result.
- Added a completed-change timestamp distinct from the older pending/cancel timestamp. Existing sellers are not retroactively locked based on an old abandoned change. Previews and cancelled pending changes do not start a cooldown. Normal settings use the same backend rule as AI.
- Web and native store settings display the server's waiting period and next-allowed date, and validate the returned policy metadata. Existing installed clients can recover their latest quote from their own saved conversation.
- The conversion clears the known legacy discount-currency alias to prevent contradictory currency fields. All canonical monetary writes still pass the product model's validation.
- A store-wide confirmation cannot approve an example price as a new listing's price. An earlier unlabelled amount must be clarified if the store currency changes before publication.
- Past order records, account/display currency and balances are not rewritten. Shipping, tax and coupons retain their separately stored currency settings.

## Automated verification

- Initial store-wide conversion tests: all 12 supported currency directions, regular/sale price conversion, no mutation before confirmation, exact 60-day boundary, concurrent duplicate confirmation, wrong owner, changed target, expired quote, changed catalog, unavailable FX, unsupported target, blocked store, empty store and old-client history recovery passed.
- Additional disposable-database tests verified preservation of historical order/account/shipping records and successful removal of a legacy discount alias during conversion.
- All three chat execution paths were tested with a model response deliberately omitting the price-conversion/cooldown notice. The actual final response still included the server-provided notice.
- The latest targeted backend run passed 76 tests across 3 suites; the preceding controller/currency run passed 92 tests across 3 suites. These runs overlap and are not added together.
- Final expanded backend regression selection: **43 suites, 738 tests passed** after the integration fixes and the additional natural-language consent cases.
- Web JavaScript checks: **217 passed**; production build and both SSR/prerender steps passed.
- The complete mobile suite passed **92 suites / 1,095 tests** on the current mobile code before the interruption. An earlier concurrent run timed out in two unchanged onboarding interaction tests; the complete isolated rerun passed without relaxing their timeouts. A fresh release rerun is recorded below when completed.
- The broad backend run also caught a misplaced context-formatting block and a store-read test fixture with no actual user record. These were corrected locally before release; the affected tests and then the expanded suite passed. Neither failure was deployed.
- The fresh full mobile rerun again exposed overall 5-second timeouts in two multi-screen onboarding tests; the unchanged isolated file passed all 9 cases (the first case took 3,432 ms). The integration file now has a 15-second overall budget, with all individual findBy/waitFor deadlines and assertions retained. The subsequent complete run passed **92 suites / 1,095 tests**. No app timeout, verification expiry or production behavior was relaxed.
- Currency-response deduplication and contradiction tests passed on all three chat adapters; the final targeted controller run passed **72 tests in 3 suites**. The final prompt checks passed **36 tests in 2 suites**. These overlap earlier runs and must not be added together as a unique-test count.
- Final complete backend regression selection after all currency fixes: **44 suites / 752 tests passed** (AI, store-currency conversion/concurrency, order money, line pricing, checkout pricing and product selection).
- The additional direction/confirmation suite passed **45 tests**, including ordinary “from PKR to USD” confirmations and rejection of reversed/different directions. The live-state cooldown-routing check passed for web, mobile and WhatsApp without calling the language model or mutating store state.

The default waiting period is 60 days. The optional server setting `STORE_CURRENCY_CHANGE_COOLDOWN_DAYS` is documented in `Backend/.env.example`; invalid policy values fail closed, and a preview must be reviewed again if the policy changes before confirmation.

## Live verification and release

Code commits pushed to both `origin/main` and `tortrose/main`:

- `7b5dd111`: price-conversion disclosure, reviewed store-wide conversion, atomic save, 60-day backend policy, web/mobile policy UI, and regression coverage.
- `bf0db73c`: use the server-confirmed currency wording once instead of repeating or contradicting the model's paraphrase; multi-screen integration-test wall-clock budget adjustment.
- `b1b3921b`: clarify that another currency can be used for an input price, but all saved listing prices use the store currency.
- `30dbfcbd`: accept an explicit source-to-target confirmation such as “Yes change from PKR to USD” without mistaking the source currency for a changed target; reject the reversed/different direction.
- `f7e9bd65`: answer a locked, single-purpose store-currency request directly from the current store policy before AI planning. This prevents misleading offers to change a locked currency and leaves individual product-price actions available.

Vercel and Railway reported successful deployment for each released code step; the final application-code release is `f7e9bd65`.

Mobile production OTA, runtime **1.0.11**, published successfully from `b1b3921b`:

- Group: `fd2c0887-b12e-436b-944d-c1562d2ecef8`.
- Android: `01a0844a-0dbe-7011-8efb-9b20caa38376`.
- iOS: `01a0844a-0dbe-7392-a607-f4f2ac31f2ca`.

The cold Metro cache was rebuilt and both bundles/fingerprints were completed; compatibility checks were not skipped. No new native APK/AAB was built. Android reported **DownloadComplete** for `01a0844a-0dbe-7011-8efb-9b20caa38376`; I restarted the app to activate it before the final native preview/confirmation/settings checks. Later commits changed backend behavior or tests, not the mobile application bundle. Publishing is not counted as an iOS device test.

Dedicated live seller setup completed through the browser: `rzacurrency090901@mailinator.com`, display name Currency QA Seller 90901, store **Juniper Trails 90901**, Pakistan/Lahore, initially **PKR**. The account/display selector is USD. The approved virtual WhatsApp number ends in **0148**; its OTP was read from the admin test inbox and verified while signed back into the correct seller account. The independent Store Overview showed 0 products, 0 orders and Rs0 recognized revenue. Passwords and OTP values are omitted.

### Live product inputs and preview

1. Uploaded a photo and asked: “Add this to my store as Juniper Travel Cup. It is a reusable cup with a lid. Price 12.50 US dollars, sale price 10 US dollars, stock five. Brand Juniper Trails. Choose the category and write a short description.”
   - AI disclosed both conversions: **$12.50 USD → Rs3,469.13 PKR**, and **$10.00 USD → Rs2,775.30 PKR** sale price.
   - Independently reloaded Products showed those exact regular/sale prices and stock **5**; store settings stayed **PKR**. **PASS.**
   - The initial final reply repeated its conversion explanation. `bf0db73c` switched currency results to the server-confirmed wording once, also preventing contradictory model pricing prose from overriding it.
2. Uploaded the same test photo and requested Juniper Picnic Cup at **Rs2,100**, stock **3**, no sale price. The independent catalog showed those values. **PASS.**
3. Asked: “I am thinking of using USD for my whole store long term. Show me what will change first. Do not change anything yet.”
   - Preview: Travel Cup **Rs3,469.13 → $12.50**, sale **Rs2,775.30 → $10.00**; Picnic Cup **Rs2,100 → $7.57**.
   - It explained that **2 products** would be converted, the **60-day** waiting period, unchanged historical orders/balances and separately stored shipping/tax/coupon terms, and asked for confirmation.
   - Independent store settings remained **PKR**; no catalog conversion had occurred. **PASS.**
4. Replied: “No, keep my store in PKR.” Independently reloaded settings/catalog retained PKR and both original prices/stock. **PASS for refusal/no mutation.** The reply's “unless specified” wording was ambiguous about input versus stored currency; `b1b3921b` clarified this policy. A subsequent ordinary question (“If I give a USD price now, will the product still be saved in PKR?”) received an explicit answer that the price is converted and saved in PKR. **PASS for clarified explanation.**

### Android confirmation and independent saved-data verification

5. Signed the Android app into the dedicated seller account. The native AI loaded the same Juniper conversation. Sent **“Show a USD preview for my store”** through the real app input.
   - Native reply displayed the two Juniper products, the exact same regular/sale conversions, the 60-day waiting period, the ten-minute preview window, and the requirement to confirm.
   - Sent **“Yes change from PKR to USD”** in the next native message. The AI returned a successful store-currency action receipt for **2 converted products**. **PASS.**
6. Reloaded the website's seller settings and actual product editor forms after the Android confirmation:

| Product | Before, saved PKR | After, saved USD | Stock |
| --- | ---: | ---: | ---: |
| Juniper Travel Cup — regular | Rs3,469.13 | $12.50 | 5, unchanged |
| Juniper Travel Cup — sale | Rs2,775.30 | $10.00 | Same product |
| Juniper Picnic Cup — regular | Rs2,100.00 | $7.57 | 3, unchanged |

The editor inputs explicitly showed **“in USD”**, not merely a buyer-display conversion. The main images and descriptions remained. The amounts matched the reviewed conversion exactly. Existing currency rounding remains in use; this change does not introduce a new fee or a checkout round-up rule. **PASS.**

7. Website Store Settings showed **USD**, a disabled currency selector and the next allowed date **8 November 2026, 09:19:05 Pakistan time (04:19:05 UTC)**. Android Store Settings showed the same selected currency, same date and 60-day note; all four currency controls had `enabled=false`. The visible native layout was also inspected in `test-assets/currency-native-cooldown.png`. **PASS.**

One unrelated native “Open my store settings” request returned the generic retry message. Retrying as “Open store settings” successfully opened the actual native settings screen. I did not count the first attempt as a pass or claim a proven root cause; targeted server-log queries did not expose a corresponding error. No persistent navigation failure was reproduced. Android input/keyboard automation issues were checked against visible UI state before submitting messages; incomplete agent drafts were not treated as completed actions.

### Virtual WhatsApp during the 60-day lock

8. As virtual number ending **0148**, requested **“Change my store back to PKR now please.”**
   - The initial reply unnecessarily offered a preview despite the active cooldown; it did not change the store.
   - `f7e9bd65` added authoritative live-policy handling for this request. The exact live retest immediately replied that the store uses USD, cannot change until **8 November 2026 at 04:19 UTC**, and still accepts foreign-currency product inputs by converting them into USD. It explicitly said no store-wide change was made. **Retest PASS.**
9. Requested a new **Juniper Camp Cup** in ordinary WhatsApp text: price **2,800 rupees**, stock **two**, brand Juniper Trails, category Drinkware, supplied description, and the previously uploaded public product-photo URL.
   - WhatsApp replied: **Rs2,800.00 PKR → $10.09 USD**, saved as the product price; store currency remained USD.
   - Signed back into the seller website and independently inspected the new product editor: **$10.09, in USD, stock 2, no sale price, and the supplied image URL**. The other two products retained their converted USD prices and stocks. **PASS.**
   - This is virtual WhatsApp text with a supplied photo URL, not a claim of physical WhatsApp photo-attachment delivery.

## Final cleanup and retained state

10. Through seller AI, requested deletion of exactly **Juniper Travel Cup, Juniper Picnic Cup and Juniper Camp Cup**, explicitly retaining the store account/currency settings. The action receipt listed three deleted products; the independently reloaded seller catalog was empty. **PASS.**
11. With the catalog empty, again requested **“Change my store back to PKR now please.”** The live website AI still enforced the same 60-day lock. Reloaded Store Settings remained USD with the same disabled selector and **09:19:05 on 8 November** deadline. Adding or deleting products neither bypassed nor restarted the waiting period. **PASS.**

The dedicated store/account remains available in **USD**, under the real 60-day restriction. The temporary listings were deleted; the uploaded source images, local test image and chat/action history remain available for recreation/audit. Earlier stores' catalog/order baselines were not used for this currency switch. No live order or payment was created in this currency test, and no real funds were charged or withdrawn.

Final independently reloaded seller dashboard: **0 products, 0 orders, $0.00 revenue, 0 pending/processing/delivered orders and 0 low-stock products**. The store-currency lock remained unchanged.

## Scope of the result

The requested flows were verified on the live website, installed Android app and virtual WhatsApp test workflow. All four supported store currencies were covered in automated conversion-direction tests. iOS was published but not interactively tested on a device. Physical WhatsApp delivery and live Stripe/wallet transactions were not exercised here. The report does not claim exhaustive understanding of every possible phrase or every unrelated AI action.

Application code is committed/pushed to both configured repositories and deployed; this report is committed separately. Generated `test-assets/` remain local and are not included in Git.
