# Important dependency security hardening

Work started 9 October 2026; verification completed 10 October 2026, Asia/Karachi.

The two high-severity dependency paths have repository-local protections: bounded brace-pattern processing and strict nested RSA signature metadata validation. Clean installations apply the protections automatically without upgrading Expo, React Native or Jest. Payment, currency, refund and seller-balance rules are unchanged; Safepay remains Sandbox. The unused CLI formatter warning is deferred.

Published package versions remain unchanged, so npm audit continues reporting upstream advisories. These changes mitigate the specific tested weaknesses; they do not claim an official upstream patched release or a warning-free dependency tree.

## Signature validation

Installed node-forge 1.4.0 validates the outer DigestInfo element count but permits extra elements inside AlgorithmIdentifier. The installation step tightens that nested structure to the algorithm OID and, when present, a primitive empty NULL parameter. Extra nested elements, unexpected parameter types and nonempty NULL parameters are rejected.

Valid SHA1, SHA256, SHA384, SHA512 and MD5 compatibility cases, optional SHA256 NULL omission, RSA PSS and legitimate Expo certificate signing continue to work. The tests use disposable local keys; no actual app signing key or merchant credential is read. The published baseline accepts the crafted extra-element cases, while the protected version rejects them.

Certificate/signature verification is not disabled. Only the malformed structure acceptance is changed. The current Android client does not bundle node-forge; this protection applies to installed Expo signing/development tools and future builds.

Reference: [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [RSA signature specification](https://www.rfc-editor.org/rfc/rfc8017).

## Pattern processing

Installed braces 3.0.3 has recursive compilation, expansion and stringification without nesting bounds. The parser now rejects actual brace syntax nesting above 64 levels before building the recursive tree. Escaped and quoted brace characters are not counted as nesting.

An iterative guard also checks direct AST inputs before every recursive walker. It rejects depth above 80, child cycles/repeated nodes and more than 262144 scheduled nodes. Normal parent/previous links are not traversed. Ordinary matching, ranges, escaping and options retain upstream behavior in the comparison corpus and real micromatch callers.

A resource-limited isolated Node process with a 256 KiB stack reproduces the original stack exhaustion using an 8003-character pattern, below the existing 10000-character limit. The protected parser returns a controlled SyntaxError, and a following legitimate pattern still succeeds. This is not a claim that the unmodified default stack on every operating system fails for the same input.

Reference: [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

## Installation and source integrity

Backend and MobileApp each contain an identical scripts/ensure-dependency-security.js and guard asset. Their package postinstall hooks apply the reviewed changes after npm installs the locked dependencies. MobileApp retains its existing URI-decoder compatibility step.

The installer checks exact package versions, reviewed source SHA256 checksums, the guard checksum, resolved package boundaries and patch anchors. It preflights all targets before writing, is idempotent and rejects unknown/tampered source. --check verifies existing protections without rewriting packages. Backend production installs omitting development tools correctly skip absent development-only braces; no node-forge dependency is introduced into the backend.

The protected sources retain upstream licenses. There is no advisory suppression, dependency downgrade, authentication weakening or new service. Future dependency changes must be reviewed rather than automatically receiving an unverified patch.

Run the checks with npm run test:dependency-security in Backend or MobileApp. The standalone regression scripts are deliberately separate from Jest's test discovery.

## Verification

| Boundary | Result |
| --- | --- |
| Clean mobile npm ci and automatic guards | Passed |
| Clean backend production npm ci with development packages omitted | Passed |
| Backend security checks |15 passed; 6 Forge-only checks skipped because Forge is not installed |
| Mobile security checks |21 passed |
| Mobile regressions |119 suites and 1321 tests passed |
| Website regressions |519 tests passed |
| Backend regressions |259 suites and 3936 tests passed in 700.707 seconds |
| Android production export |Passed; 2319 Metro modules processed |
| Android source map |2281 sources; 0 braces, 0 node-forge, 0 sprintf-js modules |

The checks cover valid signing, malformed nested signature structures, PSS compatibility, Expo certificate generation and verification, normal glob behavior, deep strings, direct ASTs, cycles, oversized ASTs, idempotence, altered source, altered assets, unreviewed versions, traversing lock paths and check-only operation.

## Release verification

The tested source commit is `23f485c7c8c39efc62880a22412f6090c340e94e`, pushed to both repository remotes. The release excludes the separate notification, email, WhatsApp and account drafts.

- Railway deployment `f0732493-e357-4f9c-b657-782914fedcf7` succeeded for Rozare's existing backend service. Its build log confirms the dependency postinstall step ran and verified the braces protection.
- The public backend `/health` endpoint returned `status: ok`, the exact tested commit and `mongoConnected: true`.
- Vercel deployment `dpl_5jNf7kzrbUw589pXzMSHeD4hGiZc` is ready in production with `rozare.com` among its aliases and the exact tested commit. A scoped runtime-log query returned no error/fatal groups in the preceding 30-minute verification window; this is not an all-time monitoring guarantee.
- The backend configuration readback confirms Safepay is still `sandbox`, enabled for web and mobile, with Stripe disabled. No live payment configuration was enabled.
- Railway CLI was restored to the user's EYEKONIT account after the read-only deployment checks.

These are source, installation, build, regression and release checks. No exploit traffic was sent to the hosted service, and no real payment or bank transfer was performed.

## Remaining warnings and scope

The sprintf-js moderate advisory remains. Backend reaches it through the legacy Mammoth/argparse CLI dependency chain; normal DOCX extraction does not load argparse or sprintf-js, as checked by the existing compatibility test. Testing/coverage dependencies also retain that CLI chain. It is not silently removed along with Word-document support.

The earlier installed-package audit has 0 website findings, 33 backend findings including tests, and 46 mobile findings including framework/build/test packages. Backend without development dependencies has 3 moderate findings. Those metadata counts can remain after source-level mitigation because npm recognizes published versions, not local guards.

The safeguards are scoped to the two specific advisories, not generalized security certification. No real payments, bank payouts, new app permissions, native SDK upgrade or new APK are part of this change. The customer app source and existing financial records are untouched. No new OTA is needed for guards used only during installation, testing and building.

The primary checkout's separate email/WhatsApp/account/template drafts are preserved and excluded from this release. Test installations and export artifacts are task-owned under F:/Rozare-Security-QA-20261009-qfM1ot; security tests run locally rather than attacking the hosted service.
