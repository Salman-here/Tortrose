# Live AI natural-language spot check

Test dates: September 7-8, 2026 (Pakistan time).

Scope: one buyer conversation and one seller conversation on the live website. Every tester message used everyday wording. No tester message supplied an internal tool name or product ID.

This is a focused conversational test, not a repeat of every AI action or every transport. Mobile and WhatsApp were not exercised in this spot check. No order was placed or payment made.

## Buyer conversation

Account: `rzaib90501@mailinator.com`.

The buyer cart was independently checked and was initially empty.

| Tester message | What the AI actually did | Result |
|---|---|---|
| `can u find the aurra travl mug? i want one` | Interpreted Aurora, but asked the tester to confirm the spelling before searching. | Recognized the likely name; extra clarification. |
| `yeah thats the one, show me` | Found Aurora Thermal Travel Mug and other products. Showed the correct Rs3,664.50 PKR price and the available Black/Silver and 350ml/500ml choices. Also printed raw product IDs in its prose. | Lookup worked; internal-ID display defect. |
| `the aurora one please, add it to my cart` | Asked which color and capacity the buyer wanted before adding. | PASS: missing choices requested. |
| `black, the bigger one` | Added one Black, 500ml Aurora Thermal Travel Mug. | PASS: ordinary relative wording understood. |
| `actually make it silver instead, same big size, still just one mug` | Added a Silver, 500ml mug while leaving the Black mug in the cart. Said it had made a mistake and would fix it, but no repair occurred in that completed turn. | FAIL: replacement became an additional item. |
| `no thanks, remove both mugs from my cart please` | Cleared the cart. | PASS: cleanup independently verified. |

Independent cart verification after “black, the bigger one”:

- Product: Aurora Thermal Travel Mug.
- Capacity: 500ml.
- Color: Black.
- Quantity: 1.
- Subtotal: Rs3,664.50 PKR.

Independent cart verification after the correction:

- Black 500ml mug, quantity 1: Rs3,664.50 PKR.
- Silver 500ml mug, quantity 1: Rs3,664.50 PKR.
- Subtotal: Rs7,329.00 PKR.

The arithmetic for two items was correct, but two items contradicted the explicit request to keep only one. The intended result was one Silver 500ml mug at Rs3,664.50 PKR. This was an action-selection/replacement failure, not a multiplication error.

The AI's cleanup claim was checked in the normal cart UI after reload: “Your cart is empty.”

## Seller conversation

Account: `rzais90501@mailinator.com`; store: Mobile AI Forge 90501.

Before testing, the normal product-management UI showed:

- Aurora Thermal Travel Mug: 22 in stock, Rs3,664.50 PKR.
- Alpine Vacuum Lunch Jar: 16 in stock, Rs2,614.50 PKR.
- Meridian Bamboo Desk Lamp: 11 in stock, Rs4,399.50 PKR.

| Tester message | What the AI actually did | Result |
|---|---|---|
| `can you find my lunch jarr and tell me how many i have in stock?` | Asked for an exact name or more specific description before performing a product search. | Friction: did not first attempt the supplied partial name. |
| `the alpne vacuum jar, the one for keeping lunch warm. how many are left?` | Found Alpine Vacuum Lunch Jar and reported 16 in stock. | PASS: partial name, misspelling, and description resolved. |
| `set that one to 17 in stock please` | Edited Alpine Vacuum Lunch Jar to stock 17. A refreshed product-management page independently showed 17. | PASS: contextual reference selected the correct product. |
| `actually put it back to 16 please` | Edited the same product back to 16. The product-management page was refreshed to verify restoration. | PASS: follow-up correction and cleanup. |

No product prices were changed. The seller's catalog remained at three products.

## Conclusion

Users can complete the tested buyer selection and seller stock-edit actions using ordinary wording without supplying product IDs or internal commands. However, this spot check did not pass completely:

1. Buyer product-search prose exposed raw internal IDs.
2. Replacing a cart item's color added a second item instead of replacing the existing selection, despite “still just one mug.”
3. Both initial misspelled-name requests caused extra clarification before lookup. The seller request asked for an exact name even though a partial-name search could have been attempted first.

These are observed live results. They support fixing and retesting the conversational experience; they do not support claiming that all natural-language requests work reliably across web, mobile, and WhatsApp.

Application code was not changed during this spot check. Test cart items were removed and the seller's original stock was restored. Natural-language image-based product creation, complete checkout, ambiguous multi-product edits, mobile, and WhatsApp remain outside this specific check.
