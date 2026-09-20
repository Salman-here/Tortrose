# Price controls and verified brand filters

Date: 21 September 2026. Follow-up to the catalog-filter release.

## Changes

- Web and mobile minimum/maximum price inputs each have plus/minus buttons. Each click changes the chosen bound by one unit of the displayed currency. Decimal input is supported; the buttons clamp at zero and at the opposite bound.
- A blank maximum means no upper limit; maximum 0 means free products only. Web no longer treats the slider's visual upper limit as an implicit price-filter cap. The web minimum slider remains available alongside the new inputs.
- Invalid/inverted ranges show a validation message. Web applies valid edits after a short typing debounce and keeps the last valid results during invalid editing. Mobile keeps its existing Apply/Show products workflow. Reset and currency changes clear the range, including unfinished drafts.
- Brand choices now come from active, visible **Brand-type profiles with `verification.isVerified === true`** and at least one public product. Verification is the same field used by the store badge. Ordinary Store-type profiles and free-form product brand text are not treated as verified brand businesses.
- Selections use the verified profile ID (`brandStores` query), not a typed brand name. Products from an unverified seller copying the same name cannot join that verified-brand result. Revocation, blocking and visibility are checked again when loading products. Clearing the brand filter leaves all otherwise eligible products browsable.
- Removed the Other brands option from both buyer filter UIs. Empty eligible catalogs say No verified brands available. Existing legacy API `brands` queries remain available for unrelated callers, but the updated buyer UIs do not use them. Legacy filter metadata returns no arbitrary brand labels, so older clients cannot misrepresent them as verified.
- While inspecting mobile filters, corrected the old ascending-direction workaround for Highest rated, Newest first, Most popular and Best selling. The backend now honors direction normally, so mobile must send descending. This was a leftover mismatch from the previous filter release, not a new financial or catalog-visibility policy.

## Verification

- Backend catalog and shopping-location regression: **2 suites / 27 tests passed**, including verified versus ordinary stores, a verified brand with only one product, empty/hidden brands, spoofed names, invalid IDs, revocation, price/category intersection, and unchanged unfiltered discovery.
- Web: **262 tests passed**; targeted lint passed. Includes min-only/max-only/zero/decimal ranges, bounded step buttons, URL behavior, profile-ID binding and native sort-direction contracts.
- Mobile rendered price component: **4 tests passed**, including actual plus/minus interactions, disabled limits and clearing maximum back to unbounded.
- Full mobile suite: **97 suites / 1,136 tests passed**. Web production build, documentation/home SSR and prerender passed. Final helper refinements also passed the 12 focused web contract tests and targeted lint.

## Release and live checks

- Application commit `dea0c500`, pushed to both GitHub repositories. Vercel deployment `EsnL1B1N27fY6MmpPjdRxnQNBf75` succeeded. Railway deployment `34fcf0d6-2cc4-4067-94c3-761e694c638c` reported SUCCESS with matching full commit `dea0c50043ccb0abac7667acc49a2757e3eed57d`.
- Android/iOS production OTA published successfully for runtime `1.0.11`: group `0e015022-cfa3-4aff-81fe-096c3ba97a73`, Android `01a0c124-5bfb-7437-955d-102be3e4bc13`, iOS `01a0c124-5bfb-7331-ba11-52ce1d1a68d8`, based on `dea0c500`. No new native build was required.
- Live web: minimum $24 and maximum $25 returned only Travel Tech Pouch ($24.99). Minimum + changed the range to $25–$25 and returned zero; its + and maximum's − buttons were disabled at the shared bound. Minimum − restored the matching product. Maximum − produced $24–$24 with zero matches, and maximum + restored $24–$25 and the product. **PASS.**
- Typed maximum 23 while minimum was 24: validation was visible and the last valid product result was retained. Reset cleared the invalid draft and restored all 10 products. Maximum 0 correctly returned zero free-product matches; clearing maximum restored No price limit and 10 products. Exact $24.99–$24.99 matched Travel Tech Pouch. **PASS.**
- Switched to PKR, then typed grouped inputs `1,000` and `2,000`: exactly Resistance Band Set Rs1,890, Jump Rope Rs1,590 and Steel Shaker Rs1,450 remained. Native product and converted display amounts were not relabelled as a different currency. **PASS.**
- Phone-width web at 390×844: both inputs and four buttons fit the drawer; buttons changed the range to $1–$26, producing six matching items. Reset and close worked. Restored the normal viewport, USD currency, Global + Pakistan and unfiltered catalog. **PASS.**
- The current live catalog has no eligible verified Brand-type profiles, so the UI displayed No verified brands available instead of listing Atlas/Pulse's unverified product labels. Their products remained available in the unfiltered catalog. Positive verified-profile, single-product, spoofed-name and revoked-verification cases passed isolated backend tests. No store was verified or otherwise modified just to manufacture a positive live example.
- Installed Android release app: after its OTA restart, visually confirmed Minimum/Maximum PKR inputs, four plus/minus buttons, No limit for an empty maximum, and the verified-brand empty state. Minimum + changed 0 to 1; minimum − restored 0. Maximum + changed No limit to 1; maximum − changed 1 to 0. At 0–0 the crossing controls were disabled; Show products returned 0 items with the 0–0 PKR chip. Clear All removed the test filter. **PASS.** Android was checked through the computer-use skill on the RozareQA emulator; no physical handset or iOS device was used.

## Boundaries

No order, payment, balance, shipping or stored product-price calculation was changed. The verified-brand filter is a discovery filter, not a restriction on shopping from unverified sellers. iOS native export/publication is separate from physical-device verification; no iPhone/iPad was manually used.
