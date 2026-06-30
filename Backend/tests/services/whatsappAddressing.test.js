const {
  phoneFromJid,
  isGroupOrBroadcastJid,
  rememberPhoneLid,
  resolveReplyTo,
  resolveInboundAddress,
} = require('../../services/whatsapp/addressing');

describe('WhatsApp inbound addressing', () => {
  test('extracts digits from phone and LID JIDs', () => {
    expect(phoneFromJid('923001112222@s.whatsapp.net')).toBe('923001112222');
    expect(phoneFromJid('78220481290301@lid')).toBe('78220481290301');
    expect(phoneFromJid('+92 300 111 2222')).toBe('923001112222');
  });

  test('keeps LID chat as reply target while using phone JID for identity', () => {
    const address = resolveInboundAddress({
      key: {
        remoteJid: '78220481290301@lid',
        remoteJidAlt: '923028588506@s.whatsapp.net',
      },
    });

    expect(address.identityPhone).toBe('923028588506');
    expect(address.replyTo).toBe('78220481290301@lid');
    expect(address.candidatePhones).toEqual(['923028588506', '78220481290301']);
  });

  test('handles Evolution webhook payloads where phone and LID fields are reversed', () => {
    const address = resolveInboundAddress({
      key: {
        remoteJid: '923499166402@s.whatsapp.net',
        remoteJidAlt: '39767790104698@lid',
      },
    });

    expect(address.identityPhone).toBe('923499166402');
    expect(address.replyTo).toBe('39767790104698@lid');
    expect(address.candidatePhones).toEqual(['923499166402', '39767790104698']);
  });

  test('remembers a phone to LID mapping for later sends', () => {
    rememberPhoneLid('923499166402', '39767790104698@lid');

    expect(resolveReplyTo('923499166402', '923499166402@s.whatsapp.net')).toBe('39767790104698@lid');
    expect(resolveReplyTo('923499166402', '39767790104698@lid')).toBe('39767790104698@lid');
  });

  test('falls back cleanly for legacy phone-JID messages', () => {
    const address = resolveInboundAddress({
      key: { remoteJid: '923028588506@s.whatsapp.net' },
    });

    expect(address.identityPhone).toBe('923028588506');
    expect(address.replyTo).toBe('923028588506@s.whatsapp.net');
    expect(address.candidatePhones).toEqual(['923028588506']);
  });

  test('recognizes group and broadcast JIDs', () => {
    expect(isGroupOrBroadcastJid('120363000@g.us')).toBe(true);
    expect(isGroupOrBroadcastJid('status@broadcast')).toBe(true);
    expect(isGroupOrBroadcastJid('923001112222@s.whatsapp.net')).toBe(false);
  });
});
