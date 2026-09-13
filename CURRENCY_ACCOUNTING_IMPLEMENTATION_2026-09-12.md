# Store currency, historical reporting and native seller balances

Implementation started: September 12, 2026. Live verification completed: September 13, 2026.

**Release status: implemented, pushed to both repositories, and deployed.** Website/backend verification and the scoped Android UI check passed. The Android/iOS production OTA is published. The historical-data exclusions and unverified real-payment/device scenarios in section 11 remain explicit; this report is not a claim that a real bank payout or card charge occurred.

## 1. Rules implemented

### Store currency changes

A seller reviews and confirms one conversion quote. The confirmed operation converts and saves:

- Product regular and sale prices.
- Seller shipping fees.
- Fixed-value store coupon discounts.
- Coupon minimum-spend amounts and maximum-discount caps.

Percentages, product stock, delivery days, shipping activation, coupon redemption counts, usage limits and existing dates are preserved.

The preview includes affected counts, up to three product examples, shipping/coupon summaries, the rates and expiry. A seller with 300 products does not have to review 300 rows. The quote expires after ten minutes; changed relevant prices or terms require a fresh quote. The conversion is transactional: it must not leave half a catalog or shipping/coupons in the old currency.

The existing 60-day restriction is enforced server-side. A failed or cancelled preview is not a completed currency change. Once confirmed saving begins, the website prevents cancelling the already-running save.

### Orders and historical reporting

- Every new order saves a complete trusted USD/PKR/EUR/GBP rate snapshot, including entirely PKR or entirely USD orders.
- A product already in the buyer's checkout currency is not converted away and back. Only different-currency components need conversion.
- A complete rate table is reporting evidence, not a requirement to turn every amount into a USD balance.
- New-order insertion rechecks current product/shipping terms under the shared store lock. Stale checkout terms use the existing explicit reprice/reconfirmation flow.
- Existing orders keep their original amounts, currencies, options and money snapshots. Later payment, delivery or callback processing must not reprice them.
- Historical analytics, revenue summaries and related reports use each order's own frozen rates when presenting that history in the current store currency. They do not use today's FX.
- If a required historical amount or trusted rate cannot be established, it is reported as unavailable/excluded instead of inventing a conversion.
- The existing exact-cent buyer/seller reconciliation policy is preserved. This release does not introduce a new upward-rounding fee or reserve.

### Online balances and withdrawals

Seller funds are recorded in separate earned-currency balances: USD, PKR, EUR and GBP. A store currency change does not convert money already earned.

Example: a seller with PKR 20,000 earned online changes the store to USD. The PKR 20,000 remains a PKR balance. A qualifying new USD 30 earning adds to the USD balance, not the PKR balance. A pre-change PKR order that becomes eligible later still adds to PKR.

- Paid and delivered Stripe/Wallet earnings are eligible for withdrawal; pending amounts are separate.
- COD contributes to the appropriate sales reports but does not add platform-held withdrawable online funds.
- Refunds/reversals are tied to the original earned currency. A PKR deficit does not silently consume a USD balance.
- Admin credits, reservations, reversals, holds and deficits remain distinguishable from sales.
- The selected balance currency, request currency and frozen bank destination currency must match.
- A withdrawal reserves its amount once, including concurrent requests/retries. The existing authentication and encrypted destination binding are preserved.
- Admin approval does not mean money was sent. Payment completion needs transfer evidence; uncertain outcomes remain reserved/manual-reviewable.
- No seller self-service earned-balance conversion was added.

| Withdrawal currency | Fixed minimum |
| --- | ---: |
| USD | USD 5.00 |
| PKR | PKR 2,000.00 |
| EUR | EUR 5.00 |
| GBP | GBP 5.00 |

USD 5 and PKR 2,000 follow the supplied amounts. EUR 5 and GBP 5 are the chosen fixed minimums for the other currently supported currencies; these limits are not recalculated from daily FX.

Tax and payment-processing fee policy were left unchanged, as requested.

## 2. Implementation coverage

### Backend and shared contracts

- Added the shared shipping/coupon conversion planner, validation, fingerprints and atomic writes.
- Website settings, mobile settings and AI use the same persisted, owner-bound preview/confirmation contract.
- Added the first-insert order pricing guard. Existing order callbacks are not treated as new purchases.
- Web and AI checkout now persist complete rates and explicit seller-native money. The AI path no longer depends only on later reconstruction.
- Updated seller analytics, store/subdomain revenue, coupon reporting and exports to use historical order snapshots.
- Added native seller accounting and version-2 same-currency withdrawal requests, with exact minor-unit validation and static minimums.
- Updated seller-funded return/refund accounting. Separate provider refund and dispute exposure are not incorrectly collapsed into one capped amount.
- Preserved versioned legacy withdrawal authorization, with a payout safety hold when an old reservation cannot be reliably assigned to native money.
- Seller order responses now scope coupon and settlement metadata to the requesting seller, alongside their existing item/allocation isolation.

### Website, mobile, admin and AI

- Website and mobile Payments select a native balance independently of the store's reporting currency.
- Available amount, input currency, minimum, request body and retry identity follow that selected balance.
- A summary belonging to another seller or an invalid money contract is rejected rather than displayed.
- Admin payments have a native-currency summary selector and safe legacy request presentation. Each seller's reporting currency remains explicit.
- Store Settings refreshes its local revenue snapshot after a successful currency switch.
- Documentation and AI tool descriptions explain native balances, historical analytics, the expanded conversion scope and same-currency manual withdrawals.
- AI prompts receive the actual current server time. Immediate-start creation guidance avoids inventing a past date for “today.”
- WhatsApp confirmation/cancellation acknowledgements no longer claim that a cart was saved, no charge existed, or all sellers were already packing without evidence.

## 3. Verification method and boundaries

Live seller/buyer actions were performed through the normal browser UI, website AI and the authorized virtual WhatsApp inbox. These included coupon creation, product option selection, checkout, email confirmation, seller status updates, currency preview/confirmation and cancellation.

Supplementary production database checks were **read-only**, scoped to the dedicated test actors and exact test order references. They verified stored snapshots, currency fields, coupon counters and inventory; they did not create the orders, repair historical money, or substitute for the UI actions.

Dedicated live actors:

- Buyer: rzaib90501@mailinator.com.
- USD-transition seller: rzais90501@mailinator.com, Mobile AI Forge 90501.
- Unchanged PKR seller: rozare.seller.82901@mailinator.com, Nova Nest Market.
- Android screen verification: retained test seller rzacurrency090901@mailinator.com, Juniper Trails 90901.
- Admin was used only for payment/inbox review, never to place purchases.

Passwords, auth tokens, signed confirmation links and bank details are intentionally absent from this report.

All four new purchases below were test-only COD. No real dispatch, cash collection, Stripe/Wallet charge, or bank transfer was performed. Payment/refund/payout lifecycle coverage used automated local tests, including real Mongo replica-set transactions.

## 4. Live store conversion: PKR to USD

### Before conversion

Mobile AI Forge 90501 had:

| Setting | Original native value |
| --- | ---: |
| Aurora Thermal Travel Mug | PKR 3,664.50 |
| Alpine Vacuum Lunch Jar | PKR 2,614.50 |
| Meridian Bamboo Desk Lamp | PKR 4,399.50 |
| Standard shipping | PKR 275.00, four days |
| Fixed coupon FXSEP12FIX | PKR 100 discount; PKR 1,000 minimum; PKR 200 cap |
| Percentage coupon FXSEP12PCT | 10%; PKR 2,000 minimum; PKR 300 cap |

The fixed coupon had already been used by order A below.

### Preview cancellation and fresh confirmation

1. Opened a conversion preview using PKR 277.72 per USD. It included product examples, shipping and coupons.
2. Cancelled it. Store currency and recognized sales remained PKR.
3. Requested a new preview later. The reviewed rate was now PKR 277.69 per USD; product examples reflected the new quote.
4. Explicitly confirmed the fresh quote. Save and Cancel were disabled while saving.
5. Checked saved products, shipping, coupons and the cooldown in the UI and read-only records.

| Setting | Saved after confirmation |
| --- | ---: |
| Mug | USD 13.20 |
| Lunch jar | USD 9.42 |
| Desk lamp | USD 15.84 |
| Standard shipping | USD 0.99, still four days and active |
| FXSEP12FIX | USD 0.36 discount; USD 3.60 minimum; USD 0.72 cap |
| FXSEP12PCT | Still 10%; USD 7.20 minimum; USD 1.08 cap |
| Existing FORGE15 | Still 12%; USD 7.20 minimum; USD 2.52 cap |

Stock stayed 21/16/11 during the conversion itself. Coupon usage counts, limits and dates were retained.

Conversion completed at September 13, 2026, 00:10:28 UTC. The next currency change is allowed on **November 12, 2026, 05:10:28 Pakistan time**.

The PKR buyer subsequently saw the newly saved USD 13.20 mug as **PKR 3,665.51**. Existing orders still showed the old PKR 3,664.50 item price. This is the expected difference between a newly saved, currency-rounded catalog price and an immutable old order.

**Result: PASS — the reviewed conversion was saved consistently, while historical orders were preserved.**

## 5. Live order calculations

### Order A: all-PKR before the switch, delivered after the switch

Order: **ORD-1789255767217**

Database record: 6aa5e057093e43c3f2822852

Options: Aurora mug, **Silver / 500ml**, quantity one.

| Component | Buyer and frozen seller amount |
| --- | ---: |
| Product | PKR 3,664.50 |
| Shipping | PKR 275.00 |
| FXSEP12FIX discount | -PKR 100.00 |
| Total | **PKR 3,839.50** |

What I did and observed:

- Placed the order as the dedicated buyer.
- Saw the same options, components and PKR 3,839.50 on buyer details.
- Received the real confirmation email in Mailinator with the correct reference and total.
- Opened the signed decision page, then explicitly clicked Confirm. Opening the link itself did not confirm the order.
- Changed the store currency to USD.
- Progressed this seller shipment through processing, shipped and delivered.
- Seller details continued to show the original PKR item, shipping, coupon and total, with Silver / 500ml intact.
- COD delivery added no online withdrawable funds.

The entirely PKR order nevertheless stored the complete trusted table: USD 1, PKR 277.72, EUR 0.862 and GBP 0.74, captured September 12 at 23:29:26 UTC. Same-currency money had zero FX adjustment.

**Result: PASS — the old order remained PKR even though delivery happened after the store became USD.**

### Order B: USD and PKR sellers, buyer checks out in PKR

Order: **ORD-1789263362097**

Database record: 6aa5fe020ced42a545729a3d

Mo Forge mug: **Black / 350ml**. Nova product: Insulated Steel Bottle.

| Component | Buyer amount |
| --- | ---: |
| Mo Forge USD 13.20 mug, converted to PKR | PKR 3,665.51 |
| Nova native PKR bottle, unchanged | PKR 1,690.00 |
| Product subtotal | PKR 5,355.51 |
| Shipping: Mo Forge 274.91 + Nova 300.00 | PKR 574.91 |
| FXSEP12PCT capped discount, Mo Forge only | -PKR 299.91 |
| Checkout total | **PKR 5,630.51** |

| Seller | Frozen buyer allocation | Frozen seller-native calculation |
| --- | ---: | --- |
| Mobile AI Forge 90501 | PKR 3,640.51 | USD 13.20 + 0.99 - 1.08 = **USD 13.11** |
| Nova Nest Market | PKR 1,990.00 | PKR 1,690 + 300 = **PKR 1,990.00** |
| Buyer sum | **PKR 5,630.51** | Separate native currencies; do not add them as one currency |

The full snapshot was USD 1, PKR 277.69, EUR 0.862 and GBP 0.739, captured September 13 at 01:29:04 UTC.

What I did and observed:

- Tried to reuse the once-per-buyer fixed coupon. Checkout correctly rejected it as already used, even after the store currency changed.
- Applied the unused percentage coupon; its cap and minimum followed its new USD values.
- Confirmed through the virtual WhatsApp inbox.
- Changed only Mo Forge's shipment to Processing. Nova remained Confirmed.
- Checked buyer details: one purchase, separate stores/items, Black / 350ml retained, Mo Forge four days, Nova three days, separate status and shipping.
- Switched the buyer's browsing currency to USD later. This order still displayed its original PKR 5,630.51.
- Checked each seller's page. Mo Forge showed only its mug and USD 13.11; Nova showed only its bottle and PKR 1,990.
- Verified the buyer's in-app preparation notification named only Mo Forge's item and **PKR 3,640.51**, not the full mixed order.
- Found and fixed a metadata issue where Nova could see Mo Forge's coupon code despite receiving no discount. The seller response now scopes both coupon and settlement metadata; the buyer still receives the complete order.

Final status: Mo Forge Processing; Nova Confirmed. The order remains an active test COD order.

**Result: PASS after the seller-metadata fix — buyer and both seller amounts/statuses matched their own portions.**

### Order C: the same two store currencies, buyer checks out in USD

Order: **ORD-1789264049836**

Database record: 6aa600b10ced42a54572aa5d

Mo Forge mug: **Silver / 500ml**.

| Component | Buyer amount |
| --- | ---: |
| Native USD mug | USD 13.20 |
| PKR 1,690 Nova bottle converted to USD | USD 6.09 |
| Product subtotal | USD 19.29 |
| Shipping: Mo Forge 0.99 + Nova 1.08 | USD 2.07 |
| Checkout total | **USD 21.36** |

| Seller | Buyer allocation | Seller order detail |
| --- | ---: | --- |
| Mo Forge | USD 14.19 | USD 13.20 + 0.99 = **USD 14.19** |
| Nova | USD 7.17 | PKR 1,690 + 300 + 1.04 cent reconciliation = **PKR 1,991.04** |

Nova's displayed adjustment is the existing reconciliation rule: USD 7.17 multiplied by the frozen PKR 277.69 rate is PKR 1,991.0373, rounded to PKR 1,991.04. The PKR 1.04 difference is explicitly explained by the existing info tooltip. It is not a newly added fee.

What I did and observed:

- Attempted to reuse FXSEP12PCT after changing the buyer preference to USD. Its once-per-buyer restriction still applied.
- Placed the order without that coupon.
- Checked buyer details and both seller pages, including each seller's own amount and Nova's positive adjustment explanation.
- Cancelled through the virtual WhatsApp action button; no browser alert/confirmation popup was required there.
- Both seller portions became Cancelled. Stored amounts/currencies stayed unchanged.
- Stock was restored.

**Result: PASS — native USD stayed USD; the PKR seller's buyer-equivalent and exact-cent reconciliation were consistent.**

### Order D: all-USD control

Order: **ORD-1789264470582**

Database record: 6aa602560ced42a54572b420.

| Component | Buyer and seller amount |
| --- | ---: |
| Alpine Vacuum Lunch Jar | USD 9.42 |
| Shipping | USD 0.99 |
| Total | **USD 10.41** |

This order still saved the complete four-currency rate table, despite not needing item conversion. Native adjustment was zero.

I cancelled it from the buyer dashboard using that page's confirmation UI. The order retained USD 10.41 and the jar stock returned from 15 to 16.

**Result: PASS — same-currency checkout remained unchanged, with full historical reporting evidence saved.**

## 6. Historical analytics and online balances

Two pre-existing delivered PKR orders were inspected before and after conversion:

| Order | Frozen PKR total | Original USD report contribution |
| --- | ---: | ---: |
| ORD-1788584058484 | PKR 3,939.50 | USD 14.19 |
| ORD-1788583360941 | PKR 3,499.76 | USD 12.61 |
| Combined | PKR 7,439.26 | **USD 26.80** |

Both had their own September 5 rate of PKR 277.60 per USD. Their combined USD reporting was **26.80**, not the 26.79 that using the later checkout rate would produce.

The older version-0 order was not rewritten or backfilled into a new native snapshot.

After order A was delivered:

- Old delivered contributions: USD 26.80.
- Order A: PKR 3,839.50 at its own 277.72 rate -> USD 13.83.
- Recognized delivered revenue: **USD 40.63**, three recognized orders and three units.
- After order B's active Mo Forge portion: estimated total **USD 53.74** = 40.63 + 13.11.
- Cancelled orders C/D did not remain in that active estimate.
- Seller Analytics, Payments, refreshed Store Settings and natural-language AI agreed on the relevant totals.
- All online native available balances remained zero. COD did not become withdrawable.

The live admin Mo Forge row likewise showed online USD 0, delivered COD USD 40.63 and estimated USD 53.74. Nova's row remained PKR, with online PKR 0, delivered COD PKR 7,530 and estimated PKR 22,839.19.

**Result: PASS — historical reporting used original rates; real currency balances were not changed by reporting preferences.**

## 7. Web/mobile withdrawal presentation and payout safety

### Live UI

On the website I selected USD, PKR, EUR and GBP balances and verified the minima 5 / 2,000 / 5 / 5. Selecting PKR changed the withdrawal amount/minimum labels to PKR while the store revenue cards remained USD.

The Android emulator ran the installed Rozare app 1.0.11 / version code 13 and loaded the published update. Using the retained Juniper Trails test seller:

- Opened native Seller Dashboard -> Payments.
- Saw all four native balance choices.
- Selected PKR and saw PKR 0.00 available and **PKR 2,000.00 minimum**.
- Store reporting cards remained USD.

That account had no funds or bank destination. No live withdrawal was submitted. Nonzero withdrawal behavior is proven by the transactional and rendered-screen tests below, not by this empty-account UI check.

### Local automated lifecycle

Tests exercised native earnings and reservations with real Mongo replica-set transactions, including:

- Four minimum boundaries and same-currency destination enforcement.
- Existing PKR funds alongside new USD funds after a store switch.
- Pending versus available online money, with COD excluded.
- Concurrent requests, replay/idempotency and over-withdrawal protection.
- Exact reservation and release by withdrawal state.
- Approval versus processing/payment, required transfer evidence and uncertain/manual-review outcomes.
- Wrong-seller client responses, invalid money arithmetic and mismatched bank currencies.
- Full/partial refunds and dispute exposure, cumulative native reversals and same-currency deficits.
- Legacy withdrawal safety holds without rewriting signed payout terms.

**Result: PASS in automated transaction/UI coverage. Real bank transfers and funded live withdrawals were not executed.**

## 8. Notifications and ordinary-language AI

### Email

Order A's real confirmation email was observed in Mailinator with the right order reference and PKR total. Its decision page retained the selected product options and explicit confirmation worked.

A later visit to the public buyer inbox showed it empty. The reason was not established. Later status-email receipt was therefore not claimed from the inbox UI.

For order B, a final read-only outbox check showed its confirmation and seller-preparation emails marked delivered by the delivery system. This is server-side send evidence, not independent proof that a person saw the email.

### In-app and virtual WhatsApp

- The existing 50-number test pool remained configured; no global OTP bypass or new pool change was made.
- Buyer virtual WhatsApp messages for the four new orders showed the correct totals. Option-bearing orders retained selected color/capacity.
- Order A's processing/shipped/delivered updates continued to show PKR 3,839.50 after the store changed to USD.
- Order B confirmation and order C cancellation buttons caused the verified order actions.
- Mo Forge seller messages showed only its portion: order B USD 13.11 with buyer equivalent PKR 3,640.51; order C USD 14.19, not the whole USD 21.36.
- The buyer's in-app order-B preparation notification showed only Mo Forge's own item, shipping estimate and PKR 3,640.51 portion.
- Order-B outbox records showed in-app/email/virtual WhatsApp delivered. Push was correctly skipped with PUSH_DESTINATION_UNAVAILABLE because this browser test buyer had no available registered push destination.

Physical WhatsApp delivery and Android/iOS push receipt were not established by a virtual test inbox or that skipped push record.

### Natural seller AI requests

I asked the seller AI in ordinary language for the current store currency, shipping, delivered/estimated revenue, native balances and minimums. The virtual WhatsApp reply matched:

- USD store; USD 0.99 standard shipping, four days.
- Delivered USD 40.63; estimated USD 53.74.
- Four zero native balances.
- USD 5 / PKR 2,000 / EUR 5 / GBP 5 minimums.
- No automatic conversion of previously earned funds.

“Please switch my store currency back to PKR now” was correctly refused until November 12 under the 60-day rule. The stored currency remained USD.

A natural request to deactivate only FXSEP12FIX and FXSEP12PCT was verified in the actual coupon dashboard and read-only records. FORGE15 remained active.

A fresh website AI conversation correctly explained that old orders remain PKR while historical analytics currently display USD, returned USD 40.63/53.74, and gave the current Pakistan date as September 13, 2026.

During setup, an older AI path had supplied past start dates for “today.” Current-time context and immediate-start guidance were fixed. The later current-date answer was verified live; a second live coupon-creation start-date test was not performed. Existing coupon dates were deliberately preserved.

**Result: PASS for the observed currency/accounting conversations and verified actions; device push and later mailbox receipt are limited as described above.**

## 9. Bugs found during this work and fixes

| Issue actually observed or reproduced | Change and verification |
| --- | --- |
| Cancel remained available while a currency save was in flight | Disabled during confirmed saving; handler guard and live save-state check |
| Store Settings kept the previous PKR sales snapshot immediately after switching to USD | Refresh local analytics after save and hide a mismatched-currency snapshot; real handler test failed before the fix and passed afterward |
| Admin payments could not render an old bare withdrawal that lacked default version fields | Normalize response metadata without rewriting the record; reproduce with a raw legacy fixture, verify its stored data stays unchanged |
| Admin native accounting could misleadingly mix old payload semantics | Require the version-2 contract, explicit native summary selection and safe legacy/warning presentation |
| A seller saw another seller's coupon label on a mixed order | Scope coupon and settlement metadata by seller; real HTTP test failed before fix, then passed; buyer full data and stored order unchanged |
| WhatsApp cancellation text said the cart was saved although checkout had emptied it | Corrected the static acknowledgement; no cart mutation or unverified no-charge claim was introduced |
| AI could guess a past date for “today” | Supply actual current time and immediate-start guidance; current-date answer checked live, controller regression added |

All listed application fixes were committed, pushed to both mirrors and successfully deployed.

## 10. Automated verification and release

### Test results

| Verification | Result |
| --- | --- |
| Complete backend regression, four saved shards | **217 unique suites; 3,247 passed; 0 failed/skipped** |
| Complete mobile regression | **93 suites; 1,097 passed; 0 failed** |
| Latest complete frontend Node suite | **236 passed** |
| Native accounting / payout destination and legacy response follow-up | **58 passed** |
| Seller order access/scoping, order money and export follow-up | **129 passed** |
| WhatsApp decision reply and order transition follow-up | **23 passed** |
| Website Vite / SSR / prerender production build | **Passed** |
| Android / Hermes export | **Passed** |
| Production Android and iOS OTA export/publication | **Succeeded** |

The targeted follow-up runs occurred after the full backend regression as fixes were added. They overlap other coverage; these counts must not be added together to invent a larger unique-test total.

Coverage included all 16 supported seller/buyer currency pairs, all 12 store-currency change directions, a 300-product/three-example preview, inactive/expired coupons, redemption counter preservation, stale catalog/shipping/coupon terms, expired quotes, positive money rounding-to-zero rejection, complete snapshots on same-currency and zero-total orders, historical immutability, concurrent withdrawals and refund/deficit cases.

An earlier interrupted backend run had no final report and is not counted as a pass. The completed four-shard results are the source of the 3,247 total. An earlier mobile onboarding timeout passed standalone and then in the complete fresh 1,097-test run; no onboarding assertion was removed.

Some negative-path tests intentionally log invalid stored money or unavailable local payment configuration. Their expected errors are tested failures of unsafe operations, not proof of a production payment outage.

Saved local regression evidence includes the four native-currency-backend-shard JSON files and native-currency-mobile-final.json under test-assets. Generated exports, diagnostics and pre-existing test assets remain local and were not bulk-added to GitHub.

### Application commits, in order

| Commit | What changed and why |
| --- | --- |
| 21ed3d04 | Main store terms conversion, complete snapshots, historical reports, native balances/withdrawals, web/mobile/admin/AI contracts and tests |
| 67c5d9b6 | Locks confirmation controls during an in-flight currency save |
| 38c5b556 | Refreshes Store Settings analytics after a currency change |
| f1847e9e | Safe legacy payout response metadata and explicit native admin presentation |
| 7b367e0e | Seller-only coupon and settlement metadata on mixed orders |
| 277cb9de | Factual WhatsApp confirmation/cancellation acknowledgements |

Both main branches were verified at application commit 277cb9de123f80907945564ad25b71304ff3035d before this final report-only commit:

- ishanShahzad/hello-friend.
- Salman-here/Tortrose.

Vercel and Railway reported successful deployment for that final application commit. No credentials were added to the application commits.

### Mobile production OTA

- Channel/branch: production.
- Runtime: 1.0.11.
- Update group: 4c1cf33f-f44c-4a6d-ba38-c5cabac4b93a.
- Android update: 01a09805-5cb5-78d3-90ca-8cb3251cd470.
- iOS update: 01a09805-5cb5-79bf-81f4-94adf5596acc.
- Mobile source: 21ed3d04. Subsequent commits changed backend/web only.
- No new APK/AAB was built.
- [Published update group](https://expo.dev/accounts/rozare/projects/rozare/updates/4c1cf33f-f44c-4a6d-ba38-c5cabac4b93a).

The Android emulator initially encountered System UI stalls. It recovered after a cold restart with more emulator memory; app data was retained. The new native payment selector was then directly observed. The emulator was shut down after verification.

## 11. Historical-data exclusions and remaining verification limits

### Existing test data was not silently repaired

Admin accounting returned **161 valid seller rows and 18 excluded legacy seller summaries** at the audit point. Exclusions included incomplete trusted historical rates, inexact stored money and missing durable shipping ownership. The UI identifies exclusions; it does not quietly turn invalid sellers into zero revenue.

One old pending withdrawal lacked a frozen payout amount/destination and version defaults. Its legacy USD 200 reference and request-only PKR 55,636 are not enough to authorize an exact native bank payout. The page now renders it safely and blocks advancing an unsupported payment. It was not approved, paid, deleted or rewritten.

A generic legacy Store Overview view also exposed unavailable recognized revenue for unsupported older data. This was not disguised with today's exchange rate.

**Safety behavior: verified. Historical data completeness: not claimed.** Resolving those old test records would be a separate explicit data-repair decision; this task preserved them as requested.

### Not performed live

- A real Stripe charge, Wallet-funded payment or funded withdrawal.
- An actual admin bank transfer or physical COD collection.
- Physical iOS app interaction or Android/iOS push receipt.
- Physical WhatsApp handset delivery.
- A new live checkout in every one of the 16 currency pairs; the four live orders covered PKR-only, USD-only and mixed PKR/USD in both buyer currencies. EUR/GBP combinations were covered automatically.
- A second live currency change inside the 60-day restriction; refusal was verified, and all conversion directions were covered in transactional tests.
- A second live immediate-start coupon creation after the AI time-context fix.

No automated or virtual result above is presented as proof of one of these real-world events.

## 12. Final test state and conclusion

- Mobile AI Forge 90501 remains USD; its next allowed change is November 12, 2026.
- Nova remains PKR.
- Buyer display preference remains USD, while historical PKR orders stay PKR.
- Order A is test-delivered; order B remains Mo Forge Processing / Nova Confirmed; orders C and D are Cancelled.
- Final Mo Forge stock: mug 20, jar 16, lamp 11. Nova bottle stock 25. Cancelled C/D inventory was restored.
- FXSEP12FIX and FXSEP12PCT are inactive, each with one use retained. FORGE15 remains active.
- Buyer cart was empty after checkout/cancellation. No promise of an automatically preserved cart is made.
- No bank destination was added, no real funds were moved and no old financial records were rewritten.
- Application code is committed and pushed to both mirrors. Local test-assets are preserved.

**Conclusion:** The requested currency-change and native-accounting implementation is released. In the tested live orders, buyer totals, seller-native portions, options, shipping, coupons, statuses, historical reports and inventory matched the expected calculations. Native balance separation and withdrawal safety passed automated transaction and UI coverage. The listed historical-data exclusions and live-payment/device limitations remain visible rather than being reported as fully verified.
