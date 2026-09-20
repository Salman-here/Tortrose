# Catalog filters and mobile Marketplace loading

Date: 21 September 2026.

## Scope

Audit and repair the existing public Home, Marketplace and seller-storefront filters on the website and mobile app. Add store-shaped skeletons to mobile Marketplace. This is not a retest or rewrite of checkout, seller accounting, subscriptions or payments.

The current shopping rule remains unchanged: Global includes Global stores plus country-wide stores in the buyer's detected country. Country/local restrictions, blocked-store exclusion and tenant isolation remain enforced by the backend.

## Problems and changes

1. **Product sorting:** newest, rating, popularity and sales could run in the opposite direction to the selected descending order. Shared comparators now respect direction and use deterministic tie-breaks. Ratings are ordered by rating first, then review count.
2. **Price comparisons:** storefront filtering used a legacy USD-only comparison. Modern clients now send their display currency; storefront price filters/sorts compare effective discounted product prices in that currency. Omitted currency still means USD for older callers. No product, order or balance values are rewritten.
3. **Malformed ranges:** negative, non-numeric and reversed ranges now fail validation instead of silently producing misleading results. Zero is valid, including a free-only 0–0 range. Mobile minimum-only ranges remain supported.
4. **Mobile price entry:** decimal input such as `1.` remains editable; maximum `0` is not mistaken for Any. Invalid ranges show an explanation and cannot be applied. Switching currency clears the old numeric range rather than treating PKR thresholds as USD thresholds. Quick-preset labels describe their inclusive boundaries.
5. **Categories and brands:** matching is case-insensitive but literal, so punctuation cannot act as a regular expression. Case variants no longer produce duplicate filter labels or escape the popular-brand exclusion. Web brand checkbox values always remain arrays, including when only one brand or Other brands is available.
6. **Search:** a one-letter product search no longer matches everything through an empty-token shortcut. Storefront searches safely handle punctuation such as `[` and cover product name, description, brand, category and tags. Storefront search is debounced.
7. **Pagination and racing requests:** filters reset to page 1 before fetching; older responses cannot overwrite newer selections. Storefront changes clear the previous store's filters. Request cleanup also prevents stale responses after leaving a screen. Mobile load-more requests cannot append an old filter's results to a new list.
8. **Marketplace refinements:** mobile Verified Stores Only and minimum trust count previously filtered only the returned page. They now filter on the server before pagination, with matching totals/counts. Legacy stores without a seller-type value count consistently as Stores. Sort ties are stable.
9. **Filter editing:** mobile Marketplace options are drafts until Apply; closing the sheet discards drafts. Reset resets drafts. The web Home filter panel no longer remounts on every keystroke, preserving input focus. Reset All Filters resets search, categories, brands, price and sort.
10. **Error states:** loading errors are distinct from genuine no-match/empty results, with retry controls. A filtered storefront with no matches no longer claims the seller has never added products.
11. **Mobile Marketplace loading:** the header/search/filter controls remain mounted. The results area uses a two-column store-card skeleton with banner, logo, name and metadata placeholders; pagination uses a smaller skeleton. Cards appear immediately when data arrives instead of starting invisible with progressively longer entrance delays. An odd last card retains its column width.
12. **Subdomain consistency:** subdomain product requests use the same storefront filtering, visibility, currency and pagination implementation while preserving the middleware-resolved store identity.
13. **Live-discovered empty-result trap:** a storefront search returning zero products hid the web search/category controls. The controls now remain mounted on both clients during loading and empty results. Store header product totals also remain the full public catalog count rather than shrinking to the filtered page size; the results count still reflects the current filters.
14. **Phone-width web drawer:** the fixed navigation bar overlapped the filter search box when the test-phase notice displaced the header. The drawer now renders through a body portal above navigation/chat, fits the available viewport and has a labelled close button.

## Automated verification

- Backend: **13 suites, 198 tests passed**. Includes actual controller queries against isolated MongoDB fixtures, mixed USD/PKR/EUR/GBP product prices, discounts, zero/boundary ranges, ascending/descending sorting, deterministic pagination, punctuation, case variants, Other brands, seller isolation, review sorting, legacy store types, verified/trust matches beyond the first unfiltered page, shopping visibility and subdomain authorization.
- Web: **257 tests passed** in the initial full run. After the storefront follow-up, 249 `.test.js` checks plus 9 SEO `.test.mjs` checks passed; the subsequent drawer regression test passed with all 9 catalog contract tests. Includes query parsing, selected-currency resets, single-brand array handling and source-contract regression checks. Source checks are not represented as browser interaction tests.
- Mobile: **97 suites, 1,135 tests passed**. New rendered-component tests exercise Marketplace skeleton/header, Apply versus dismiss, server parameters, request races, retry/load-more and price entry/validation.
- Web production build, documentation/home server rendering and prerender passed.
- Targeted web lint, changed-file parsing and `git diff --check` passed.
- Tests use isolated data; they did not create or change live products, orders or accounts.

## Release and live verification

- `32cb2ea5`: principal catalog/filter/skeleton fixes, pushed to both repositories. Vercel `CxwtM8FWYRSnjhfeScMtbRn2mnB7` and Railway `00a0078c-3549-4e9b-98da-3c2c9178ce10` succeeded; Railway reported the matching full commit.
- `bcc9aee8`: live-discovered storefront empty-result recovery and stable catalog totals, pushed to both repositories. Vercel `CMcnf7TcPv1MWe8jk75RXgcthLia` and Railway `c30d9ec5-5f9d-4d0d-a07d-0422320c667e` succeeded for this revision. All 17 backend catalog tests passed after this follow-up, including a new empty-result/count/tenant test; targeted web lint and JSX parsing passed.
- Initial Android/iOS production OTA: group `ccb0c86e-fd51-48ca-81ef-3fc9ddb05b05`, runtime `1.0.11`, based on `32cb2ea5`. A newer storefront follow-up is recorded below after publication.

Automated fixtures cover large-catalog pagination and deliberately differentiated sort values; the small live catalog cannot independently demonstrate every such case.

## Live browser observations

1. **Home baseline:** Global + Pakistan showed 10 products. Price Low to High in USD gave Steel Shaker $5.20, Jump Rope $5.71, Resistance Band Set $6.78, Yoga Mat $15.25, Gym Duffel $19.70, Travel Tech Pouch $24.99, Portable Stand $27.99, Minimalist Wallet $29.50, Packing Cubes $42, Weekender Bag $69. High to Low reversed that order. The PKR-native products were correctly interleaved with USD-native products. **PASS.** These are observation-time display rates, not frozen order quotations.
2. **Category plus brand:** Electronics returned Portable Stand and Travel Tech Pouch. Adding Pulse Peak returned zero products. Reset restored all 10 and Recommended sorting; selecting only Pulse Peak returned its five fitness products. **PASS.** Other brands was not present in this small live catalog; its single-option/case-variant behavior is covered by automated fixtures.
3. **Other Home sorting:** Highest Rated, Newest First, Most Popular and Best Selling all loaded successfully. Newest First started with Weekender Bag; Best Selling started with Minimalist Wallet. The live ratings were tied, so differentiated rating/popularity correctness is established by the controller fixtures, not invented from tied live values. **PASS within this distinction.**
4. **Search and price:** searching `wallet` retained the input and returned Minimalist Wallet. A USD20 minimum returned exactly the five USD-priced Atlas products; the more expensive displayed list prices did not substitute for discounted selling prices. Changing to PKR cleared the numeric USD threshold to No price limit and restored all 10. **PASS.**
5. **Marketplace:** All/Stores showed three current stores and Brands showed zero. Search `atlas` showed only Atlas Aura Goods with matching All/Stores counts of 1. A nonexistent store search showed zero and a no-match explanation; clearing with the keyboard restored three. Name A–Z ordered Atlas, Juniper, Pulse; Most Viewed ordered Pulse (4), Juniper (3), Atlas (1 at that observation). Highest Rated loaded the tied unrated stores. **PASS.**
6. **Seller storefront:** Atlas's Electronics filter returned two items; adding search `pouch` returned Travel Tech Pouch. Searching `[` returned zero without a backend error. The first live attempt exposed disappearing controls; after `bcc9aee8`, the same search retained the search field and categories, displayed 0 items, and kept the store header at 5 Products. Clearing restored all five without a reload. **FIXED AND RETESTED PASS.**
7. **Location regression:** selecting United States in Country mode showed zero stores. Switching back to Global explicitly said it includes Pakistan, then restored three stores. A manually browsed US country was not mistaken for the buyer's detected home country. **PASS.**
8. **Phone-width web:** tested the filter drawer at 390×844. The first visual check exposed navigation overlapping search; the corrective release and retest are recorded below.

The browser's empty-string `fill` helper did not clear one input on its first attempt; keyboard Select All/Backspace did. This was distinguished from the genuine storefront bug by reading the actual input value. No live accounts, products, orders or visibility settings were created/changed; ordinary public page visits can increment store-view counters.

## Boundaries

- Existing controls were repaired, not expanded into a new filtering feature set. Storefront UI exposes search/category; its API also supports brand, range and sort. Web Home retains its existing minimum-price slider; the default full range is now explicitly labelled No price limit. Mobile retains its minimum/maximum inputs.
- No payment, withdrawal, order-money or historical exchange-rate calculation was modified.
- iOS publication and manual physical-device verification are separate facts and will be reported separately.
