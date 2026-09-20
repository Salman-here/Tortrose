# Global shopping plus the buyer's country

Date: 20 September 2026. This supersedes the Global-only discovery rule from the earlier visibility report.

## New rule

- Buyer detected in Pakistan + Global: Global stores/products **plus Pakistan-wide stores/products**.
- Buyer detected in the United States + Global: Global stores/products **plus US-wide stores/products**.
- Country-only selection: unchanged; the selected country's catalog and matching explicitly selected local areas.
- A manually browsed country is separate from the buyer's detected country. A Pakistan buyer who browses the US catalog and then selects Global receives Global + Pakistan, not Global + US.
- A genuine saved-address country is used if detection is unavailable. An empty legacy address, account currency, or failed geolocation's default US value is not treated as reliable location. If no country can be identified, Global remains usable with only Global stores.

Global adds country-wide visibility. It does not indiscriminately expose all city/town-only stores in that country; those local restrictions remain available through matching local-area filters in Country mode.

## What changed

1. Backend visibility normalization retains the buyer country in Global mode while discarding stale city/town filters. Catalog queries form a union of Global stores and matching country stores. Results remain deduplicated and active-seller restrictions remain enforced.
2. Product lists, filter values/counts, Marketplace, direct store/product pages, subdomains and AI discovery inherit that shared backend policy.
3. Web detection is independent from the manually selected browsing country. Old saved Global choices acquire the actual country without forcing another welcome popup. Manual Country choices are not overwritten by late detection.
4. Mobile applies the same rule, persists the country with Global, and updates subscribers when late detection completes. Late results cannot replace a newer Country selection. Returning Global shoppers refresh their country instead of retaining an old country's catalog indefinitely across app launches.
5. Web/mobile labels now say Global stores + stores in your country. The saved filter label can show **Global + Pakistan**, **Global + United States**, etc.
6. No seller visibility rules, store currencies, order history, balances, pricing calculations or delivery-address validation were redefined. A Global choice still cannot bypass a seller's actual delivery restriction.

## Automated checks

- Backend focused regression: **4 suites, 46 tests passed**. Covers Global + Pakistan, Global + US, unknown country, duplicates, product/filter parity, direct-link parity, invalid country pairs, blocked/unknown stores, AI discovery and existing order access.
- Web: **250 tests passed**, including web/mobile helper parity, actual-country precedence over a browsed country, Canada/Japan country support, shared-subdomain persistence, and existing financial/presentation checks.
- Mobile focused regression: **4 suites, 35 tests passed**, including old Global preferences, late detection, returning shoppers, manual-choice protection, Global + actual-country serialization and the rendered chooser.

Release and live observations will be appended after publication. Automated country cases are not represented as physical visits from those countries.
