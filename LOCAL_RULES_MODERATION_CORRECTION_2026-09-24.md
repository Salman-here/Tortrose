# Catalog moderation correction — 24 September 2026

## User's decision

Remove the newly added AI catalog reviewer. Keep the pre-existing AI tag/description buttons, website/mobile/WhatsApp chat, and voice features unchanged.

## Removed

- The catalog OpenRouter/Gemini reviewer and its paid model calls.
- Automatic downloading/copying of catalog images for AI review, including conversion to static PNGs.
- The provider/image preflight script and moderation-only model/concurrency settings from the environment example.
- AI review/retry waits for new product/store saves.

Shared AI credentials and chat/voice settings were not removed or disabled. Existing tag/description helpers were not modified.

## Replacement behavior

- Product/store saves run deterministic local wording and URL checks. Clean content passes in the same save request; detected violations remain blocked with a seller-visible reason.
- Checks still cover product/store names and descriptions, category/brand, tags, options and policy text, plus basic image-URL validity. Local rules normalize common disguised profanity.
- Rules cannot interpret photographs or provide the former model's contextual/multilingual image/text understanding. There is **no image-content classification** and no guarantee that every disguised prohibited product will be caught.
- Text mentioning recognized prohibited goods is blocked literally; a phrase such as “guide” no longer exempts an otherwise prohibited phrase. This can require a seller to reword legitimate educational text.
- The new policy marker is `catalog-rules-2026-09-v2`. Previous valid approvals remain available; existing blocked records are not automatically released.
- A small compatibility worker finishes old pending submissions with local rules, even if their former AI retry was scheduled hours ahead. Revision/time checks prevent it overwriting a newer seller edit.
- Blocked-content notifications and correction flows remain intact. Independent account/subscription blocks are preserved.
- Existing image URLs/copies are retained so product photos and store logos do not break. This change creates no new moderation review copies and does not delete existing Cloudinary assets.
- No new frontend/mobile source changes or native build are required: existing clients already handle the returned approved/blocked states.

## Verification

- Targeted checks: **5 suites / 44 tests passed**.
- Covered immediate local approval, prohibited wording, protected ownership/metadata, correction/resubmission, seller notices, old pending-record recovery, concurrent edit protection, preserved prior approvals, subscription isolation, and zero review network calls/image replacement.
- Static search found no remaining runtime references to the deleted catalog reviewer/image-copy modules or their provider settings.
- Broader regressions: **9 suites / 234 tests passed**, including product currency, catalog/visibility filters, subdomain changes, natural chat routing and voice/attachment processing.
- The retained AI tag/description controllers, chat controller, voice attachment service, and all frontend/mobile application sources have no changes in this correction.
- Read-only live queue audit after deployment: **0 pending products and 0 pending stores**.
- Live API checks passed on the existing test seller using disposable product `6ab58a63d80c9795b3bc1eaa`, kept at zero stock:
  - Clean submission: approved in the save response, `pending: false`, public URL HTTP 200.
  - Price/currency remained USD 12.75; submitted image URL was unchanged.
  - Prohibited name edit: blocked with a name-specific reason; public URL HTTP 404.
  - Corrected name: immediately approved; image URL still unchanged.
  - The newly created disposable product was then permanently deleted via its exact ID. No existing products/orders or Cloudinary assets were deleted.

## Release

- Application commit: `059154162f740dbfb0f19569fc83330fbb183157` — replace AI catalog moderation with local rules.
- Pushed to both repositories' `main` branches.
- Railway deployment `b7277bf9-b406-4005-9256-82ea0d0032e5`: **SUCCESS**.
- Live `/health` reported the exact commit and `catalogModerationMode: local-rules`, with Mongo connected and the local recovery worker running.
- Vercel deployment [J42XdsX2QvsZvpiDi1YJCrrpE3M4](https://vercel.com/metaverse-project/rozare/J42XdsX2QvsZvpiDi1YJCrrpE3M4): **SUCCESS**, application frontend source unchanged.
- No mobile OTA or native build was made for this correction. Web/mobile/WhatsApp product writes all use the corrected shared backend.
