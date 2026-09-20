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
- Full mobile regression: **95 suites, 1,123 tests passed**.
- Website production client build, documentation/home SSR and prerender completed successfully. Deployment builds also validate the published revision.

## Release

- Application commit: `07592a37` (`fix: include buyer home country in global shopping`), pushed to both GitHub repositories.
- Vercel deployment `8HVda2BMeg2vZXZnVMuYLqPyp6a1` succeeded for the new code.
- Railway deployment `52db9e76-8d26-431b-a5ee-6506d806b61a` was confirmed SUCCESS with full commit `07592a37b98f0d43f8e5560adc06da82435afe06`.
- Android/iOS production OTA published successfully for runtime `1.0.11`: group `fd0a76a3-7dea-4e52-9b2f-95d8a5deecf4`; Android update `01a0bfbf-9ff1-7abb-874a-ecadbc2798a3`; iOS update `01a0bfbf-9ff1-72e0-88ec-05313eb79f23`.

## Live browser checks

1. Opened the deployed selector and saw the revised Global description: “Global stores + stores in your country.”
2. Deliberately selected United States in Country mode while the real detected country was Pakistan. The live US-only test catalog showed 0 products.
3. Switched to Global. The dialog said “Includes Global stores and stores serving Pakistan,” not United States.
4. Saved it: the filter displayed **Global + Pakistan** and the live catalog showed **14 products**, including Yoga Mat, Minimalist Wallet and Rexine Top Handle Bag for Girls. Pakistan products were no longer hidden merely because Global was selected. **PASS.**
5. The live Marketplace displayed **Global + Pakistan** and **4 stores**: Juniper Trails 90901, FaishonAura, Atlas Aura Goods and Pulse Peak Gear. **PASS.**
6. Reloaded Marketplace: Global + Pakistan and the four stores remained. Opened the previously country-only Yoga Mat direct link while Global was selected: the product and Pulse Peak store identity were visible. **PASS.**

Automated country cases are not represented as physical visits from those countries. Mobile publication and installed-app observations are recorded below after completion.

## Country-lookup resilience follow-up

The installed Android app initially loaded the new Global description but did not resolve its country on the first lookup. Reapplying Global retried the lookup and the local catalog returned. This was a transient lookup failure, not treated as a successful first-start migration.

Added one automatic retry on both clients and a 12-second client timeout per attempt (the backend's upstream timeout is eight seconds). The Global catalog remains usable during the background lookup. Two unsuccessful attempts stop without inventing a country. Manual Country selections and cleared sessions still reject late results.

Follow-up validation: **4 mobile suites, 27 tests passed**, including simulated network failure, unsuccessful geolocation response followed by success, and permanent failure bounded to two attempts. The 14 web location/persistence checks also passed.
