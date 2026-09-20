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

Pending publication and live verification. No store was verified or otherwise modified just to manufacture a positive live brand example; those cases use isolated fixtures.
