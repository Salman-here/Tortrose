# Natural-language AI commerce verification — 8 September 2026

Status: implementation and focused cross-channel live verification completed; final cleanup recorded below. This report records observed results; an untested row is not a pass.

## Scope and method

Improve ordinary-language buyer and seller conversations on the website, Android app, and virtual WhatsApp test inbox. The live prompts use names, misspellings, pronouns, and ordinary corrections, not internal action names or database IDs. After a mutation, inspect the real cart or seller catalog independently of the AI response.

Dedicated accounts: `rzaib90501@mailinator.com` (buyer) and `rzais90501@mailinator.com` (seller, Mobile AI Forge 90501). Virtual WhatsApp numbers end in 0116 and 0117 respectively. Credentials are deliberately omitted.

This is a focused conversational release verification, not a claim that every possible phrase, language, or workflow has been exhaustively tested. Earlier action-by-action tests are complementary; they do not replace these conversations. Virtual WhatsApp proves the application's inbound AI routing and captured outbound messages, not physical handset delivery by Meta. iOS is not interactively tested in this run.

## Defects reproduced and corrected

1. **Cart corrections added duplicates.** Before the fix, changing a Black 500ml mug to Silver added a second mug. Added a dedicated, validated cart-line edit, preserving unspecified options, quantities and unrelated products. Ambiguous variants require clarification. Existing stock, ownership, money and idempotency rules remain enforced.
2. **Users were asked for exact names too early and shown internal IDs.** Added search-first conversational guidance and a bounded lookup recovery before asking for spelling. Friendly names and choices are displayed; database identifiers remain internal.
3. **The assistant stopped after an intermediate lookup.** A read is now allowed to be an intermediate step before an authorized edit. All three server execution paths use the same conversational policy.
4. **An uploaded product image was lost across follow-up questions.** A live two-turn Horizon Commuter Tumbler creation initially used the fallback icon. Added durable attachment context to web/mobile conversation messages, authenticated history recovery, and conservative binding of an uploaded image to the explicitly named new product.
5. **A short option answer led to an unexecuted promise.** After “black, the bigger one,” the assistant said it was adding the mug but the actual cart stayed empty. Added bounded completion recovery: execute the remaining authorized action, ask for genuinely missing information, or report that the change is unconfirmed. A successful lookup is not a successful mutation.
6. **The new edit receipt double-converted its display subtotal.** Live cart editing correctly retained one Silver 500ml mug and one jar at Rs6,279.00, but the action receipt displayed Rs1,743,427.14. The saved cart and checkout subtotal were correct. Receipt formatting now explicitly uses the already-priced buyer currency and is checked in all four supported currencies.
7. **Roman Urdu progress wording escaped the initial completion check.** The WhatsApp response to a Roman Urdu colour correction said it was working but left the actual cart unchanged. Extended progress/completion checks and added cross-channel regressions for Roman Urdu, plus phrase-level Urdu/Hindi-script coverage. Automated phrase coverage is not a claim of exhaustive language understanding.
8. **No authoritative delivered-total preview existed for chat checkout.** Added a preview branch of the existing COD pricing pipeline. It returns exact items/options, address, shipping, tax and total without an order, inventory reservation, cart change or notification. Chat order creation requires review followed by a separate confirmation turn. A signed, buyer-bound ten-minute preview detects changed items, prices, address, currency or charges. This reuses existing money calculations and does not change the website's currency/freezing rules. Partial supplied shipping details now prompt for missing fields instead of falling back to an older saved address. Aggregate requested stock across variants is checked before previewing.
9. **The initial signed-preview handoff was rejected live.** The correct live preview was displayed, but the confirmation token could not be verified, so no order was placed. Moved token retention to the server and kept it out of model-generated arguments. The server validates the original signed token from the conversation, and repeated confirmation of the same preview reuses its committed order. Final live retest is recorded below.
10. **Saved mobile image messages displayed internal metadata.** Restored image attachments labelled `image` were displayed as generic files and their metadata URL appeared in the user bubble. Mobile presentation now recognizes saved and MIME image types, renders the picture, and hides only the attachment marker while retaining it for follow-up context.
11. **Refreshing a preview lost the explicitly supplied address.** A live refresh incorrectly used 123 Main St instead of the new 909 Virtual WhatsApp Way address. No order was placed from that preview. Corrected conflicting context instructions, retained reviewed fields for confirmation, and added a same-order refresh mode that reuses the prior request exactly. The later live refresh preserved the correct address, selected options and total.
12. **Category/brand capitalization could create duplicate filters.** The native listing used `drinkware` while an existing listing used `Drinkware`. AI product creation and edits now reuse the established case-insensitive category/brand spelling within the same seller's catalog, while preserving new names and product titles. Automated seller-scope/native-money regressions passed; live cleanup verification follows below.
13. **Ambiguous product requests did not always list the actual choices.** With two tumblers, the assistant safely refused to guess but initially failed to name them. Ambiguity responses now include friendly product names and relevant native prices/stock, or cart options/quantities. The candidate query now includes source currency metadata. Cart corrections also respect the selected conversation currency rather than an older profile preference. Live named-choice and misspelled follow-up verification is below.
14. **A late photo test invented commercial data.** “For testing, add this to my store as Cedar Trail Cup. It is a reusable cup with a lid. Write a short description.” published a listing at Rs10 despite the seller supplying no price or stock. That temporary listing was immediately deleted. Added mandatory server-side seller-input evidence validation to all three AI channels for single and bulk creation. The assistant must obtain price and stock from the seller, an applicable uploaded row, or a displayed proposal that the seller explicitly approves. Its submitted numbers must match that evidence. “For testing” does not waive this requirement. Explicit currency takes precedence; otherwise creation uses the store currency. Price/stock guesses and unexplained discounts are rejected before saving. Automated tests cover English number words, common Roman Urdu amounts, currency aliases, imported rows, and misleading image filenames/URLs. Live retest follows below.
15. **Web New chat restored stale messages.** The header created a new server conversation but its parent retained the previous history array; changing the conversation ID re-applied that old array. The reset now explicitly clears parent history. Generation guards discard stale history/list responses after selection/reset/unmount. New-chat creation preserves the current conversation if the server request fails, and sends are disabled while history is loading or could not be verified. Sidebar switching/new-chat creation is blocked while an AI action or voice recording is active. This is a web-client correction, not a currency or checkout change.

## Live observations

### Website buyer

An Alpine Vacuum Lunch Jar was added through the ordinary product-page button to test preservation of an unrelated cart item (one unit, Rs2,614.50).

| Ordinary message / action | Independently observed result | Verdict |
| --- | --- | --- |
| “can u find the aurra travl mug? i want one” | Direct search found Aurora Thermal Travel Mug at Rs3,664.50, offered Black/Silver and 350ml/500ml, no raw ID in the reply. | PASS |
| “black, the bigger one” | Actual cart: one Black 500ml Aurora mug plus one Alpine jar. Rs3,664.50 + Rs2,614.50 = Rs6,279.00. An actual action receipt preceded the final confirmation. | PASS |
| “actually make it silver instead, same big size, still just one mug” | Actual cart: one Silver 500ml mug and unchanged jar. Still two units and Rs6,279.00. Receipt text exposed defect 6 above; the subsequent Android quantity/size edits verified the corrected receipt and real cart together. | Cart edit PASS; initial receipt FAIL; receipt retest PASS |

### Android buyer, continuing the website conversation

The native app loaded the saved web conversation. Messages below were typed into the installed Android app; the independent checks used the freshly reloaded website cart, not the AI transcript.

| Ordinary message | Actual cart and displayed receipt | Verdict |
| --- | --- | --- |
| “make the mug two, keep the lunch jar as it is” | Two Silver 500ml mugs: 2 × Rs3,664.50 = Rs7,329.00. One unchanged jar: Rs2,614.50. Total Rs9,943.50. Both native reply and action receipt matched. | PASS, including repaired receipt |
| “actually only one, and the smaller size please” | One Silver 350ml mug and one jar. Quantity, size, colour and Rs6,279.00 subtotal matched in the real cart and native receipt. | PASS |
| “make it purple instead” | Explained that only Black and Silver exist and asked which one. Actual cart stayed Silver 350ml, quantity 1, plus unchanged jar, Rs6,279.00. | PASS |

### Virtual WhatsApp buyer

| Ordinary message | Independent website-cart observation | Verdict |
| --- | --- | --- |
| “meri cart mein aurora mug ko black kar do, chota size wahi rakho aur sirf ek mug. jar ko mat badalna” | Initial attempt only promised an update. After `f7379be0`, the exact request changed the mug to Black 350ml, quantity 1; jar unchanged; Rs6,279.00. | Initial FAIL; retest PASS |
| “add another aurora mug as well, silver and the bigger size, just one extra” | Black 350ml mug ×1, separate Silver 500ml mug ×1, jar ×1. Rs9,943.50. An intentional extra item was distinguished from a replacement. | PASS |
| “remove both mugs from my cart please” | Both mug variants removed. Only Alpine jar ×1 remained, Rs2,614.50. | PASS |

### Natural COD checkout

The buyer asked to buy one Aurora mug, not the lunch jar, and see the delivered total first. The early assistant unnecessarily added the mug to the cart and speculated incorrectly about why it had previously disappeared (the mugs had actually been removed through WhatsApp). The conversational policy now explicitly prohibits inventing causes of cross-device cart changes and supports direct product previews without adding a cart item.

After choosing Silver and the bigger size and providing the new fictional Lahore delivery address, the live preview showed:

| Component | Amount |
| --- | ---: |
| One Silver 500ml Aurora mug | Rs3,664.50 PKR |
| Delivery | Rs275.00 PKR |
| Tax | Rs0.00 PKR |
| Total | Rs3,939.50 PKR |

The real buyer Order History still contained its seven prior orders, all dated 5 September, after this preview. Thus the preview did not place an order. Its first confirmation was rejected by the signed-preview validation (defect 9); no success was counted for that failed attempt.

#### Final confirmed order and cancellation

**Order:** `ORD-1788861073201`; database record `6a9fda919abddc20e41af051`.

After the corrected preview, the buyer said “yes, that is correct. place that one mug order now.” The actual buyer dashboard showed one new COD order, one Silver 500ml mug, product Rs3,664.50, shipping Rs275.00 (standard, four days), total Rs3,939.50, and no lunch jar. The saved recipient was Natural Conversation Buyer, `rzaib90501@mailinator.com`, `+12025550116`, 909 Virtual WhatsApp Way, Lahore, Punjab 54000, Pakistan. **PASS.**

“please cancel the mug order I just placed, it was only for testing” cancelled this exact order without supplying its ID. The independently reloaded order page showed Cancelled/Unpaid, “Nothing has been charged,” retained the correct options/address/frozen totals, and disallowed returns for the cancelled portion. **PASS.**

“I only want to check now. Show me a fresh preview of that same mug and the same new delivery address. Do not place another order.” returned Silver 500ml, quantity one, the original new 909 address, and Rs3,939.50. The existing order stayed cancelled; no new placement receipt was produced. **PASS for refreshed details; final order-count verification below.**

“please empty my whole cart now” was followed by an independently reloaded storefront cart showing “Your cart is empty.” **PASS.**

### Seller and virtual WhatsApp observations

| Channel / message | Independent catalog observation | Verdict |
| --- | --- | --- |
| Web: “can you find my lunch jarr and tell me how many i have in stock?” | Directly found Alpine Vacuum Lunch Jar; reported the actual 16 units. | PASS |
| Virtual WhatsApp seller: “hello, can you find my lunch jarr and tell me the stock?” | Correct product and 16 units without requiring its exact spelling. | PASS |
| Virtual WhatsApp seller: “set that jar to 19 in stock please” | Seller catalog changed to 19. | PASS |
| Virtual WhatsApp seller: “actually put the lunch jar back to 16 please” | Seller catalog returned to 16. | PASS |
| Web: image plus “add this to my store please. call it Horizon Commuter Tumbler. write a nice description for it”; then price Rs2,250, stock 8 and brand | Product, description, category, price and stock were created. Image initially fell back to the site icon, leading to defect 4. The Android correction and separate new native listing below verified image retention after the fix. | Initial image FAIL; retests PASS |
| Web: “make the horizn tumbler 2200 rupees instead, keep 8 in stock” | Correct temporary product changed to Rs2,200 with stock 8. | PASS |
| Android seller: “use the photo I sent earlier for the Horizon tumbler. set it as the main product picture” | The real public product page changed from the fallback icon to the original uploaded Cloudinary image `v1djtclkittgrqco61ta.png`; price stayed Rs2,200, stock 8. | PASS |
| Android seller: selected a photo through the Android picker, then “Add this to my store as Summit Trail Tumbler. It is a reusable cup with a lid. Write a simple description.” | Asked for missing price/category/brand/stock. No technical command or product ID was supplied. | PASS |
| Android seller follow-up: “2300 rupees each, six in stock, brand Mobile AI Forge. put it in drinkware please.” | Real product `6a9fdafd9abddc20e41af382`: title Summit Trail Tumbler, price Rs2,300, stock 6, supplied brand, description “A reusable cup with a lid,” and uploaded Cloudinary image `bavako4wwbevcr2k2uj0.png`. Photo survived the separate follow-up. | PASS |
| Web fresh conversation: “change the stock of the tumbler to 7 please” | Asked which tumbler and listed Summit (Rs2,300, stock 6) and Horizon (Rs2,200, stock 8). No raw ID was required. | PASS |
| Web: “the sumit one” | Summit changed to stock 7; Horizon remained at 8. | PASS |
| Web: “put it back to 6 and put it in drinkware, keep price the same” | Summit returned to stock 6 and canonical `Drinkware`; its Rs2,300 price remained unchanged. | PASS |
| Web: “Delete these two temporary test listings: Horizon Commuter Tumbler and Summit Trail Tumbler. Keep all my other products.” | Both temporary listings disappeared. The original three products and their stock remained. | PASS |
| Android seller: “show me the latest order”; then “what options did the buyer choose” | Identified the new cancelled order, Rs3,939.50 PKR, and Silver/500ml Aurora mug. Actual seller order details matched. | PASS |

Virtual WhatsApp seller also answered “how is my shop doing? how many orders have I got and how much have I sold?” with the then-current 4 products, 4 orders, 2 delivered, 2 cancelled, and Rs7,439.26 PKR. Later counts legitimately changed after the additional cancelled order and temporary product cleanup. Final independent totals follow below.

### Seller dashboard, money and order verification

The seller's store is PKR while the account/display selector is USD. These observations came from actual seller pages, not only AI answers:

| Actual page / measure | Observed value and reconciliation | Verdict |
| --- | --- | --- |
| Dashboard revenue | Rs7,439.26; unchanged by the new unpaid, cancelled COD order | PASS |
| Dashboard orders | 5 total = 2 delivered + 3 cancelled; 0 pending/processing | PASS |
| Dashboard conversion | 40%, consistent with its current implementation: 2 delivered ÷ 5 total orders | PASS against existing definition |
| Analytics | Revenue Rs7,439.26, 2 recognized orders, average Rs3,719.63, 2 units sold | PASS |
| Payments | Withdrawable online Rs0; delivered COD Rs7,439.26; pending COD/online estimates Rs0; no withdrawal performed | PASS |
| New seller order detail | Cancelled/unpaid; Silver 500ml ×1; Rs3,664.50 + Rs275 = Rs3,939.50; correct buyer/email/phone/new 909 address | PASS |
| Original catalog after final cleanup | Aurora stock 22, Alpine stock 16, Meridian stock 11; 3 original products, with original Rs3,664.50 / Rs2,614.50 / Rs4,399.50 prices | PASS |

The account's USD display preference did not relabel these seller-native PKR amounts. This run does not replace the previous mixed-currency/multi-seller financial report; it verifies the natural-language path into the existing money rules.

### Final web photo test and clean conversation

After deploying `30e6351a`, I selected the previous Cedar conversation from history, clicked the chat-header **New chat**, and checked that the conversation body contained only the greeting, not old user messages or creation receipts. Reloading the page retained that empty new conversation. **PASS.** Old conversations remained accessible in the sidebar; New chat did not delete them.

In that genuinely new conversation:

1. Attached `aurora-thermal-travel-mug.png` using the website's upload control and sent: “For testing, add this to my store as Cedar Trail Cup. It is a reusable cup with a lid. Write a short description.”
2. The AI asked for price, category, brand and stock. An independently reloaded product-management page still showed only the original three products. No guessed-price listing had been created. **PASS.**
3. Replied: “2100 rupees each, three in stock, brand Mobile AI Forge. You can choose a suitable category.”
4. The actual catalog then showed Cedar Trail Cup, Rs2,100.00 PKR, stock 3, brand Mobile AI Forge and category Drinkware. The AI supplied the short description “A reusable cup with a lid, perfect for your daily beverages.” No product ID or internal command was supplied by the tester. **PASS.**
5. The catalog image and saved user-upload image both loaded successfully from the exact same Cloudinary asset, `gjfeblaw4994xi5tgkee.png`. This confirmed that the real uploaded photo, not a fallback icon, survived the separate commercial-details reply. **PASS.**
6. Requested deletion of Cedar Trail Cup only, with the other products explicitly left unchanged. The independently reloaded catalog returned to the original three products and the original prices/stock. **PASS.**

### Notifications and WhatsApp follow-up safety

- The actual seller notification center contained the new COD notice and cancellation notice for `ORD-1788861073201`, each with Rs3,939.50 PKR and the appropriate cash-uncollected state. **PASS.**
- The virtual WhatsApp inbox captured the buyer confirmation message with Silver/500ml ×1, product Rs3,664.50, total Rs3,939.50 and Confirm/Cancel buttons, plus seller new-order/cancellation messages and buyer cancellation. **PASS for captured application messages.**
- Mailinator displayed the real cancellation email from `no-reply@rozare.com`, with subject `Order cancelled - ORD-1788861073201` and Rs3,939.50. **PASS for cancellation-email receipt.** The original confirmation email was not visible when inspected; this report does not claim its delivery was verified in this run.
- A virtual WhatsApp quote-only request for one Black 350ml mug returned Rs3,939.50 with delivery. “Refresh that same preview with exactly the same details” retained Black/350ml, the same total and 909 Virtual WhatsApp Way. Neither request placed an order. The final seller count remained 5. **PASS.**
- Clicking the old Confirm button for the already-cancelled test order did not immediately reopen it. The existing flow sent a separate “Re-confirm order?” message with `Yes, confirm again` and `No, keep cancelled`. Selecting `No, keep cancelled` retained the cancelled state, with no JavaScript confirmation popup. Order count stayed 5, pending count 0 and revenue unchanged. **PASS.** This is a two-step reconfirmation flow, not a claim that reconfirmation is permanently forbidden.

## Release records

- `e844bacf`: natural product matching and atomic cart-line editing; web/mobile/WhatsApp context and regression tests.
- `41559388`: retain product photos across conversational follow-ups and authenticated image-history recovery.
- `46f463eb`: finish authorized actions before ending replies, including short option answers; bounded non-success fallback.
- `93a7c661`: format cart-edit receipts without a second currency conversion.
- `f7379be0`: extend action-completion verification to Roman Urdu conversations.
- `72904b9e`: exact COD order previews, protected confirmation, live repricing checks, address/stock validation and cross-surface preview context.
- `ec2da605`: retain signed preview approvals server-side, deduplicate repeated confirmation, and clean saved mobile image presentation.
- `bf5a2ac7`: preserve reviewed address/options through confirmation and unchanged refreshed previews; clarify use of prior conversational context.
- `843c3086`: reuse existing seller category and brand spelling in natural-language product creation/edits.
- `a0dbd168`: show named disambiguation choices with source currency and retain selected chat currency in cart corrections.
- `f22fb027`: require seller-provided commercial values for conversational single/bulk product creation; validate the model's values against that evidence before saving.
- `30e6351a`: keep web New chat separate from old history; ignore stale reads, retain the old chat on creation failure, and guard history loading/action switching.

All listed commits were pushed to both configured GitHub remotes. The application-code release and its actual deployed behavior were verified as follows.

Application-code release `30e6351af7be4bd0bbf9255bcfaa84ded68ec7e1` was verified at both remote `main` branches. GitHub's Vercel status reported “Deployment has completed,” and the Railway status reported “Success - rozare.up.railway.app.” The subsequent live New-chat and guarded photo-creation tests ran after these successful deployments. No new native build was made.

Mobile production OTA, runtime `1.0.11`: group `ba3b2658-132b-465d-afe4-d024b42c7212`; Android `01a07e97-825c-7484-aebd-02572d751e39`; iOS `01a07e97-825c-7168-a6c8-9f49422d629f`. The Android emulator reported DownloadComplete for that Android update and was restarted to activate it. No new native build was required.

The final mobile client update supersedes the above: group `d3f411c5-337d-4706-adcb-231be661a0cb`, Android `01a07eed-d9b0-796a-9a6b-84363aa3f987`, iOS `01a07eed-d9b0-7ba2-b49b-021105700f62`, runtime `1.0.11`, built from `ec2da605`. Android reported DownloadComplete and was restarted before the fresh native image-creation test. Later changes were backend-only or web-only, so did not require another mobile bundle.

The first `ec2da605` Railway attempt `f917be9e-605e-474c-a883-145e87629b6e` failed after build/image-push logging. Retrying the same source succeeded as `cfbc2e63-8351-4324-9172-f538b72b0825`. The preceding healthy deployment continued serving during that failed attempt. Subsequent `bf5a2ac7` and `843c3086` GitHub deployment statuses were successful.

Two Windows restarts interrupted the emulator/browser sessions during testing. Saved conversations and server data were recovered; the unsent native attachment draft was selected again. A later Android System UI not-responding dialog was a test-device issue, not counted as an application pass or production backend failure.

## Automated checks

- Initial release: 32 backend AI-related suites, 377 tests passed.
- Attachment follow-up checks: 6 backend suites, 60 tests passed.
- Completion recovery checks: 4 backend suites, 67 tests passed.
- Cart service including native receipt currency: 28 tests passed against a disposable MongoDB replica set.
- Full backend AI rerun through `93a7c661`: 33 suites, 397 tests passed.
- Roman Urdu completion/recovery targets: 4 suites, 81 tests passed.
- Full backend AI suite including previews: 34 suites, 425 tests passed. Later server-retained preview/idempotency targets: 6 suites, 158 tests passed.
- Full mobile suite: 91 suites, 1,088 tests passed. One old source-string assertion was updated to include attachment context while still requiring tool-result context; this was not a production failure.
- Mobile image presentation and related screen tests: 3 suites, 23 tests passed.
- Web AI UI checks: 8 passed; production build with SSR/prerender passed.
- Mobile AI-related checks after attachment changes: 6 suites, 39 tests passed.
- Final expanded backend selection after `f22fb027`: **40 suites, 667 tests passed**, including AI, order money, line pricing, checkout pricing, and product selection. Disposable-database commercial-evidence tests verified that missing or mismatched seller price/stock saves no product.
- Final complete mobile rerun: **92 suites, 1,094 tests passed**. A preceding run under heavy host/emulator load timed out in two onboarding cases; the unchanged file passed in isolation and the complete suite then passed with the emulator closed. This was recorded rather than counted as a production failure.
- Web JavaScript test set after the New-chat correction: **215 tests passed**, including 14 targeted AI role/history tests. History-generation tests cover out-of-order responses and reset/unmount invalidation; source-contract tests check the integration guards. Live UI verification is recorded separately, not inferred from these assertions.
- The production web build, including both SSR bundles and documentation/home prerendering, passed after the New-chat changes.

These local tests do not place production orders. Expected local missing-Stripe warnings do not constitute a live Stripe result.

## Final verification and cleanup

Completed: live receipt retest, native buyer/seller conversations, virtual WhatsApp buyer corrections, native two-turn photo creation, named-choice follow-ups, checkout preview/placement/cancellation, seller dashboard and notification checks. Buyer cart cleared; Horizon and Summit temporary listings deleted; the erroneous Cedar listing deleted. The single new COD order remains cancelled as an audit record.

The web New-chat and final photo/price/stock checks also passed on the deployed release. After the final Cedar deletion, independently reloaded seller catalog/dashboard pages showed:

- Exactly the three original products, stock 22 / 16 / 11, and unchanged original prices.
- Exactly 5 orders, including the one new test order still Cancelled/Unpaid for Rs3,939.50.
- Revenue Rs7,439.26, 0 pending orders, 0 processing orders, 2 delivered orders, and 0 low-stock products.

Temporary Horizon, Summit, and both Cedar test-listing attempts were removed through the seller AI. Original products were preserved. The test chat history and uploaded images remain as audit evidence and can be used to recreate the temporary listings if needed; the cancelled COD order also remains as an audit record. No real funds were charged or withdrawn.

The final two Markdown reports are committed separately from application code. The generated local `test-assets/` directory is intentionally excluded from Git; no application-code edits remain uncommitted.

## Coverage boundaries and conclusion

The tested ordinary-language journeys now work without buyers or sellers supplying tool names or product IDs. Missing options or commercial details lead to questions; ambiguous product names lead to choices; edits preserve unrelated cart items; actual mutations are checked against receipts and ordinary dashboards. The identified live failures and their successful retests are retained in this report, rather than hidden behind an overall pass.

This run specifically covers web, native Android, and the virtual WhatsApp application's AI/message capture. It does **not** establish exhaustive correctness for every possible wording, language, seller/buyer action, uploaded file, or voice note. Physical WhatsApp delivery, an iOS device, live Stripe/wallet charging or withdrawals, and a new physical-device push test were not performed here. Cancellation email receipt was observed; initial confirmation-email receipt was not verified in this run. Earlier action-level and financial reports remain separate evidence, not substitutes for these conversational checks.
