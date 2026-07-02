// Thin wrapper around the Evolution API REST endpoints (v2.x).
// Docs: https://doc.evolution-api.com/v2/
//
// Key differences from v1.7.4:
//   - Message payloads are flat: { number, text } instead of { number, textMessage: { text } }
//   - Poll payload is flat:      { number, name, values, selectableCount } instead of nested pollMessage
//   - /instance/connect returns  { pairingCode, code, count } where `code` is the raw QR string
//     (we convert it to a PNG data URL with the `qrcode` npm package so the admin UI can render it)
//   - /instance/fetchInstances returns [{ instance: { status: 'open'|'close'|'connecting', ... }}]
//     (no qrcode field here — only connection state)
//   - /webhook/set on v2.3.x uses { webhook: { enabled, url, webhookByEvents, webhookBase64, events } }

const createEvolutionClient = require('./createEvolutionClient');
const { useUnifiedWhatsAppInstance } = require('./gatewayMode');

module.exports = useUnifiedWhatsAppInstance()
    ? createEvolutionClient('EVOLUTION_SELLER_INSTANCE_NAME', 'rozare-seller')
    : createEvolutionClient('EVOLUTION_INSTANCE_NAME', 'rozare-main');
