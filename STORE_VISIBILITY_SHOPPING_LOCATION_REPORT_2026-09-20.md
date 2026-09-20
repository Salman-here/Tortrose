# Store visibility and shopping location release

Date: 20 September 2026. Application commit: `63231e1e`.

> Later requirement update: the Global-only rule recorded in this original report has been superseded by **Global + the buyer's own country**. See `GLOBAL_PLUS_COUNTRY_REPORT_2026-09-20.md` for the new behavior and verification. The observations below remain a historical record of the original release.

## Scope and intended behavior

This release implements the requested seller visibility step and explicit buyer Country/Global shopping choice on the website and mobile app. It does not change historical orders, exchange rates, store currencies, balances or payment calculations.

Country and Global are separate catalogs, as requested:

| Buyer choice | Stores/products shown |
| --- | --- |
| Pakistan | Stores targeting Pakistan; matching state/city/town stores when the buyer supplies that local area |
| Another country | Stores targeting that country, plus matching local scopes |
| Global | Only stores explicitly configured as Global, and platform-owned products without a seller |

For example, a Pakistan-only seller does not appear in Global shopping. A Global seller does not appear in the Pakistan-only catalog. This is a browsing preference, not a claim that the buyer physically lives there. Checkout still checks the actual delivery address.

## Before and after, by flow

### Seller onboarding: website and mobile

Before: store creation did not present a dedicated visibility decision alongside onboarding. Missing visibility could later depend on inferred geography, including unsuitable currency-based defaults.

After: Personal details → Store setup → Visibility → WhatsApp verification. The Visibility step offers Global, Country, State, City and Town. Country initially follows the store's selected country. The seller can deliberately target a different area without changing the physical store address.

Global displays: “Only choose Global if you can ship your products globally. Your store and products will appear in Global shopping.”

The reviewed choice is validated by the backend and saved in the same transaction as store creation. Invalid input cannot consume the WhatsApp verification or promote the buyer to seller. Currency recommendation, currency confirmation and WhatsApp account binding remain in place.

### Seller Store Settings

The existing visibility editor remains available. Global wording now explains the Global catalog and worldwide-shipping responsibility. Town is entered as a local area after selecting its parent city; the city directory is not misleadingly used as a neighborhood directory. Saved visibility descriptions are regenerated, preventing an old “Pakistan” label from surviving a switch to Global.

### Buyer first visit and Filters

Before: an inferred location was used without a clear Country/Global choice, and Global was not available to shoppers.

After: the first marketplace visit displays “Where would you like to shop?” Country is initially selected, with a genuinely detected country suggested. The buyer can select Global or another country. Failed detection is not presented as a successful US detection. If no reliable country is available, the chooser asks for one rather than inventing it.

The popup says the choice can be changed any time in Filters and does not change currency or delivery address. The explicit choice persists across reloads. On the website it is shared with Rozare store subdomains through a narrowly scoped preference cookie. On mobile it persists in device storage. Late country detection and login do not overwrite a manual choice.

### Catalog surfaces and direct links

The same backend policy governs products, product filters, store search/suggestions, Marketplace, trusted-store discovery, store product lists, direct product/store URLs and store subdomains. Frontend catalog state is refreshed on a scope change. The website's offline product cache is reused only for the identical query scope. Mobile drops stale responses after a location change.

A direct link outside the chosen area shows an unavailable state with a Change shopping location action. Blocking or deleting a seller remains a separate restriction; choosing Global does not bypass it. Trusted relationships are not deleted when the store is outside the current catalog.

### AI discovery

Web/mobile AI requests carry the selected shopping area. Read-only discovery and internal product-name searches inherit that area from the transport, not from model-supplied tool arguments. Parallel requests use isolated scopes. This release does not add a WhatsApp location-selection conversation or change WhatsApp message templates.

### Checkout and existing data

Browsing area and delivery eligibility are separate. A Global store can ship to a country address. A country/local store must match the actual shipping country and local address. The backend rechecks delivery eligibility when inserting the order, so a seller visibility change after the preview cannot silently bypass the rule.

Old orders are not migrated or recalculated. Existing stores with real addresses but no saved visibility are treated as country-scoped in read-only discovery; missing location is not treated as permission to sell globally. New addressed stores immediately receive country visibility if an internal caller does not supply a rule. No bulk production data rewrite was performed.

## Automated verification

- Initial full backend run: 216 of 219 suites passed. Three fixture suites failed because their old setup omitted store geography/visibility or used a buyer as the store owner.
- Updated only the relevant fixtures to declare their intended address, Global visibility and real seller role. Original money, idempotency and notification assertions were retained.
- Focused backend rerun: **6 suites, 123 tests passed**, including all three previously failing suites, real-controller catalog requests, all five onboarding modes, invalid-input rollback, internal AI name lookup scoping and a visibility change during checkout.
- Frontend: **249 tests passed**; complete production client build, documentation SSR, homepage SSR and prerender succeeded.
- Mobile: **95 suites, 1,113 tests passed** in the full run. A subsequent focused API-interceptor run passed **17 tests**, including seven new checks for exact list URLs and private-route exclusions.
- Dedicated cases cover Country/Global separation, unknown location, blocked/orphan sellers, legacy-address compatibility, same city name in different states, same town name in different cities, delayed detection, explicit Global persistence, failed storage, and matching web/mobile contracts.
- An additional full backend rerun with four workers was stopped after local MongoDB-memory-server instances exceeded their 10-second startup limit while mobile bundling was running. This interrupted run is **not** counted as a full pass. The completed serial full run and focused reruns above are the regression evidence; the startup timeouts were not production requests or production database errors.
- Serial recheck after reducing local load: **7 suites, 99 tests passed**, including seller-metrics isolation, bulk product transactions, subdomain purchase webhooks, notification outbox, financial notification outbox, seller analytics and founder promotion. This confirmed the observed parallel-run startup failures were not reproduced serially; no assertions were weakened and no application changes were made to suppress them.

## Release evidence

- Pushed `63231e1e671d470f77c1320d8e5ac7ca16d18de0` to `main` in both `ishanShahzad/hello-friend` and `Salman-here/Tortrose`.
- Vercel commit status: success. Deployment: `EmydztNDMiXcJafAMD429vaR7Tv3`.
- Railway active deployment: `d9e31fde-144c-4e42-a965-518d3a977d13`, status SUCCESS, same commit. Its successful status was checked rather than assuming a push means live.
- Mobile runtime remains `1.0.11`; no native dependency or app-icon change is part of this feature.
- Production mobile OTA published for Android and iOS: group `2f053e00-2ab1-4bce-afdb-0695e9599f39`. Android update `01a0bf7c-91a0-76fc-b40a-37e0bebfc76e`; iOS update `01a0bf7c-91a0-7f56-b22e-0d60f8973876`. Native bundles were built with the production EAS environment and publication completed successfully.
- An initial generic Expo export included Expo Web and failed on the existing native Stripe SDK import. The mobile production release correctly targeted Android/iOS and both native bundles succeeded; Expo Web compatibility was not changed or claimed by this task.

## Live browser observations

These observations are from `https://rozare.com`, not localhost:

1. First-visit popup showed Country selected and **Pakistan (PK)** suggested. The Filters-change explanation was visible. **PASS.**
2. Selecting Pakistan showed **14 products** in the current test catalog, with PKR still selected. **PASS.**
3. Switching to Global updated the catalog to **0 products** and Marketplace to **0 stores**, with an honest empty state. This was the observed live dataset at that point, not an assumption that every installation has Global stores. **PASS for filtering/empty-state behavior; positive Global listing verification follows below.**
4. Reloading and opening the known Pakistan Yoga Mat direct URL while Global was selected showed **Product unavailable**, with a Change shopping location action rather than exposing the country-only product. **PASS.**
5. Using that action to select Pakistan restored the same Yoga Mat, **Rs4,250**, Pulse Peak Gear store identity, and its related products. **PASS.**

6. Nova Nest's expired trial was visible in its seller dashboard. Save Visibility and all five scope cards were disabled. The subscription restriction was preserved; it was not bypassed for testing. **PASS.**
7. Signed into the existing, active Pulse Peak Gear test seller. Its initial setting was Country / Pakistan. Selected Global, observed the worldwide-shipping warning, and saved using the normal dashboard UI. Pakistan home then showed **9 products** (14 minus Pulse Peak's five), with Pulse products absent. **PASS.**
8. Selected Global as the shopper: home showed **exactly five** Pulse Peak products (Resistance Band Set, Jump Rope, Gym Duffel, Steel Shaker and Yoga Mat). Marketplace showed **one store**, Pulse Peak Gear. **PASS.**
9. Opened `https://pulse-peak-gear.rozare.com` in another tab. The store and its products appeared without another location welcome popup: the explicit Global preference was shared across the store subdomain. **PASS.**
10. Reloaded seller settings and verified the saved Global setting was retained. Restored Pulse Peak to its original Country / Pakistan using Save Visibility. Reloading the subdomain while the shopper remained Global showed the unavailable-area state. **PASS; original seller visibility restored.**

11. Signed into an existing test buyer while Global remained selected. Entered disposable, unsaved store setup details through the live onboarding UI. The physical-country field still suggested Pakistan; the listing-currency field recommended PKR. **PASS: shopping preference did not override store location/currency.**
12. Advanced to the new Visibility step: Country was selected, with Pakistan. State showed Punjab; City showed Lahore. Selecting Town without an area and pressing Next correctly stayed on the step with “Select a town or area for your store visibility.” **PASS.**
13. Selecting Global showed the worldwide-shipping notice and advanced to the existing WhatsApp verification page. No OTP was sent and this existing buyer was not promoted to seller during this preview. Full creation/transaction behavior is covered by the backend/controller tests and the earlier isolated activation, not claimed as a new live account activation. **PASS for live step flow.**
14. Checked the live shopping-location modal at a 390-pixel phone viewport. Its rendered width was 366 pixels and document width remained 390 pixels (no page-width overflow). Restored the browser's normal viewport afterward. **PASS.**
15. Restored the browser's shopping preference to Pakistan and observed all **14 products** again, including Yoga Mat. The Pulse Peak subdomain also became available again. Test seller visibility and shopper scope were left restored; no subscription or money values were changed. **PASS.**

Mobile delivery evidence follows below.

### Live AI discovery check

In a separate conversation on the live website, the buyer naturally asked for a yoga mat in the selected shopping area, explicitly requesting browsing only. With Pakistan selected, the AI search returned the Pulse Peak Yoga Mat. After switching to Global and asking for a fresh search rather than old results, the search returned no products. The existing country-only product was not returned as a new Global result. No cart or order mutation was requested or performed. **PASS for these two live discovery cases.**

### Android production-update observations

The installed Android app was version 1.0.11 / versionCode 13 on the RozareQA emulator. After downloading and restarting into the published OTA, the new first-visit popup appeared with Country selected, Pakistan (PK), Global, and the Filters-change explanation. This was the installed release app using the live backend, not a local development bundle. **PASS.**

Selecting Pakistan dismissed the popup. Home Filters opened correctly with the saved Pakistan choice and optional state/city fields. Selecting Global and applying Show products changed Home to **0 items / No products found**, consistent with the live dataset after Pulse Peak had been restored to Pakistan. **PASS.**

The Android Marketplace also showed **0 stores**, without stale country-only cards. After a full app stop/start, the Global preference was retained, the welcome popup did not repeat, and Home still showed the Global empty state. Reopening Filters showed Global selected. **PASS.**

The native country dropdown was opened and searched using the on-screen Android keyboard; Pakistan (PK) could be selected again. This also verified that switching out of Global requires a real country selection rather than silently guessing one.

After applying Pakistan, the native catalog repopulated. I observed Pulse Peak's Resistance Band Set (Rs1,890), Jump Rope (Rs1,590), Gym Duffel (Rs5,490) and Steel Shaker (Rs1,450) again. The browser and Android were left in Pakistan shopping, and the seller's original Pakistan visibility was restored. **PASS.**

## Earlier isolated UI checks (not live evidence)

Before the user's instruction to move all remaining UI checks to live, an isolated local database was used to verify the UI with deterministic country/state/city/town/Global fixtures. It showed only Global products in Global mode, only Pakistan-country stores for Pakistan, four matching stores after selecting Punjab/Lahore/Gulberg, and only the US store after switching countries. The small-screen dialog fit at 390 × 844. A local onboarding completed with Global visibility and PKR currency. No real messages, charges or production database writes occurred in those checks.

The local QA servers were stopped and the local walkthrough was not continued after the user requested live testing. The reproducible fixture script is development-only and requires explicit local QA environment variables.

## Verification limits

Automated regression tests do not prove every possible real-world device, network, shipping service or account state. This is a feature-focused visibility release, not a claim that every payment or notification flow was retested. Actual live/manual results, test-only fixture results and untested cases are deliberately kept separate.

Native live UI checks used Android as a guest. Authenticated mobile seller activation was covered by rendered-component/controller tests and live web onboarding, not a second signed-in native activation in this release. The iOS bundle was exported and published, but an iOS device was not available for a manual run. No card charges, bank transfers or new live orders were made for this feature check.
