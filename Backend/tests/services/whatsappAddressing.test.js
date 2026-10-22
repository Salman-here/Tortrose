'use strict';

const {
  ROUTE_SOURCE, LID_MAPPING_TTL_MS, phoneFromJid, canonicalPhone, canonicalJid,
  isGroupOrBroadcastJid, rememberPhoneLid, getRememberedLid, resolveReplyTo,
  toPhoneJid, collectAddressHints, resolveInboundAddress,
} = require('../../services/whatsapp/addressing');

const PHONE = '15550000001', PN = PHONE + '@s.whatsapp.net', LID = '155500000000001@lid';
const OWNER = '15550000000@s.whatsapp.net', OWNER_LID = '155500000000000@lid';
const CONTEXT = { participant: OWNER_LID, stanzaId: 'quoted-bot-message', remoteJid: OWNER };
const envelope = (key = {}, other = {}) => ({ key: { remoteJid: PN, fromMe: false, ...key }, ...other });

afterEach(() => jest.restoreAllMocks());

describe('sender-envelope-only WhatsApp addressing', () => {
  test.each([
    ['15550000001:3@s.whatsapp.net', PHONE], [PN, PHONE],
    ['+1 (555) 000-0001', PHONE], [LID, '155500000000001'],
  ])('extracts device-independent address digits from %s', (value, expected) => {
    expect(phoneFromJid(value)).toBe(expected);
  });

  test('never converts a LID, group or arbitrary message text to a phone JID', () => {
    for (const value of [LID, '123456789@g.us', 'Call 15550000001', '', null, '123']) {
      expect(canonicalPhone(value)).toBe('');
      expect(toPhoneJid(value)).toBe('');
    }
    expect(toPhoneJid('+1 555 000 0001')).toBe(PN);
    expect(canonicalJid(' 15550000001:2@S.WHATSAPP.NET ')).toBe(PN);
  });

  test.each([
    { remoteJid: LID, remoteJidAlt: PN },
    { remoteJid: PN, remoteJidAlt: LID },
    { remoteJid: LID, senderPn: PN },
    { remoteJid: LID, senderPn: PHONE },
    { remoteJid: LID, participantPn: PN },
    { remoteJid: '155500000000001:7@LID', remoteJidAlt: '15550000001:2@S.WHATSAPP.NET' },
  ])('binds a peer LID to the phone from the same inbound key: %j', key => {
    expect(resolveInboundAddress(envelope(key))).toMatchObject({
      identityPhone: PHONE, phoneJid: PN, replyTo: LID,
      verifiedPeerLid: true, routingSource: ROUTE_SOURCE, candidatePhones: [PHONE],
    });
  });

  test('supports the documented root sender-PN fields, not quoted participant metadata', () => {
    expect(resolveInboundAddress(envelope({ remoteJid: LID }, {
      participantPhone: '+1 555 000 0001', contextInfo: CONTEXT,
    }))).toMatchObject({ identityPhone: PHONE, replyTo: LID, verifiedPeerLid: true });
  });

  // De-identified shape of all four live Confirm/Cancel failures: both peer
  // key fields are the buyer's PN, while the quoted author is the bot's LID.
  test.each(['confirm', 'cancel'])('live %s regression: root quoted author cannot replace the buyer', action => {
    const message = envelope({ remoteJidAlt: PN }, {
      contextInfo: CONTEXT,
      message: { templateButtonReplyMessage: { selectedId: action + '_ORD-QA' } },
    });
    expect(resolveInboundAddress(message, { ownerPhone: OWNER })).toMatchObject({
      identityPhone: PHONE, replyTo: PN, lidJid: '', verifiedPeerLid: false,
      candidatePhones: [PHONE],
    });
  });

  test.each([
    { extendedTextMessage: { text: 'hello', contextInfo: CONTEXT } },
    { templateButtonReplyMessage: { selectedId: 'confirm_ORD-QA', contextInfo: CONTEXT } },
    { buttonsResponseMessage: { selectedButtonId: 'cancel_ORD-QA', contextInfo: CONTEXT } },
    { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify(CONTEXT) } } },
    { listResponseMessage: { singleSelectReply: { selectedRowId: 'confirm_ORD-QA' }, contextInfo: CONTEXT } },
    { imageMessage: { caption: 'look', contextInfo: CONTEXT } },
    { audioMessage: { ptt: true, contextInfo: CONTEXT } },
    { contactMessage: { vcard: 'TEL:' + PHONE, contextInfo: CONTEXT } },
    { conversation: '155500000000000@lid 15550000000@s.whatsapp.net' },
    { ephemeralMessage: { message: { extendedTextMessage: { contextInfo: CONTEXT } } } },
  ])('quotes, forwarded content, contacts and media cannot establish a recipient: %j', content => {
    const result = resolveInboundAddress(envelope({}, {
      message: content, contextInfo: CONTEXT, mentionedJid: [OWNER_LID],
      unknown: { sender: OWNER, senderAlt: OWNER_LID },
    }));
    expect(result.identityPhone).toBe(PHONE);
    expect(result.replyTo).toBe(PN);
    expect(result.lidJid).toBe('');
  });

  test('arbitrary nested hints cannot establish an identity when the sender is absent', () => {
    const result = resolveInboundAddress({ key: {}, message: { contextInfo: { sender: PN, senderAlt: LID } } });
    expect(result).toMatchObject({ identityPhone: '', replyTo: '', candidatePhones: [] });
    expect(collectAddressHints({ body: 'order 123456789', sender: PN, remoteAlt: LID })).toMatchObject({
      phoneNumbers: [], phoneJids: [], lidJids: [],
    });
  });

  test.each([true, 1, '1', 'true'])('own outbound message (%j) cannot identify an inbound actor', fromMe => {
    expect(resolveInboundAddress(envelope({ remoteJid: LID, remoteJidAlt: PN, fromMe })))
      .toMatchObject({ identityPhone: '', replyTo: '', verifiedPeerLid: false });
  });

  test.each([false, 0, '0', 'false'])('accepts an explicitly inbound peer pair (%j)', fromMe => {
    expect(resolveInboundAddress(envelope({ remoteJidAlt: LID, fromMe })).verifiedPeerLid).toBe(true);
  });

  test('missing fromMe can use the known phone, but cannot authorize a LID mapping', () => {
    const address = resolveInboundAddress({ key: { remoteJid: PN, remoteJidAlt: LID } });
    expect(address).toMatchObject({ identityPhone: PHONE, replyTo: PN, verifiedPeerLid: false });
  });

  test('ignores the instance owner even if present among key fields', () => {
    const address = resolveInboundAddress(envelope({ remoteJidAlt: OWNER }, {
      owner: OWNER, instance: { ownerJid: OWNER }, message: { conversation: 'hi' },
    }), { ownerPhone: OWNER, ownerLid: OWNER_LID });
    expect(address.identityPhone).toBe(PHONE);
    expect(address.replyTo).toBe(PN);
    expect(address.candidatePhones).toEqual([PHONE]);
  });

  test('does not route through the owner LID even if it appears as a peer hint', () => {
    expect(resolveInboundAddress(envelope({ remoteJidAlt: OWNER_LID }), { ownerPhone: OWNER, ownerLid: OWNER_LID }))
      .toMatchObject({ identityPhone: PHONE, replyTo: PN, verifiedPeerLid: false });
  });

  test.each([
    envelope({ remoteJid: LID }, { owner: OWNER }),
    envelope({ remoteJid: OWNER }, { owner: OWNER }),
    envelope({ remoteJidAlt: '15550000002@s.whatsapp.net' }),
    envelope({ remoteJid: '120363000000@g.us', senderPn: PN }),
    envelope({ remoteJidAlt: 'status@broadcast' }),
  ])('unknown, ambiguous or non-private senders fail closed: %j', message => {
    expect(resolveInboundAddress(message)).toMatchObject({ identityPhone: '', replyTo: '', verifiedPeerLid: false });
  });

  test('multiple peer LIDs cannot authorize either one', () => {
    expect(resolveInboundAddress(envelope({ remoteJidAlt: LID, senderLid: OWNER_LID })))
      .toMatchObject({ identityPhone: PHONE, replyTo: PN, verifiedPeerLid: false });
  });

  test('parsing an event does not pollute a shared route cache', () => {
    resolveInboundAddress(envelope({ remoteJidAlt: LID }));
    expect(getRememberedLid(PHONE, 'parser-must-not-write')).toBe('');
  });

  test('a cache entry needs explicit verification, stays scoped and expires', () => {
    const scope = 'address-cache-test';
    expect(rememberPhoneLid(PHONE, OWNER_LID, scope)).toBe(false);
    expect(resolveReplyTo(PHONE, OWNER_LID, scope)).toBe(PN);
    expect(rememberPhoneLid(PHONE, LID, scope, { verified: true })).toBe(true);
    expect(resolveReplyTo(PHONE, LID, scope)).toBe(LID);
    expect(resolveReplyTo(PHONE, OWNER_LID, scope)).toBe(PN);
    expect(resolveReplyTo(PHONE, PN, scope)).toBe(PN);
    expect(getRememberedLid(PHONE, 'other-instance')).toBe('');
    const later = Date.now() + LID_MAPPING_TTL_MS + 1;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect(resolveReplyTo(PHONE, LID, scope)).toBe(PN);
  });

  test('recognizes group and broadcast addresses', () => {
    expect(isGroupOrBroadcastJid('120363000@g.us')).toBe(true);
    expect(isGroupOrBroadcastJid('status@broadcast')).toBe(true);
    expect(isGroupOrBroadcastJid(PN)).toBe(false);
  });
});
