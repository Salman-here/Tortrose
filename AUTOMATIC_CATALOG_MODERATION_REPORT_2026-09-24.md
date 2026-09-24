# Automatic catalog moderation — 24 September 2026

## Requested behavior

Seller products and store profiles must be checked automatically. Clean content should publish without waiting for an administrator. Prohibited content must remain hidden, with an actionable reason and a seller notification.

## Before and after

| Flow | Before | Implemented behavior |
| --- | --- | --- |
| Create/edit product | Existing checks mainly rejected placeholder/test details | Name, description, category, brand, tags, colors, option labels/values, policy descriptions and all submitted images enter the publication gate |
| Clean submission | Could be published immediately | Saved as **Under review**, hidden from public catalog and new checkout; automatically publishes after all checks pass |
| Clearly prohibited wording | No complete catalog-wide safety gate | Obvious profanity/sexual goods are blocked immediately; contextual/multilingual text and images are reviewed by the configured model |
| Rejected submission | Limited placeholder explanation | Seller sees the affected field and a safe correction reason; correcting and saving starts another automatic review |
| Store profile | Content was not independently moderated | Store name, subdomain, description, logo/banner and policy descriptions are checked; pending/blocked stores are excluded from public catalog visibility |
| AI actions | Could report a saved listing as available | Web/mobile/WhatsApp backend tools save through the same gate and return mandatory pending/blocked disclosures |
| Generated tags | Could be saved outside the product update gate | Seller ownership is checked and generated tags are moderated before publication |
| Network/model/storage failure | No durable full-content review lifecycle | Content remains pending and hidden; retries use bounded backoff and recover after restart |
| Concurrent edit | An old result could be unsafe if attached to newer text/images | Revision, content fingerprint and worker lease checks prevent an old approval publishing a newer edit |

### Examples

1. A seller adds a cotton travel shirt with a suitable photo. It is saved privately, automatically checked, then becomes available. No admin approval is required.
2. A seller changes its description to include severe profanity. The product is saved but blocked; the seller sees a description-specific reason. It cannot be bought as a new order.
3. The seller replaces that wording with an ordinary description. The listing returns to Under review and automatically publishes if the complete listing passes.
4. A neutral medical product, such as a breast pump, is not rejected merely for containing the word “breast.” Industrial vibrating equipment is distinguished from sexual goods.
5. A store changes its description to advertise sex toys. Its public visibility is withheld while its subscription/account status remains unchanged. Fixing the content does not reactivate a separately subscription-blocked account.

## Image handling

- Every unique primary/gallery image, or store logo/banner, is included in the reviewed content fingerprint.
- Images are copied to separate, versioned Cloudinary review assets. The original uploads are untouched.
- The published URLs are the same image copies that passed review. A seller cannot replace an external URL's bytes after approval to change the published listing.
- Copies are static PNGs (first frame). Animated catalog images therefore become still images when approved; unchecked animation frames are not published.
- Missing/unreadable images do not produce an approval. Limits are 12 unique images and bounded text content per submission.
- Separate review copies are retained; automated asset deletion is not part of this change.

## Notifications and seller UI

- Web and mobile distinguish Under review from Blocked and display the saved reason.
- Pending status is refreshed while the seller is viewing the page/app. Obsolete responses cannot overwrite a newer edit; polling stops when no pending products remain or the screen unmounts.
- Approved/blocked decisions enqueue in-app, push, email and WhatsApp notices through the existing durable outbox. A delayed review uses in-app/push notices rather than repeated email/WhatsApp alerts.
- Actual external delivery still depends on the seller's current contact details, preferences, device registration and channel/provider availability. Enqueueing a notice is not proof of device delivery.
- Notification identity prevents duplicate outbox events. Delivery skips a notice if its decision has been superseded or its owner changed.
- Rejected product/store names are not repeated in notification titles; model-generated prose is replaced with server-owned reason text.
- A policy-rejected store name/subdomain can be corrected without being trapped by its previous rename cooldown. Normal cooldowns remain in place for other changes.

## Rollout scope

New submissions and edits are always checked. Existing, unchanged listings are preserved by default; a catalog-wide review was asked about separately and has not been enabled without that choice.

`CATALOG_REVIEW_EXISTING=true` is the separate opt-in rollout: it immediately hides unreviewed existing content and queues bounded automatic review. Default is false. Managed content from an obsolete moderation policy is withheld and rechecked. Independent account/subscription blocks are never lifted by content approval.

This work does not moderate buyer reviews/private conversations, alter order money, rewrite historical orders, or add a manual approval queue. Existing orders remain available to their authorized participants.

## Configuration

- `OPENROUTER_API_KEY`: existing server-side provider key.
- `CATALOG_MODERATION_MODEL`: defaults to `google/gemini-2.5-flash`; must support image input and strict JSON-schema responses.
- `CATALOG_MODERATION_CONCURRENCY`: defaults to 2; allowed range 1–8.
- Existing Cloudinary credentials are required for image-copy review.
- `/health` exposes `catalogModerationWorkerStarted` alongside the existing database/outbox status.

## Verification so far

- Real production-configured OpenRouter preflight: ordinary store approved, medical-product wording approved, sexual-goods euphemism blocked.
- Real Cloudinary + provider preflight: separate immutable copy of an existing public Travel Tech Pouch image was created and approved. No product/store/order records were changed by this preflight.
- New backend integration/service coverage: **35 tests passed**, covering real database transactions/controllers, malicious approval fields, owner isolation, public visibility, AI tools, generated tags, correction/resubmission, rename cooldown recovery, durable notices, safe registration notices, stale decisions, outages, concurrency and immutable image copies.
- Website: **266 tests passed**; production client build and both SSR builds/prerenders passed.
- Changed web files: ESLint reported **0 errors**, with 3 existing hook-dependency warnings in ChatBot/StoreSettings. Full-site lint still reports existing unrelated seller-payments unused variables; this is not a clean full-site lint claim.
- Mobile: **98 suites / 1,141 tests passed**, including new moderation polling lifecycle and seller-only notification routing tests.
- Full backend regression: **224 suites / 3,326 tests executed; 3,325 passed in the parallel run**. One existing currency-migration test counted retried bulk-write attempts as extra batches. Its committed checkpoint assertions passed; an isolated serial rerun passed both tests. No migration/payment code was changed to make this test pass. This is an explicit test-run caveat, not a claim that the original parallel run was entirely green.
- A session interruption stopped an earlier full run before a final result was written. Only the completed rerun above is counted.
- Final mobile subdomain/polling/routing rerun: **3 suites / 65 tests passed**.
- Release verification remains in progress at this report revision.

## Important limits

Automatic moderation is not infallible. The layered rules, image review and fail-closed handling reduce risk but cannot guarantee that every possible disguised violation will be detected. Ambiguous/provider-failed content remains hidden and retries; sellers can replace unclear details or unavailable images. Real email/WhatsApp/push delivery must be distinguished from automated outbox assertions.

## Provider references

- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter image input](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [Cloudinary upload API](https://cloudinary.com/documentation/image_upload_api_reference)
- [Cloudinary transformations](https://cloudinary.com/documentation/transformation_reference)

## Release record

Not released at this report revision. Commit/push, backend/frontend deployment and mobile update status will be recorded separately after verification.
