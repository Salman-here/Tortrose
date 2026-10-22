# Evolution API Runtime

Rozare runs Evolution API on the Oracle VM from this folder.

The `evolution-api` service intentionally builds a local image instead of using
the upstream image directly:

- Base: `evoapicloud/evolution-api:v2.3.7`
- Baileys: upgraded to `7.0.0-rc13`
- Patch: preserve explicit `@lid` reply targets before phone-number lookup in
  every executable bundle, including both `dist/main` entry points
- Patch: release Baileys' inbound event queue immediately after the
  `MESSAGES_UPSERT` webhook so contact/profile sync cannot delay the next
  inbound message
- Patch: bypass normal `MESSAGES_UPDATE` work in Rozare transport mode so
  delivery/read receipts cannot block subsequent inbound messages in the same
  serial Baileys event queue
- Patch: relay existing quick-reply buttons without the obsolete view-once
  wrapper and with the interactive business node required by WhatsApp

Why: WhatsApp started returning outbound ack error `463` for some linked-device
sends when the sender was missing or not reusing the right LID/tctoken state.
The broken symptom is that Evolution accepts `/message/sendText`, stores the
message as `PENDING`, then emits `MESSAGES_UPDATE` with `ERROR`.

Rozare uses Evolution as a transport gateway. The backend owns chat history,
AI state, orders, and contact identity. For that reason the compose file keeps
message/update/contact/chat/history persistence disabled and enables
`ROZARE_FAST_INBOUND_WEBHOOK=true` plus
`ROZARE_SKIP_MESSAGE_UPDATE_WORK=true` to avoid serial queue stalls after an
inbound webhook has already been emitted.

## Zombie-session watchdog

The Baileys WebSocket can die silently while the instance keeps reporting
connectionState `open`: every send fails with Boom 428 `Connection Closed`,
no inbound webhooks arrive, and dashboards still show "connected". Recovery
is layered:

1. Backend `services/whatsapp/gatewayHealthMonitor.js` probes real socket
   liveness (an `onWhatsApp` lookup) every 60s and restarts the instance via
   the Evolution API on a confirmed zombie (restart re-establishes the socket
   from saved creds — no QR re-scan needed).
2. `watchdog.sh` (this folder) runs every minute from the `ubuntu` user's
   crontab on the VM and restarts the `evolution_api` container if the
   socket stays dead for 3+ checks — this covers failure modes an API-level
   restart cannot (wedged node process, Prisma/Postgres connectivity loss,
   hung API). State and logs live in `~/evolution-api/.watchdog/`.

The VM also has a 2 GB swapfile (`/swapfile`, persisted in `/etc/fstab`,
`vm.swappiness=10`) because memory pressure on the 1 GB instance caused
Postgres blackouts and socket stalls.

Verification:

1. Check the running image:
   `docker inspect evolution_api --format '{{.Config.Image}} {{.State.Health.Status}}'`
2. Check Baileys:
   `docker exec evolution_api node -e "console.log(require('/evolution/node_modules/baileys/package.json').version)"`
3. Send a test with `delay: 0`, then confirm `MessageUpdate.status` becomes
   `DELIVERY_ACK` or `READ`, not `ERROR`.

Important: WhatsApp Web/Baileys still depends on WhatsApp's private token rules.
For a contact that has no valid `tctoken`, the first attempted outbound may still
return `463`; a fresh inbound message from that contact is the safest way to
refresh token state. Official WhatsApp Cloud API is the long-term fully supported
path for cold outbound buyer notifications.

## Reply-address correction

The LID patch covers all compiled bundles, not just the component files. The
earlier component-only patch left `dist/main.js` and `dist/main.mjs` using the
phone lookup result as the reply destination. A LID is not a phone number, and
that result can point to a different phone JID. Explicit, syntactically valid
LIDs now skip that lookup and are passed unchanged to Baileys. Existing phone,
group and broadcast lookup/validation remains unchanged; backend order-owner
authorization is not changed or bypassed.

The patch validates every bundle and requires coverage of all four main and
component entries before writing anything. It upgrades the old partial patch
and can be safely re-run. Unknown compiled builds fail instead of receiving a
guessed replacement.

`tests/check-lid-reply-routing.js` executes those actual entry-point methods
with network sends stubbed, using the installed Baileys helpers. It covers both
Confirm and Cancel reply text, device/uppercase LIDs, normal phone lookup and
invalid addresses. It does not send a message or replay an order action. The
separate COD envelope check must still pass, preserving the original buttons.

## Sender identity and unintended self-delivery

The backend takes a reply destination only from the private sender envelope.
`contextInfo.participant`, quoted-message authors, mentions, contacts and
arbitrary nested message fields are content, not sender identity. In particular,
a reply to a bot message can correctly identify the buyer by phone while its
quoted participant is the bot's own LID. Using that participant as the reply
destination sends the response to the bot instead of the buyer.

Only an explicit inbound sender-envelope phone/LID pair can create a
`sender-envelope-v2` route. Routes are isolated by logical and physical instance
and expire after 24 hours. Legacy `webhook` and `evolution-message-store` records
are ignored, not deleted. Never restore a historical-message scan as a fallback.
If a route cannot be verified, use the authoritative phone JID, not a guessed LID.

`patches/patch-self-recipient-guard.js` adds a separate gateway safeguard. It
rejects explicit self-LIDs and unexpected phone-lookup redirects back to the
linked account. It preserves deliberately requested self-phone notifications.
It does not guess another customer, change a message, or apply an order action.
This containment cannot replace deployment of the backend parser correction.

The same patch adds minimal delivery-receipt logging to the existing fast
forwarding paths. Logs contain a message-id suffix, numeric status and address
type, not message bodies or recipient addresses. Numeric Baileys status `0` is
ERROR, `2` is server acceptance, `3` is device delivery and `4` is read. HTTP
success alone is not device-delivery evidence. The original receipt is forwarded
unchanged; receipt work must not block the inbound event queue.

Run the backend recipient-isolation and gateway guard tests, then
`tests/check-self-recipient-guard.js` inside the candidate gateway with network
sends stubbed. Cover all four main/component JS/MJS entries and retain the
existing LID-routing and exact button-envelope checks.

## COD reply-button envelope correction

`patches/patch-cod-reply-envelope.js` narrowly backports the interactive relay
correction documented in Evolution's `2.4.0-rc1` release. It does not upgrade
Evolution, change licensing, or replace confirmation buttons with links.

Only wrapped `quick_reply` messages are changed: their original interactive
content is relayed directly, with the required `biz/interactive/native_flow`
node and the generated message id. Titles, descriptions, amounts, button
labels, action ids and native-flow parameters are preserved. Text, existing
list fallback, media, CTA and PIX messages retain their previous paths.

The patch validates the compiled build before modifying it, syntax-checks all
changed bundles, and is safe to re-run. A mismatch fails the build instead of
applying a guessed replacement. The Dockerfile includes it for future builds.

Before release, run the backend `evolutionCodReplyEnvelope.test.js` tests and,
inside the candidate gateway image, `tests/check-cod-reply-envelope.js`. The
latter uses the actual installed Baileys protobuf encoder with network sends
stubbed; it does not contact a real phone or confirm/cancel any order. A real
recipient delivery check remains separate and must not be inferred from an
HTTP success response.

Upstream reference:
https://github.com/evolution-foundation/evolution-api/releases/tag/2.4.0-rc1
