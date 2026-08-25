import * as Crypto from 'expo-crypto';

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

const digestHex = (algorithm, value) => Crypto.digestStringAsync(
  algorithm,
  String(value),
  { encoding: Crypto.CryptoEncoding.HEX },
);

const createFingerprintIdentity = async (fingerprint) => ({
  // The bounded SHA-256 key contains no chat text. The independent SHA-512
  // verifier makes a primary-digest collision fail closed rather than aliasing
  // two intents.
  digest: await digestHex(Crypto.CryptoDigestAlgorithm.SHA256, fingerprint),
  verifier: await digestHex(Crypto.CryptoDigestAlgorithm.SHA512, fingerprint),
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
  // History/conversationId are intentionally excluded: they change after a
  // lost response. Identical unresolved confirmations must replay/fail closed
  // until their exact attempt becomes terminal.
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
  } catch (_) {
    return null;
  }
};

export const clearPersistedMutationAttempt = async (storage, storageKey) => {
  try {
    if (storage?.removeItem) await storage.removeItem(storageKey);
    return true;
  } catch (_) {
    return false;
  }
};

export const getOrCreatePersistedMutationAttempt = async ({
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
  const saved = parseStoredValue(await storage.getItem(storageKey));
  if (saved?.fingerprint === fingerprint && isFreshMutationAttempt(saved, now)) return saved;
  if (saved) await clearPersistedMutationAttempt(storage, storageKey);
  const entropy = typeof randomUUID === 'function' ? randomUUID() : null;
  if (!entropy) throw new Error('Secure retry-key generation is unavailable.');
  const attempt = { key: `${keyPrefix}:${entropy}`, fingerprint, createdAt: now };
  await storage.setItem(storageKey, JSON.stringify(attempt));
  const confirmed = parseStoredValue(await storage.getItem(storageKey));
  if (
    confirmed?.key !== attempt.key
    || confirmed?.fingerprint !== attempt.fingerprint
    || confirmed?.createdAt !== attempt.createdAt
  ) {
    throw new Error('The retry key could not be confirmed in persistent storage.');
  }
  return attempt;
};

const getLegacyAttempts = async (storage, storageKey, now = Date.now()) => {
  const value = parseStoredValue(await storage.getItem(storageKey));
  const candidates = Array.isArray(value?.attempts)
    ? value.attempts
    : (value?.key && value?.fingerprint ? [value] : []);
  return candidates.filter(attempt => isFreshMutationAttempt(attempt, now));
};

const readAttemptEnvelope = async (storage, recordKey, fingerprint, identity) => {
  const value = parseStoredValue(await storage.getItem(recordKey));
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
  if (value?.key && value?.fingerprint) {
    if (value.fingerprint !== fingerprint) {
      throw new Error('A retry fingerprint storage collision was detected.');
    }
    return { generation: 0, attempt: value };
  }
  throw new Error('The persisted retry record is malformed.');
};

const createTerminalMarkerStorageKey = async (recordKey, attemptKey) => (
  `${recordKey}:terminal:${await digestHex(Crypto.CryptoDigestAlgorithm.SHA256, attemptKey)}`
);

const hasTerminalMarker = async (storage, recordKey, attempt, identity) => {
  if (!attempt?.key) return false;
  const marker = parseStoredValue(await storage.getItem(
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
  const existing = parseStoredValue(await storage.getItem(recordKey));
  if (
    existing?.version === MUTATION_ATTEMPT_RECORD_VERSION
    && (
      existing.fingerprintDigest !== identity.digest
      || existing.fingerprintVerifier !== identity.verifier
    )
  ) {
    throw new Error('A retry fingerprint storage collision was detected.');
  }
  await storage.setItem(recordKey, JSON.stringify({
    version: MUTATION_ATTEMPT_RECORD_VERSION,
    fingerprintDigest: identity.digest,
    fingerprintVerifier: identity.verifier,
    generation,
    attempt: { key: attempt.key, createdAt: attempt.createdAt },
  }));
  const confirmed = await readAttemptEnvelope(
    storage,
    recordKey,
    attempt.fingerprint,
    identity,
  );
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
  const existing = parseStoredValue(await storage.getItem(markerKey));
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
  await storage.setItem(markerKey, JSON.stringify(marker));
  const confirmed = parseStoredValue(await storage.getItem(markerKey));
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

const cleanupExpiredAttemptRecords = async (storage, storageKey, now) => {
  if (typeof storage?.getAllKeys !== 'function') return;
  const prefix = `${storageKey}:attempt-v2:`;
  let keys = [];
  try {
    keys = (await storage.getAllKeys()).filter(key => key.startsWith(prefix));
  } catch (_) {
    return;
  }
  for (const key of keys) {
    try {
      const value = parseStoredValue(await storage.getItem(key));
      const expiredTerminal = key.includes(':terminal:')
        && Number(value?.clearedAt) <= now - MUTATION_ATTEMPT_MAX_AGE_MS;
      const expiredRecord = !key.includes(':terminal:')
        && Number(value?.attempt?.createdAt) <= now - MUTATION_ATTEMPT_RECORD_RETENTION_MS;
      if (expiredTerminal) {
        await storage.removeItem(key);
      } else if (expiredRecord) {
        const generation = Number(value?.generation);
        if (
          value?.version === MUTATION_ATTEMPT_RECORD_VERSION
          && Number.isSafeInteger(generation)
          && generation >= 0
          && typeof value?.fingerprintDigest === 'string'
          && typeof value?.fingerprintVerifier === 'string'
        ) {
          // Never recycle a backend idempotency key after local cleanup.
          // Retain only the generation/verifier tombstone and advance it on
          // the next identical intent.
          await storage.setItem(key, JSON.stringify({
            version: MUTATION_ATTEMPT_RECORD_VERSION,
            fingerprintDigest: value.fingerprintDigest,
            fingerprintVerifier: value.fingerprintVerifier,
            generation,
            retired: true,
            retiredAt: now,
          }));
        }
      }
    } catch (_) {
      // Cleanup is bounded best effort; mutation persistence still fails closed.
    }
  }
};

const migrateLegacyAttemptRecords = async (storage, storageKey, now) => {
  // Preserve the legacy blob for its 24-hour lifetime. Removing/RMWing it could
  // race an old app process and erase a request that already reached the server.
  for (const legacyAttempt of await getLegacyAttempts(storage, storageKey, now)) {
    const identity = await createFingerprintIdentity(legacyAttempt.fingerprint);
    const recordKey = buildAttemptRecordStorageKey(storageKey, identity.digest);
    if (await hasTerminalMarker(storage, recordKey, legacyAttempt, identity)) continue;
    const existing = await readAttemptEnvelope(
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

const withAttemptRecordLock = (lockKey, operation) => {
  const previous = inProcessAttemptLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  inProcessAttemptLocks.set(lockKey, current);
  return current.finally(() => {
    if (inProcessAttemptLocks.get(lockKey) === current) inProcessAttemptLocks.delete(lockKey);
  });
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
    await cleanupExpiredAttemptRecords(storage, storageKey, now);
    await migrateLegacyAttemptRecords(storage, storageKey, now);
    const envelope = await readAttemptEnvelope(storage, recordKey, fingerprint, identity);
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
      await cleanupExpiredAttemptRecords(storage, storageKey, now);
      const envelope = await readAttemptEnvelope(storage, recordKey, fingerprint, identity);
      if (envelope) {
        // A late result from generation N must not terminalize generation N+1
        // for the same logical intent.
        if (envelope.attempt?.key !== expectedAttemptKey) return false;
        await persistAndConfirmTerminalMarker(storage, recordKey, envelope.attempt, identity, now);
        return true;
      }

      // Legacy compatibility is exact-key only and is disabled as soon as a
      // v2 record exists, so an old app process cannot clear a new attempt.
      const legacyAttempt = (await getLegacyAttempts(storage, storageKey, now)).find(attempt => (
        attempt.fingerprint === fingerprint && attempt.key === expectedAttemptKey
      ));
      if (!legacyAttempt) return false;
      await persistAndConfirmTerminalMarker(storage, recordKey, legacyAttempt, identity, now);
      return true;
    } catch (_) {
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
