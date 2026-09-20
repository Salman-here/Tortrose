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

## Automated verification

- Backend: **13 suites, 198 tests passed**. Includes actual controller queries against isolated MongoDB fixtures, mixed USD/PKR/EUR/GBP product prices, discounts, zero/boundary ranges, ascending/descending sorting, deterministic pagination, punctuation, case variants, Other brands, seller isolation, review sorting, legacy store types, verified/trust matches beyond the first unfiltered page, shopping visibility and subdomain authorization.
- Web: **257 tests passed**. Includes query parsing, selected-currency resets, single-brand array handling and source-contract regression checks. Source checks are not represented as browser interaction tests.
- Mobile: **97 suites, 1,135 tests passed**. New rendered-component tests exercise Marketplace skeleton/header, Apply versus dismiss, server parameters, request races, retry/load-more and price entry/validation.
- Web production build, documentation/home server rendering and prerender passed.
- Targeted web lint, changed-file parsing and `git diff --check` passed.
- Tests use isolated data; they did not create or change live products, orders or accounts.

## Release and live verification

Pending at this report's first commit. Deployment identifiers and observed live browser/installed Android results will be recorded after publication. Automated fixtures cover large-catalog pagination and deliberately differentiated sort values; the small live catalog cannot independently demonstrate every such case.

## Boundaries

- Existing controls were repaired, not expanded into a new filtering feature set. Storefront UI exposes search/category; its API also supports brand, range and sort. Web Home retains its existing minimum-price slider; the default full range is now explicitly labelled No price limit. Mobile retains its minimum/maximum inputs.
- No payment, withdrawal, order-money or historical exchange-rate calculation was modified.
- iOS publication and manual physical-device verification are separate facts and will be reported separately.
