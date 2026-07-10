# Evolution API Runtime

Rozare runs Evolution API on the Oracle VM from this folder.

The `evolution-api` service intentionally builds a local image instead of using
the upstream image directly:

- Base: `evoapicloud/evolution-api:v2.3.7`
- Baileys: upgraded to `7.0.0-rc13`
- Patch: preserve explicit `@lid` reply targets in the Baileys send path
- Patch: release Baileys' inbound event queue immediately after the
  `MESSAGES_UPSERT` webhook so contact/profile sync cannot delay the next
  inbound message
- Patch: bypass normal `MESSAGES_UPDATE` work in Rozare transport mode so
  delivery/read receipts cannot block subsequent inbound messages in the same
  serial Baileys event queue

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
