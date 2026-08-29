# Google Play Data safety draft

This is the release declaration for Rozare Android 1.0.9 (version code 10). Re-check it against the final AAB before saving the Play Console form.

## Overview answers

- Does the app collect or share any required user-data types? **Yes**
- Is all user data encrypted in transit? **Yes**
- Can users request deletion of their data? **Yes**
- Deletion URL: `https://rozare.com/account-deletion`
- Account creation: **Optional** for browsing; required for saved account features, AI history, purchasing, selling, and account-specific tools.

## Data collected

| Play data type | Required or optional | Main purposes |
| --- | --- | --- |
| Approximate location | Automatic IP-based country detection; optional user-selected area/address | App functionality, personalisation, fraud prevention/security |
| Name | Required for an account/order; optional for guest browsing | Account management, app functionality, fulfilment, communications, fraud prevention/security |
| Email address | Required for an account/order | Account management, app functionality, fulfilment, communications, fraud prevention/security |
| User IDs | Automatic for signed-in accounts | Account management, app functionality, analytics, fraud prevention/security |
| Address | Required only when placing a shipped order or saving an address | App functionality and order fulfilment |
| Phone number | Required for order delivery and seller WhatsApp verification; optional elsewhere | App functionality, fulfilment, communications, fraud prevention/security |
| Other personal information | Optional profile, seller-business and store information | Account management and app functionality |
| User payment info | Optional when paying by card; entered into Stripe's payment interface | App functionality, payment processing, fraud prevention/security |
| Purchase history | Generated when carts, orders, refunds, returns or Wallet transactions are used | App functionality, account management, analytics, fraud prevention/security |
| Other financial info | Optional Wallet, seller settlement and payout information | App functionality, account management, fraud prevention/security |
| Other in-app messages | Optional AI prompts, AI conversations, reports, support text and WhatsApp-assisted workflows | App functionality, personalisation, account management, fraud prevention/security |
| Photos | Optional avatar, product, review and AI-chat image uploads | App functionality and account management |
| Audio files | Optional AI-chat voice notes | App functionality |
| Files and documents | Optional AI-chat attachments and generated/shared documents | App functionality |
| App interactions | Automatic use of marketplace, checkout, seller and AI features | App functionality, analytics, personalisation, advertising/marketing measurement, fraud prevention/security |
| In-app search history | Generated when search or AI product discovery is used | App functionality, analytics and personalisation |
| Other user-generated content | Optional products, store content, reviews, reports and seller-created material | App functionality and account management |
| Device or other IDs | Push token, IP-derived identifiers and advertising/event identifiers when integrations are enabled | App functionality, communications, analytics, advertising/marketing measurement, fraud prevention/security |

Data is processed ephemerally where appropriate, but account, order, safety and chat records are also retained as described in the public Privacy Policy. Therefore do not mark all collected data as ephemeral.

## Data shared with third parties

Use Play's service-provider exemptions where the recipient processes data only for Rozare (for example hosting, email, push delivery, AI processing, and payment processing). Declare sharing where an independent recipient receives data or where advertising-measurement integrations use it:

| Play data type | Why it may be shared |
| --- | --- |
| Name, address, phone number and email address | Shared with the relevant seller and delivery provider to fulfil an order |
| Purchase history | Shared with the relevant seller/delivery provider for fulfilment, returns and support |
| User IDs, email address, phone number, approximate location/device identifiers and app interactions | Advertising and marketing measurement through enabled Meta or TikTok server-side event integrations; direct identifiers are hashed where supported, but hashing does not remove the declaration requirement |
| Product/store/review content | Published as part of the user-requested marketplace experience |

Do not mark AI prompts, voice notes, uploaded images, card details, or push tokens as “shared” solely because a contracted service provider processes them on Rozare's behalf, unless that provider uses the data for its own independent purposes under the current contract.

## Security and deletion evidence

- API and public pages use HTTPS.
- Authentication tokens use device secure storage on Android.
- Card entry is handled by Stripe rather than stored as raw card data by Rozare.
- Users can delete an account in the app under **Profile -> Settings -> Delete Account**.
- Public deletion instructions are available without signing in.
- Some order, payment, dispute, tax, fraud-prevention and safety records can be retained where legally or operationally required, as disclosed in the Privacy Policy.

## Not collected by the current Android build

- Precise GPS location
- Contacts
- Calendar events
- Health and fitness data
- Installed apps
- Web browsing history
- SMS or call logs

Crash/diagnostic collection through Sentry is disabled unless a production DSN is supplied. If a DSN is added to the EAS production environment before release, add **Crash logs** and **Diagnostics** to this declaration before submission.
