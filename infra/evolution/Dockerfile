FROM evoapicloud/evolution-api:v2.3.7

WORKDIR /evolution

# Baileys rc13 contains the current 463/token-recovery behavior needed for
# WhatsApp Web linked-device sends after Meta's LID/tctoken changes.
RUN npm install baileys@7.0.0-rc13 --omit=dev --no-audit --no-fund

COPY patches/patch-baileys-lid-send.js /tmp/patch-baileys-lid-send.js
RUN node /tmp/patch-baileys-lid-send.js && rm /tmp/patch-baileys-lid-send.js

COPY patches/patch-rozare-fast-inbound-webhook.js /tmp/patch-rozare-fast-inbound-webhook.js
RUN node /tmp/patch-rozare-fast-inbound-webhook.js && rm /tmp/patch-rozare-fast-inbound-webhook.js
