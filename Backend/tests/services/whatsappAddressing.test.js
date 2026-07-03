const {
  phoneFromJid,
  isGroupOrBroadcastJid,
  rememberPhoneLid,
  resolveReplyTo,
  toPhoneJid,
  collectAddressHints,
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

  test('prefers explicit phone JID over unrelated bare numeric fields', () => {
    const address = resolveInboundAddress({
      key: {
        remoteJid: '923499166402@s.whatsapp.net',
      },
      message: {
        conversation: 'Hi',
        contextInfo: {
          owner: '39767790104698',
        },
      },
    });

    expect(address.identityPhone).toBe('923499166402');
    expect(address.replyTo).toBe('923499166402@s.whatsapp.net');
    expect(address.candidatePhones[0]).toBe('923499166402');
    expect(address.candidatePhones).toContain('39767790104698');
  });

  test('finds phone and LID hints nested inside unknown Evolution payload fields', () => {
    const address = resolveInboundAddress({
      key: {},
      message: {
        contextInfo: {
          sender: '923499166402@s.whatsapp.net',
          senderAlt: '39767790104698@lid',
        },
      },
    });

    expect(address.identityPhone).toBe('923499166402');
    expect(address.replyTo).toBe('39767790104698@lid');
    expect(address.candidatePhones).toContain('923499166402');
  });

  test('uses bare phone fields as identity when only a LID JID is explicit', () => {
    const address = resolveInboundAddress({
      key: { remoteJid: '39767790104698@lid' },
      pushName: 'Buyer',
      participantPhone: '+92 349 916 6402',
    });

    expect(address.identityPhone).toBe('923499166402');
    expect(address.replyTo).toBe('39767790104698@lid');
    expect(address.candidatePhones).toContain('923499166402');
  });

  test('collects address hints without treating unrelated text as phone numbers', () => {
    const hints = collectAddressHints({
      body: 'order 123456789 should not be a phone',
      sender: '923499166402@s.whatsapp.net',
      remoteAlt: '39767790104698@lid',
    });

    expect(hints.phoneJids).toEqual(['923499166402@s.whatsapp.net']);
    expect(hints.lidJids).toEqual(['39767790104698@lid']);
    expect(hints.phoneNumbers).toContain('923499166402');
    expect(hints.phoneNumbers).not.toContain('123456789');
  });

  test('builds explicit phone JID for proactive outbound sends', () => {
    expect(toPhoneJid('+92 349 9166402')).toBe('923499166402@s.whatsapp.net');
    expect(toPhoneJid('923499166402@s.whatsapp.net')).toBe('923499166402@s.whatsapp.net');
    expect(toPhoneJid('')).toBe('');
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
