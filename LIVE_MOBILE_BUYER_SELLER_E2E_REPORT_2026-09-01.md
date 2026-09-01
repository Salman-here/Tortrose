# Rozare Live Mobile Buyer and Seller E2E Report

**Test window:** August 31 to September 1, 2026

**Environment:** Live Rozare production API and the Android mobile application

**Android runtime tested:** `1.0.10`

**Commerce-flow implementation commit:** `62677f9c0d38a2706b18add34fa652075be9f56e`

**Firebase/native-release commit:** `168e8ae08068da2293f43cb9aef880cc672a792b`

**Final commerce-flow OTA group:** `81a52ef1-05ac-45f5-8dab-0f33ba21a25c`

**Android Firebase OTA group:** `b81135a4-b6a6-488f-a70a-bbb095dabacc`

**Android Firebase update:** `01a05b11-eba5-7757-94bd-42bbe01e20c0`

**iOS update:** `01a05973-f163-7a77-8ba6-890ca9a35dd2`

**Android Firebase OTA dashboard:** `https://expo.dev/accounts/rozare/projects/rozare/updates/b81135a4-b6a6-488f-a70a-bbb095dabacc`

**Installed Android verification APK:** `e610b2cf-3305-4f90-bab3-307448a3ad23`

**Production Android App Bundle:** `de1132c0-23bf-472b-9c18-d9e68de8aae6`

**Production build dashboard:** `https://expo.dev/accounts/rozare/projects/rozare/builds/de1132c0-23bf-472b-9c18-d9e68de8aae6`

**AAB artifact:** `https://expo.dev/artifacts/eas/fckVJrTvPrDcVnVJqSx12jCjmgFV1zvI1SxDoG08-jI.aab`

**Overall result:** **PASS for the tested Android buyer, seller, catalog, COD, mixed-currency, multi-seller, order-status, review, return, email, WhatsApp test-inbox, in-app notification, and native Firebase push flows.** Android push was verified in the foreground, background, and with the application process terminated.

## 1. Executive conclusion

The live mobile application now follows the same buyer/seller money and order contracts already verified on the website.

- Buyers retain the currency and exact total used at checkout.
- A multi-seller purchase remains one buyer order but is visibly separated into seller shipments.
- Each seller sees only that seller's items, shipping, status, and frozen store-currency total.
- When buyer and seller currencies differ, the seller sees the native store amount plus the buyer-currency equivalent and conversion context.
- Seller analytics, dashboard revenue, payments, product prices, and order totals use the seller store currency.
- Cancelled, confirmed-but-not-delivered, and return-rejected orders do not incorrectly increase recognized revenue.
- Product options survive the complete buyer-to-seller flow.
- Email confirmation, WhatsApp confirmation/cancellation, seller WhatsApp updates, and buyer/seller in-app notifications were exercised against live orders.
- Firebase Cloud Messaging remote push was exercised against the live admin broadcaster while the Android app was foregrounded, backgrounded, and process-terminated.
- A delivered item was reviewed, and a delivered seller shipment went through a live return-request and seller-rejection flow.
- Cart and checkout now refresh authoritative catalog and money data instead of trusting an old device-side snapshot.
- The website `Frontend` was not modified during this mobile phase.

The final mobile code is pushed to `main`. The commerce-flow OTA was published for Android and iOS, and the Firebase token-registration fix was published to the new Android `1.0.10` runtime. A production-signed Android APK was installed and exercised interactively, and a store-distribution Android App Bundle was created from the same commit and Firebase credentials. The iOS bundle compiled and published, but a physical iOS device/simulator was not available on this Windows test host.

## 2. Dedicated live test identities

Only four new mobile-QA accounts were used. The administrator account was not used as a buyer.

| Identity | Role | WhatsApp test number | Store currency | Country |
|---|---|---:|---:|---|
| `rozare.mobile.buyer.83114@mailinator.com` | Buyer | `+1 202-555-0114` | PKR and USD checkout coverage | Pakistan |
| `rozare.mobile.seller.83111@mailinator.com` | Seller | `+1 202-555-0111` | PKR | Pakistan |
| `rozare.mobile.seller.83112@mailinator.com` | Seller | `+1 202-555-0112` | PKR | Pakistan |
| `rozare.mobile.seller.83113@mailinator.com` | Seller | `+1 202-555-0113` | USD | Pakistan |

All accounts use the common test credential requested by the owner. The credential is intentionally omitted from this committed report.

Account creation, sign-in, seller role access, store onboarding, currency selection, country/location, and repeat account switching were exercised in the live mobile UI. WhatsApp OTP and later messages were read through the dedicated admin test inbox for the allowlisted numbers.

## 3. Live seller stores and catalog

### 3.1 Mobile Cedar Lane

**Location:** Lahore, Punjab, Pakistan  
**Store currency:** PKR  
**Shipping:** Standard, `Rs300.00 PKR`, 3 days

| Product | Native price | Special coverage |
|---|---:|---|
| Bamboo Desk Organizer | `Rs1,690.00` | Required Material option: Walnut or Oak |
| Insulated Steel Bottle | `Rs1,250.00` | Mixed-seller PKR order |
| Woven Cushion Cover | `Rs850.00` | Mixed-seller USD order |
| Ceramic Mug Set | `Rs2,200.00` | Catalog and image coverage |
| Minimal Desk Lamp | `Rs2,450.00` | Catalog and image coverage |

### 3.2 Mobile Orbit Works

**Location:** Karachi, Sindh, Pakistan  
**Store currency:** PKR  
**Shipping:** Free, 5 days

| Product | Native price | Special coverage |
|---|---:|---|
| Resistance Band Set | `Rs4,250.00` | Used in PKR and USD mixed orders |
| Training Duffel | `Rs6,900.00` | Catalog and image coverage |
| Yoga Mat | `Rs3,700.00` | Catalog and image coverage |
| Steel Shaker | `Rs1,850.00` | Catalog and image coverage |
| Speed Jump Rope | `Rs1,450.00` | Catalog and image coverage |

### 3.3 Mobile Harbor Goods

**Location:** Lahore, Punjab, Pakistan  
**Store currency:** USD  
**Shipping:** Standard, `$5.00 USD`, 4 days  
**Returns:** 14-day store return policy

| Product | Native price | Special coverage |
|---|---:|---|
| Travel Tech Pouch | `$24.99` | PKR mixed order, delivery, return |
| Packing Cube Set | `$29.50` | Catalog and image coverage |
| Leather Wallet | `$34.00` | Catalog and image coverage |
| Folding Phone Stand | `$18.75` | USD mixed order and cancellation |
| Weekender Bag | `$69.00` | Catalog and image coverage |

All 15 live products were created with images and were visible in the mobile seller catalog. Store branding upload was exercised on Mobile Harbor Goods with logo/banner data. Mobile Cedar Lane and Mobile Orbit Works retained their default seller identity rather than receiving additional custom branding; this does not affect catalog or order behavior.

## 4. Live order matrix and exact calculations

### 4.1 Order 1: PKR seller, buyer checked out in USD

**Order:** `ORD-1788186109184`  
**Payment:** COD  
**Confirmation:** Buyer confirmed through email  
**Final seller status:** Delivered  
**Selected option:** Walnut

#### Buyer record

| Component | Frozen buyer amount |
|---|---:|
| Bamboo Desk Organizer | Included in allocation |
| Seller shipment total | **`$7.16 USD`** |

#### Cedar seller record

| Component | Frozen seller amount |
|---|---:|
| Product | `Rs1,690.00 PKR` |
| Shipping | `Rs300.00 PKR` |
| Frozen FX/cent adjustment | `-Rs0.81 PKR` |
| Seller shipment total | **`Rs1,989.19 PKR`** |
| Buyer checkout equivalent | `$7.16 USD` |

The seller mobile detail showed the store-native PKR breakdown, the USD buyer equivalent, and the information control explaining why a minor-unit FX adjustment can be positive or negative. The buyer retained `$7.16 USD`; the seller did not see this order rewritten into the buyer currency as the primary total.

The buyer and seller both retained the selected **Walnut** option. After delivery, the buyer submitted a 5-star review, and the review appeared on the product.

**Result: PASS.** Mixed-currency single-seller display, option retention, email confirmation, delivery, recognized revenue, and review flow were correct.

### 4.2 Order 2: three sellers, buyer checked out in PKR

**Order:** `ORD-1788191907114`  
**Payment:** COD  
**Confirmation:** Buyer confirmed through WhatsApp  
**Seller statuses tested:** Cedar Processing, Orbit Confirmed, Harbor Delivered

#### Buyer calculation

| Component | Frozen buyer amount |
|---|---:|
| Product subtotal | `Rs12,442.72 PKR` |
| Shipping | `Rs1,689.10 PKR` |
| **Order total** | **`Rs14,131.82 PKR`** |

#### Buyer seller-group allocations

| Seller | Items and shipping | Frozen buyer allocation |
|---|---|---:|
| Mobile Cedar Lane | Bottle `Rs1,250.00` + shipping `Rs300.00` | `Rs1,550.00 PKR` |
| Mobile Orbit Works | Resistance Band Set `Rs4,250.00` + free shipping | `Rs4,250.00 PKR` |
| Mobile Harbor Goods | Travel Tech Pouch and `$5.00` USD shipping converted at checkout | `Rs8,331.82 PKR` |
| **Total** | | **`Rs14,131.82 PKR`** |

Arithmetic checked:

- Product subtotal: `Rs1,250.00 + Rs4,250.00 + Rs6,942.72 = Rs12,442.72`.
- Shipping: `Rs300.00 + Rs0.00 + Rs1,389.10 = Rs1,689.10`.
- Order total: `Rs12,442.72 + Rs1,689.10 = Rs14,131.82`.
- Seller groups: `Rs1,550.00 + Rs4,250.00 + Rs8,331.82 = Rs14,131.82`.

#### Seller-native records

| Seller | Primary mobile total | Buyer equivalent |
|---|---:|---:|
| Mobile Cedar Lane | `Rs1,550.00 PKR` | Same currency |
| Mobile Orbit Works | `Rs4,250.00 PKR` | Same currency |
| Mobile Harbor Goods | `$24.99 + $5.00 = $29.99 USD` | `Rs8,331.82 PKR` |

The buyer mobile detail retained one public order ID while showing three separate seller cards. Each card showed only that seller's item, shipping, status, and allocation. Statuses changed independently without replacing the other seller statuses.

The Harbor dashboard later showed `$29.99` recognized revenue only after Harbor's shipment was delivered. Cedar Processing and Orbit Confirmed did not incorrectly count as delivered revenue.

**Result: PASS.** Three-seller splitting, paid/free shipping, mixed PKR/USD ownership, independent status tracking, and dashboard revenue were correct.

### 4.3 Order 3: three sellers, buyer checked out in USD and cancelled through WhatsApp

**Order:** `ORD-1788200121576`  
**Payment:** COD  
**Buyer action:** Cancelled through the WhatsApp test action  
**Final status:** Cancelled for all three seller shipments

#### Buyer calculation

| Component | Frozen buyer amount |
|---|---:|
| Woven Cushion Cover | `$3.06 USD` |
| Resistance Band Set | `$15.30 USD` |
| Folding Phone Stand | `$18.75 USD` |
| **Product subtotal** | **`$37.11 USD`** |
| Cedar shipping | `$1.08 USD` |
| Orbit shipping | `Free` |
| Harbor shipping | `$5.00 USD` |
| **Shipping total** | **`$6.08 USD`** |
| **Order total** | **`$43.19 USD`** |

#### Buyer seller-group allocations

| Seller | Frozen buyer allocation |
|---|---:|
| Mobile Cedar Lane | `$3.06 + $1.08 = $4.14 USD` |
| Mobile Orbit Works | `$15.30 USD` |
| Mobile Harbor Goods | `$18.75 + $5.00 = $23.75 USD` |
| **Total** | **`$43.19 USD`** |

Arithmetic checked:

- `$3.06 + $15.30 + $18.75 = $37.11`.
- `$1.08 + $0.00 + $5.00 = $6.08`.
- `$37.11 + $6.08 = $43.19`.
- `$4.14 + $15.30 + $23.75 = $43.19`.

#### Seller-native records

| Seller | Frozen seller calculation | Buyer equivalent |
|---|---:|---:|
| Mobile Cedar Lane | `Rs850.00 + Rs300.00 + Rs0.17 adjustment = Rs1,150.17 PKR` | `$4.14 USD` |
| Mobile Orbit Works | `Rs4,250.00 + Rs0.65 adjustment = Rs4,250.65 PKR` | `$15.30 USD` |
| Mobile Harbor Goods | `$18.75 + $5.00 = $23.75 USD` | `$23.75 USD` |

Cedar and Orbit displayed dynamic messages explaining that the buyer ordered in USD while their store prices were PKR. Harbor did not show a redundant conversion message because both store and checkout currencies were USD.

The WhatsApp order message contained the three products, `$43.19` total, delivery address, and Confirm/Cancel actions. Selecting Cancel changed the live mobile buyer order to Cancelled, recorded WhatsApp as the actor/channel, and cancelled each seller portion. Each seller received only that seller's cancellation values. COD remained uncollected and added no revenue.

**Result: PASS.** Multi-seller USD arithmetic, dynamic seller currency display, latest-order sorting, cancellation actor, COD unpaid state, buyer email, seller WhatsApp, and buyer/seller in-app notifications were correct.

## 5. Buyer mobile behavior verified

- The home currency selector switched between PKR and USD.
- Product and cart money used the selected buyer currency.
- Cart entries were refreshed from the live catalog before checkout.
- Checkout fetched an authoritative quote and updated shipping before placement.
- An old local cart snapshot is no longer accepted as the final commercial amount.
- A mixed order stayed one buyer order with one short public ID.
- The detail page separated products into seller groups with store, items, selected options, shipping, seller status, and seller allocation.
- One seller's status did not overwrite another seller's status.
- Tracking and order lists used the frozen order currency rather than the device's later-selected currency.
- The saved-address editor was usable at mobile height after its modal-height correction.
- Buyer notifications grouped by the public `ORD-...` ID rather than leaking an internal database ID.
- The buyer could confirm through email, confirm through WhatsApp, cancel through WhatsApp, submit a review after delivery, and request a return for an eligible delivered seller shipment.

## 6. Seller mobile behavior verified

- Each seller saw only owned products and seller-owned order lines.
- Product management displayed native store currency.
- Order management sorted newest orders first.
- Order cards used seller-native totals and dynamically labeled a different buyer checkout currency.
- Seller detail used store-native subtotal, shipping, FX/cent adjustment, and total.
- Different-currency orders displayed the buyer checkout equivalent and conversion explanation.
- Same-currency orders avoided unnecessary FX copy.
- The FX/cent adjustment row has an information icon explaining positive and negative minor-unit reconciliation.
- Seller dashboard, analytics, and payments use the store currency rather than whichever currency the buyer used.
- Dashboard data refreshes when focus returns and when the AI assistant closes, preventing stale counts after an order mutation.
- Cancelled orders count as order records but do not become revenue.
- Confirmed/processing orders do not become delivered revenue.
- Delivered COD revenue appears only after delivery.
- The seller return-status modal remained usable after the height correction.

### Live dashboard checkpoints after Order 3 cancellation

| Seller | Revenue | Orders | Products | Conversion | Status counts observed | Result |
|---|---:|---:|---:|---:|---|---|
| Mobile Cedar Lane | `Rs1,989.19 PKR` | 3 | 5 | 33% | Pending 0, Processing 1, Delivered 1 | Correct: delivered order only in revenue |
| Mobile Orbit Works | `Rs0.00 PKR` | 2 | 5 | 0% | Pending 0, Processing 0, Delivered 0 | Correct: confirmed/cancelled orders not revenue |
| Mobile Harbor Goods | `$29.99 USD` | 2 | 5 | 50% | Pending 0, Processing 0, Delivered 1 | Correct: one delivered, one cancelled |

## 7. Product option and review coverage

- Bamboo Desk Organizer required a Material selection before it could be added.
- The buyer selected **Walnut**.
- The cart, buyer order detail, and Cedar seller order detail retained **Walnut**.
- The buyer submitted a 5-star review after delivery.
- The product displayed the review.
- Duplicate option-value rendering was removed so one saved value is shown once.

**Result: PASS.** The selected option survived catalog, cart, checkout, buyer order, and seller fulfillment views. Review eligibility followed delivery.

## 8. Return coverage

**Return:** `RET-1788195962253-34D89F`  
**Order:** `ORD-1788191907114`  
**Seller shipment:** Mobile Harbor Goods  
**Reason:** Mobile QA return-flow test after delivery  
**Buyer item basis:** `Rs6,942.72 PKR`  
**Full seller-portion refund basis:** `Rs8,331.82 PKR`

The buyer requested a return from the delivered Harbor seller portion. Harbor saw the request in the seller mobile return panel and rejected it using the live seller action. Buyer and seller WhatsApp test-inbox messages reflected the request and rejection. No wallet refund was created because the request was rejected.

An automation input attempt concatenated two QA note strings in the seller note field; this was input automation behavior, not server-side note duplication.

**Result: PASS.** Eligibility, seller ownership, visible amounts, seller decision, and no-refund-on-rejection behavior were correct.

## 9. Notification coverage

### 9.1 Email

- Order 1 was confirmed through the buyer email action.
- Order 3 produced a buyer cancellation email for `ORD-1788200121576`.
- The cancellation email stated that the buyer cancelled the order, the action alone did not promise a refund, and the frozen total was `$43.19`.

**Result: PASS.** Email action and cancellation content matched the order state and frozen amount.

### 9.2 WhatsApp test inbox

- OTP and account messages were received for the allowlisted test numbers.
- Order 2 was confirmed through the WhatsApp action.
- Order 3 displayed Confirm and Cancel actions and was cancelled through Cancel.
- The buyer received the cancellation response.
- Cedar, Orbit, and Harbor received separate seller-specific order/cancellation values.
- Return request and return rejection messages were received.

**Result: PASS for the configured test-inbox transport.** This proves backend message generation, routing, button action handling, and saved message content for the allowlisted pool. It does not prove delivery to an external physical WhatsApp handset because these numbers intentionally route to the admin test inbox.

### 9.3 In-app notification inbox

- Buyer order notifications grouped under the short public order ID.
- Buyer confirmation and cancellation updates appeared under the same order group.
- Harbor seller notifications showed the new `$23.75` seller order and later buyer cancellation.
- Seller notifications used seller-only totals and did not expose other sellers' allocations.

**Result: PASS.** Buyer and seller in-app inboxes showed the correct identity, order ID, action, and scoped money.

### 9.4 Native Android remote push

The previous `Default FirebaseApp is not initialized` blocker was removed through a complete native Firebase release setup:

- Created Firebase project `rozare-production` (`Rozare Production`) and registered Android package `com.rozare.app`.
- Added the public Android Firebase client configuration through `google-services.json` and Expo's `android.googleServicesFile` setting.
- Uploaded a dedicated Firebase Admin service-account key to EAS as the Android FCM V1 credential. The downloaded local private-key copy was deleted after the upload and no private key is present in the repository.
- Added build validation that rejects a missing/mismatched Firebase project, package, or Android app ID.
- Increased the app to version `1.0.10`, Android version code `12`, and runtime `1.0.10`.
- Built and installed the production-signed APK `e610b2cf-3305-4f90-bab3-307448a3ad23` on the Android emulator.
- Verified installed package metadata: `versionName=1.0.10`, `versionCode=12`, and `targetSdk=36`.
- Verified native startup log: `FirebaseApp initialization successful`.

The first live launch exposed an independent registration defect: Expo SecureStore rejects `:` in key names. Push-token registration state keys were changed to use only supported characters, guarded by a regression test, and delivered through Android update group `b81135a4-b6a6-488f-a70a-bbb095dabacc`.

#### Foreground delivery

- Target: `rozare.mobile.seller.83113@mailinator.com` only.
- Admin result: `Sent to 1 recipient(s) — 1 push, 0 email, 0 WhatsApp.`
- Notification: `Rozare Android foreground push test`.
- Android displayed the exact title and body under the Rozare notification channel while the app was open.
- Android notification diagnostics recorded one enqueued and one posted Rozare notification.

#### Background delivery

- The signed-in Rozare app was placed in the background on Android Home.
- The live admin broadcaster again targeted only the Harbor seller and only the Mobile Push channel.
- Notification: `Rozare Android background push test`.
- Android displayed the exact title and body in the notification shade.
- Tapping the notification reopened the signed-in Rozare application successfully.

#### Terminated-process delivery

- Rozare was first launched normally, placed in the background, and its application process was terminated without placing the package into Android's special force-stopped state.
- Diagnostics confirmed no Rozare process and `stopped=false` before sending.
- Notification: `Rozare Android closed-app push test — process terminated`.
- The live admin broadcaster reported one push and no other delivery channels.
- Android displayed the exact title and body in the notification shade, and tapping it launched the signed-in application successfully.

An additional diagnostic used Android's explicit force-stop command. As designed by Android, a force-stopped package does not receive immediately; the queued notification was delivered after the user launched the app and cleared that special stopped state. This is different from an ordinary closed or process-terminated app and is not a Rozare delivery defect.

**Result: PASS.** Native Firebase initialization, Expo push-token registration, live backend targeting, Android foreground delivery, background delivery, terminated-process delivery, and notification-tap launch behavior all worked on the production-signed `1.0.10` build.

## 10. Defects found and fixed during mobile testing

| Defect | Why it mattered | Resolution | Verification |
|---|---|---|---|
| Buyer order screens could follow the current app currency | Old orders could appear to change currency | Centralized frozen order presentation | Live USD/PKR order details plus tests |
| Seller order list could show buyer-currency total as primary | Seller records did not match store accounting | Seller-native card totals with dynamic buyer equivalent | Cedar, Orbit, Harbor live lists |
| Buyer mixed order detail lacked complete seller grouping | Independent shipment tracking was unclear | Seller-group item, shipping, status, and allocation sections | Order 2 and Order 3 |
| Seller detail lacked clear cross-currency context | FX adjustments looked arbitrary | Dynamic buyer/store message, equivalent, rate context, and info icon | Order 1 and Order 3 |
| Seller orders were oldest first | New work appeared at the bottom | Newest-first sorting | Harbor cancelled order appeared first |
| Cart/checkout trusted stale device values too long | Seller price or FX changes could leave an old amount | Authoritative catalog refresh and checkout quote | Live Order 3 quote plus tests |
| Seller analytics/payments/product list could inherit buyer currency | Seller totals could be mislabeled | Store-currency source enforced across seller money screens | Three live dashboards and Harbor payments |
| Dashboard could remain stale after navigation/assistant | Counts could lag after order actions | Focus refresh and assistant-close refresh | Live dashboard checkpoints |
| Buyer notification groups could use internal IDs | Buyer saw the wrong identifier | Public order-ID normalization | Order 3 in-app group |
| Saved-address modal was too short | Address form controls were cramped or hidden | Modal increased to 90% height | Live address editor plus safety test |
| Seller return-action modal could collapse | Decision controls were not reliably usable | Modal increased to 88% height | Live Harbor rejection plus safety test |
| Media upload timeout was too short | Real image uploads could fail prematurely | Mobile upload timeout increased to 60 seconds | Product/store media tests and source guard |
| Product option values could duplicate | Buyer/seller selection became confusing | Option presentation deduplication | Walnut flow and unit coverage |
| Expo SDK patch was one version behind | Expo Doctor failed dependency health | Expo updated from `55.0.30` to `55.0.31` | Expo Doctor 20/20 |
| Android had no native Firebase project/configuration | FCM could not initialize or register a device token | Registered `com.rozare.app`, added Google Services config, and assigned an FCM V1 service account in EAS | Production-signed APK startup and three live push lifecycle tests |
| Push registration used unsupported SecureStore key characters | Firebase initialized, but device-token persistence failed at runtime | Replaced `:` with supported `.` separators and added a key-safety regression test | Clean startup logs, token registration, and live delivery |

## 11. Main implementation areas

### Buyer money and order presentation

- Added reusable frozen-order and seller-allocation presentation helpers.
- Updated order list, detail, and tracking screens to retain order currency.
- Added complete multi-seller buyer grouping and independent status display.

### Seller-native order and money presentation

- Updated order cards and seller detail to prioritize store currency.
- Added dynamic buyer checkout equivalents only when relevant.
- Aligned dashboard, analytics, payments, catalog, and store overview currency behavior.

### Checkout integrity

- Refreshes cart products from the backend.
- Requests authoritative checkout pricing before placement.
- Prevents a stale local currency/price snapshot from becoming the order contract.

### Notifications and returns

- Normalized public order IDs in buyer notification groups.
- Kept seller notifications scoped to seller-owned totals.
- Corrected return and address modal layouts for usable mobile actions.

### Native Android Firebase push

- Added the Android Google Services client configuration for `com.rozare.app`.
- Connected EAS to a dedicated FCM V1 service-account credential without committing the private key.
- Added strict build-time validation for Firebase project, application ID, and credential-facing public configuration.
- Corrected push-token SecureStore keys and added regression coverage for every token-registration storage key.
- Added a signed internal APK profile for device-level release verification before store submission.

### Mobile reliability

- Increased image upload timeout.
- Improved dashboard refresh behavior.
- Removed duplicate option values.
- Added regression tests for money presentation, notifications, seller catalog currency, modal heights, and upload timeout.

## 12. Automated validation

| Validation | Final result |
|---|---|
| Complete Jest suite | **86/86 suites passed; 1,057/1,057 tests passed** |
| Babel source parse | **259 JavaScript files parsed successfully** |
| Expo Doctor | **20/20 checks passed** |
| Mobile build configuration | **PASS** |
| `npm audit` during install | **0 vulnerabilities** |
| Mobile diff whitespace validation | **PASS** |
| Android production bundle | **PASS, 2,333 modules** |
| iOS production bundle | **PASS, 2,332 modules** |
| Production OTA publish | **PASS** |
| Firebase/Android build configuration validation | **PASS** |
| Production-signed Android APK build and install | **PASS — version 1.0.10 (12)** |
| Foreground, background, and terminated-process push | **PASS** |
| Production Android App Bundle | **PASS — version 1.0.10 (12), artifact downloaded and archive structure verified** |

The first final Jest run exposed one stale source-text assertion in `InformationParity.test.js`: it expected the old generic payment formatter even though the implementation now correctly supplies `targetCurrency: sellerCurrency`. The assertion was updated to enforce the new store-currency contract. The Firebase release phase then added configuration and SecureStore safety coverage. The complete final suite passed all 1,057 tests.

## 13. Production release history for this test phase

Incremental OTA groups were published while live issues were fixed and retested:

- `30fdace0-7f6e-47ce-b569-1163612d3c70`
- `b8c26251-371a-49aa-8b1a-5127e2852bd7`
- `04561d92-ad38-4efb-aa80-5222b86723de`
- `e4c8c7ec-f429-4e61-a391-415de489bd0e`
- `790c38da-6c25-4791-b487-bfbf08d0f5cd`
- `af0fc33a-4d21-44ae-b358-129a480a0661`
- `b8ac96e9-8a22-4a5f-80fa-d35ab59cd552`
- `e3b9a098-4f46-4895-a885-fb5ce0ae3627`
- `b96d4681-da12-4854-9b33-aabaafcc010b`

The authoritative final group superseding those incremental releases is:

- **`81a52ef1-05ac-45f5-8dab-0f33ba21a25c`** from code commit **`62677f9c0d38a2706b18add34fa652075be9f56e`**.

The Android native Firebase release then moved to runtime `1.0.10` and Android version code `12`:

- Firebase/token-registration Android OTA: **`b81135a4-b6a6-488f-a70a-bbb095dabacc`**, update **`01a05b11-eba5-7757-94bd-42bbe01e20c0`**.
- Installed production-signed verification APK: **`e610b2cf-3305-4f90-bab3-307448a3ad23`**.
- APK SHA-256: **`6B8B74190B03F84E383F56F1C75DEAC5834FB6C592E5BB12C1C1E29949D47967`**.
- Store-distribution production AAB: **`de1132c0-23bf-472b-9c18-d9e68de8aae6`**.
- AAB size: **`89,146,792` bytes**; SHA-256: **`2BB2BE2C205BB046848D18F651B186F3EAF356DDCEEC8C63A6432EAF8EEAA79E`**.
- All three artifacts use code commit **`168e8ae08068da2293f43cb9aef880cc672a792b`** and the production channel.

The EAS metadata includes a dirty-worktree marker because an older website report and untracked `test-assets/` existed outside `MobileApp`. `MobileApp` itself was committed before the final publish, and those unrelated files were not included in the mobile bundle or code commit.

## 14. Scope exclusions and honest limitations

- All live orders used COD. Stripe and Rozare Wallet payment execution were intentionally not used in this test phase.
- No real products were shipped and no real cash was collected.
- WhatsApp was verified through the approved allowlisted test-number inbox, not an external handset.
- Native Android push was verified on a Google Play-enabled Android emulator with a production-signed build. Vendor-specific physical-device battery restrictions were not part of this test.
- iOS compiled and received the production OTA, but interactive iOS device testing was not possible from the Windows host.
- Branding upload was tested on Harbor; Cedar and Orbit kept default branding.
- The website `Frontend` was deliberately left unchanged.

## 15. Final verdict

| Area | Verdict |
|---|---|
| New mobile accounts and seller onboarding | PASS |
| Three stores and 15 imaged products | PASS |
| PKR and USD store currencies | PASS |
| Paid and free seller shipping | PASS |
| Required product option | PASS |
| Single-seller mixed-currency COD | PASS |
| Three-seller PKR COD | PASS |
| Three-seller USD COD | PASS |
| Buyer seller-group order detail | PASS |
| Seller-owned order isolation | PASS |
| Frozen buyer and seller money | PASS |
| Seller dashboard and revenue recognition | PASS |
| Email confirmation/cancellation | PASS |
| WhatsApp test-inbox confirmation/cancellation | PASS |
| Buyer and seller in-app inbox | PASS |
| Review after delivery | PASS |
| Return request and seller rejection | PASS |
| Android/iOS OTA bundle and publish | PASS |
| Android native remote push | **PASS — foreground, background, and terminated process** |
| Stripe/Wallet execution | NOT TESTED BY SCOPE |
| Interactive iOS device flows | NOT RUN ON WINDOWS HOST |

The tested Android mobile commerce and notification flows are release-ready on version `1.0.10` (build `12`). Buyer/seller order behavior, currency calculations, dashboards, email, WhatsApp test-inbox, in-app notifications, Firebase remote push, notification tapping, signed APK installation, and the production store build all passed. The stated Stripe/Wallet and interactive iOS exclusions remain outside this report's verified scope.
