export const MUTATION_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MUTATION_ATTEMPT_RECORD_VERSION = 2;
const MUTATION_ATTEMPT_RECORD_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const inProcessAttemptLocks = new Map();

export const createScopedMutationStorageKey = (baseKey, actorId = 'guest') => {
  const normalizedBaseKey = String(baseKey || '').trim();
  if (!normalizedBaseKey) throw new Error('A mutation attempt storage key is required.');
  const normalizedActorId = String(actorId || 'guest').trim() || 'guest';
  return `${normalizedBaseKey}:${encodeURIComponent(normalizedActorId)}`;
};

const bytesToHex = (bytes) => Array.from(bytes)
  .map(value => value.toString(16).padStart(2, '0'))
  .join('');

const digestHex = async (algorithm, value) => {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('Secure retry-key fingerprinting is unavailable.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    algorithm,
    new TextEncoder().encode(String(value)),
  );
  return bytesToHex(new Uint8Array(digest));
};

const createFingerprintIdentity = async (fingerprint) => ({
  // SHA-256 bounds key size and hides chat text from localStorage key names.
  // SHA-512 is an independent verifier: a primary collision fails closed
  // instead of aliasing another logical intent.
  digest: await digestHex('SHA-256', fingerprint),
  verifier: await digestHex('SHA-512', fingerprint),
});

const buildAttemptRecordStorageKey = (storageKey, digest) => (
  `${storageKey}:attempt-v2:${digest}`
);

export const createMutationAttemptRecordStorageKey = async (storageKey, fingerprint) => {
  const normalizedStorageKey = String(storageKey || '').trim();
  const normalizedFingerprint = String(fingerprint || '');
  if (!normalizedStorageKey || !normalizedFingerprint) {
    throw new Error('A mutation attempt storage key and fingerprint are required.');
  }
  const identity = await createFingerprintIdentity(normalizedFingerprint);
  return buildAttemptRecordStorageKey(normalizedStorageKey, identity.digest);
};

const normalizeChatMutationText = (text) => {
  const normalized = String(text || '').trim();
  return /^(?:y|yes|ok|okay|confirm|confirmed|proceed)$/i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
};

export const createChatMutationFingerprint = ({
  actorId = 'guest',
  currency = 'USD',
  text = '',
  attachments = [],
} = {}) => JSON.stringify({
  actorId: String(actorId || 'guest'),
  currency: String(currency || 'USD').trim().toUpperCase(),
  // History and conversationId are deliberately omitted. Both change after a
  // lost response; including either could rotate the key and apply one money
  // action twice. Identical unresolved confirmations replay/fail closed until
  // their exact attempt becomes terminal.
  text: normalizeChatMutationText(text),
  attachments: (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    name: String(attachment?.name || '').trim(),
    type: String(attachment?.type || attachment?.mimeType || '').trim().toLowerCase(),
    size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : 0,
    lastModified: Number.isFinite(Number(attachment?.lastModified ?? attachment?.file?.lastModified))
      ? Number(attachment.lastModified ?? attachment.file.lastModified)
      : 0,
    assetId: String(attachment?.assetId || '').trim(),
    uri: String(attachment?.uri || '').trim(),
  })),
});

export const isFreshMutationAttempt = (attempt, now = Date.now()) => (
  typeof attempt?.key === 'string'
  && attempt.key.length > 0
  && typeof attempt?.fingerprint === 'string'
  && Number(attempt?.createdAt) > now - MUTATION_ATTEMPT_MAX_AGE_MS
  && Number(attempt?.createdAt) <= now
);

const parseStoredValue = (raw) => {
  try {
    return JSON.parse(raw || 'null');
  } catch {
    return null;
  }
};

const readAttempt = (storage, storageKey) => parseStoredValue(storage?.getItem?.(storageKey));

const getLegacyAttempts = (storage, storageKey, now = Date.now()) => {
  const value = readAttempt(storage, storageKey);
  const candidates = Array.isArray(value?.attempts)
    ? value.attempts
    : (value?.key && value?.fingerprint ? [value] : []);
  return candidates.filter(attempt => isFreshMutationAttempt(attempt, now));
};

const readAttemptEnvelope = (storage, recordKey, fingerprint, identity) => {
  const value = parseStoredValue(storage?.getItem?.(recordKey));
  if (!value) return null;
  if (value.version === MUTATION_ATTEMPT_RECORD_VERSION) {
    if (
      value.fingerprintDigest !== identity.digest
      || value.fingerprintVerifier !== identity.verifier
    ) {
      throw new Error('A retry fingerprint storage collision was detected.');
    }
    const generation = Number(value.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('The persisted retry generation is invalid.');
    }
    if (value.retired === true && !value.attempt) {
      return { generation, attempt: null };
    }
    if (!value.attempt) {
      throw new Error('The persisted retry record is malformed.');
    }
    return {
      generation,
      attempt: {
        key: value.attempt.key,
        fingerprint,
        createdAt: value.attempt.createdAt,
      },
    };
  }
  // Compatibility with an early per-fingerprint draft.
  if (value?.key && value?.fingerprint) {
    if (value.fingerprint !== fingerprint) {
      throw new Error('A retry fingerprint storage collision was detected.');
    }
    return { generation: 0, attempt: value };
  }
  throw new Error('The persisted retry record is malformed.');
};

const createTerminalMarkerStorageKey = async (recordKey, attemptKey) => (
  `${recordKey}:terminal:${await digestHex('SHA-256', attemptKey)}`
);

const hasTerminalMarker = async (storage, recordKey, attempt, identity) => {
  if (!attempt?.key) return false;
  const marker = parseStoredValue(storage?.getItem?.(
    await createTerminalMarkerStorageKey(recordKey, attempt.key),
  ));
  if (!marker) return false;
  if (
    marker.version !== MUTATION_ATTEMPT_RECORD_VERSION
    || marker.fingerprintDigest !== identity.digest
    || marker.fingerprintVerifier !== identity.verifier
    || marker.key !== attempt.key
  ) {
    throw new Error('A completed retry marker collision was detected.');
  }
  return true;
};

const persistAndConfirmAttemptRecord = async (
  storage,
  recordKey,
  attempt,
  identity,
  generation,
) => {
  const existing = parseStoredValue(storage?.getItem?.(recordKey));
  if (
    existing?.version === MUTATION_ATTEMPT_RECORD_VERSION
    && (
      existing.fingerprintDigest !== identity.digest
      || existing.fingerprintVerifier !== identity.verifier
    )
  ) {
    throw new Error('A retry fingerprint storage collision was detected.');
  }
  storage.setItem(recordKey, JSON.stringify({
    version: MUTATION_ATTEMPT_RECORD_VERSION,
    fingerprintDigest: identity.digest,
    fingerprintVerifier: identity.verifier,
    generation,
    attempt: { key: attempt.key, createdAt: attempt.createdAt },
  }));
  const confirmed = readAttemptEnvelope(storage, recordKey, attempt.fingerprint, identity);
  if (
    confirmed?.generation !== generation
    || confirmed?.attempt?.key !== attempt.key
    || confirmed?.attempt?.createdAt !== attempt.createdAt
  ) {
    throw new Error('The retry key could not be confirmed in persistent storage.');
  }
};

const persistAndConfirmTerminalMarker = async (
  storage,
  recordKey,
  attempt,
  identity,
  now,
) => {
  const markerKey = await createTerminalMarkerStorageKey(recordKey, attempt.key);
  const existing = parseStoredValue(storage?.getItem?.(markerKey));
  if (
    existing
    && (
      existing.key !== attempt.key
      || existing.fingerprintDigest !== identity.digest
      || existing.fingerprintVerifier !== identity.verifier
    )
  ) {
    throw new Error('A completed retry marker collision was detected.');
  }
  const marker = {
    version: MUTATION_ATTEMPT_RECORD_VERSION,
    fingerprintDigest: identity.digest,
    fingerprintVerifier: identity.verifier,
    key: attempt.key,
    clearedAt: now,
  };
  storage.setItem(markerKey, JSON.stringify(marker));
  const confirmed = parseStoredValue(storage.getItem(markerKey));
  if (
    confirmed?.version !== marker.version
    || confirmed?.fingerprintDigest !== marker.fingerprintDigest
    || confirmed?.fingerprintVerifier !== marker.fingerprintVerifier
    || confirmed?.key !== marker.key
    || confirmed?.clearedAt !== marker.clearedAt
  ) {
    throw new Error('The completed retry key could not be confirmed in persistent storage.');
  }
};

const cleanupExpiredAttemptRecords = (storage, storageKey, now) => {
  if (!Number.isSafeInteger(storage?.length) || typeof storage?.key !== 'function') return;
  const prefix = `${storageKey}:attempt-v2:`;
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) {
    const value = parseStoredValue(storage.getItem(key));
    const expiredTerminal = key.includes(':terminal:')
      && Number(value?.clearedAt) <= now - MUTATION_ATTEMPT_MAX_AGE_MS;
    const expiredRecord = !key.includes(':terminal:')
      && Number(value?.attempt?.createdAt) <= now - MUTATION_ATTEMPT_RECORD_RETENTION_MS;
    if (expiredTerminal) {
      try { storage.removeItem(key); } catch { /* best-effort bounded cleanup */ }
    } else if (expiredRecord) {
      // Backend financial idempotency keys are durable. Deleting the last
      // generation would eventually let an identical fingerprint reuse `:0`
      // and replay an old order/top-up/withdrawal. Keep only a compact
      // generation tombstone; the next attempt deterministically advances it
      // while old attempt details and terminal markers are discarded.
      const generation = Number(value?.generation);
      if (
        value?.version === MUTATION_ATTEMPT_RECORD_VERSION
        && Number.isSafeInteger(generation)
        && generation >= 0
        && typeof value?.fingerprintDigest === 'string'
        && typeof value?.fingerprintVerifier === 'string'
      ) {
        try {
          storage.setItem(key, JSON.stringify({
            version: MUTATION_ATTEMPT_RECORD_VERSION,
            fingerprintDigest: value.fingerprintDigest,
            fingerprintVerifier: value.fingerprintVerifier,
            generation,
            retired: true,
            retiredAt: now,
          }));
        } catch { /* best-effort compaction; retaining the old record is safe */ }
      }
    }
  }
};

const migrateLegacyAttemptRecords = async (storage, storageKey, now) => {
  // Preserve the legacy blob for its 24-hour lifetime. Deleting/RMWing it could
  // race an old open tab and erase a request that already reached the server.
  for (const legacyAttempt of getLegacyAttempts(storage, storageKey, now)) {
    const identity = await createFingerprintIdentity(legacyAttempt.fingerprint);
    const recordKey = buildAttemptRecordStorageKey(storageKey, identity.digest);
    if (await hasTerminalMarker(storage, recordKey, legacyAttempt, identity)) continue;
    const existing = readAttemptEnvelope(
      storage,
      recordKey,
      legacyAttempt.fingerprint,
      identity,
    );
    if (existing) {
      if (!existing.attempt || existing.attempt.key !== legacyAttempt.key) {
        throw new Error('Conflicting persisted retry keys require manual resolution.');
      }
      continue;
    }
    await persistAndConfirmAttemptRecord(storage, recordKey, legacyAttempt, identity, 0);
  }
};

const withInProcessAttemptLock = (lockKey, operation) => {
  const previous = inProcessAttemptLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  inProcessAttemptLocks.set(lockKey, current);
  return current.finally(() => {
    if (inProcessAttemptLocks.get(lockKey) === current) inProcessAttemptLocks.delete(lockKey);
  });
};

const withAttemptRecordLock = (recordKey, operation) => {
  const lockName = `rozare-mutation-attempt:${recordKey}`;
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request(lockName, { mode: 'exclusive' }, operation);
  }
  // Without Web Locks, concurrent creators derive the same generation key.
  // An overwritten readback aborts; two successful reads still send one shared
  // backend idempotency key, never two independently generated keys.
  return withInProcessAttemptLock(lockName, operation);
};

export const clearPersistedMutationAttempt = (storage, storageKey) => {
  try {
    storage?.removeItem?.(storageKey);
    return true;
  } catch {
    return false;
  }
};

export const getOrCreatePersistedMutationAttempt = ({
  storage,
  storageKey,
  fingerprint,
  keyPrefix,
  randomUUID,
  now = Date.now(),
}) => {
  if (!storage || !storageKey || !fingerprint || !keyPrefix) {
    throw new Error('A persistent mutation attempt store is required.');
  }
  const saved = readAttempt(storage, storageKey);
  if (saved?.fingerprint === fingerprint && isFreshMutationAttempt(saved, now)) return saved;
  if (saved) clearPersistedMutationAttempt(storage, storageKey);
  const entropy = typeof randomUUID === 'function'
    ? randomUUID()
    : globalThis.crypto?.randomUUID?.();
  if (!entropy) throw new Error('Secure retry-key generation is unavailable.');
  const attempt = { key: `${keyPrefix}:${entropy}`, fingerprint, createdAt: now };
  storage.setItem(storageKey, JSON.stringify(attempt));
  const confirmed = readAttempt(storage, storageKey);
  if (
    confirmed?.key !== attempt.key
    || confirmed?.fingerprint !== attempt.fingerprint
    || confirmed?.createdAt !== attempt.createdAt
  ) {
    throw new Error('The retry key could not be confirmed in persistent storage.');
  }
  return attempt;
};

export const getOrCreatePersistedMutationAttemptForFingerprint = async ({
  storage,
  storageKey,
  fingerprint,
  keyPrefix,
  now = Date.now(),
}) => {
  if (!storage || !storageKey || !fingerprint || !keyPrefix) {
    throw new Error('A persistent mutation attempt store is required.');
  }
  const identity = await createFingerprintIdentity(fingerprint);
  const recordKey = buildAttemptRecordStorageKey(storageKey, identity.digest);
  return withAttemptRecordLock(recordKey, async () => {
    cleanupExpiredAttemptRecords(storage, storageKey, now);
    await migrateLegacyAttemptRecords(storage, storageKey, now);
    const envelope = readAttemptEnvelope(storage, recordKey, fingerprint, identity);
    if (
      envelope
      && envelope.attempt
      && isFreshMutationAttempt(envelope.attempt, now)
      && !(await hasTerminalMarker(storage, recordKey, envelope.attempt, identity))
    ) {
      return envelope.attempt;
    }
    const generation = envelope ? envelope.generation + 1 : 0;
    const attempt = {
      key: `${keyPrefix}:v2:${identity.digest}:${generation}`,
      fingerprint,
      createdAt: now,
    };
    await persistAndConfirmAttemptRecord(
      storage,
      recordKey,
      attempt,
      identity,
      generation,
    );
    return attempt;
  });
};

export const clearPersistedMutationAttemptForFingerprint = async (
  storage,
  storageKey,
  fingerprint,
  expectedAttemptKey,
  now = Date.now(),
) => {
  if (!storage || !storageKey || !fingerprint || !expectedAttemptKey) return false;
  const identity = await createFingerprintIdentity(fingerprint);
  const recordKey = buildAttemptRecordStorageKey(storageKey, identity.digest);
  return withAttemptRecordLock(recordKey, async () => {
    try {
      cleanupExpiredAttemptRecords(storage, storageKey, now);
      const envelope = readAttemptEnvelope(storage, recordKey, fingerprint, identity);
      if (envelope) {
        // A return may outlive the generation that created it. Never let an
        // older completion terminalize the newer generation now persisted for
        // the same fingerprint.
        if (envelope.attempt?.key !== expectedAttemptKey) return false;
        await persistAndConfirmTerminalMarker(storage, recordKey, envelope.attempt, identity, now);
        return true;
      }

      // Compatibility is intentionally limited to an exact legacy key and is
      // considered only when no v2 record exists. A marker from an old tab can
      // therefore never clear or supersede a v2 generation.
      const legacyAttempt = getLegacyAttempts(storage, storageKey, now).find(attempt => (
        attempt.fingerprint === fingerprint && attempt.key === expectedAttemptKey
      ));
      if (!legacyAttempt) return false;
      await persistAndConfirmTerminalMarker(storage, recordKey, legacyAttempt, identity, now);
      return true;
    } catch {
      return false;
    }
  });
};

export const getOrCreatePersistedMutationAttemptInLedger = (
  options,
) => getOrCreatePersistedMutationAttemptForFingerprint(options);
export const clearPersistedMutationAttemptFromLedger = (
  ...args
) => clearPersistedMutationAttemptForFingerprint(...args);
