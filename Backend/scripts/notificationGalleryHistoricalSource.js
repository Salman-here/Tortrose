'use strict';

// Offline comparison adapter. It only reads a pinned Git commit and evaluates
// the audited preview builders in an isolated Node process. It never imports a
// controller, sends a notification, opens a database or changes Git state.
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.resolve(__dirname, '..');
const BASELINE = 'a665fa0fa496a68dd820cf273f2b811ec58e5978';
const CHANNELS = new Set(['email', 'whatsapp', 'inapp', 'push']);

function comparisonKey(entry) {
  if (!entry || !CHANNELS.has(entry.channel) || typeof entry.name !== 'string'
    || !entry.name.trim() || entry.name !== entry.name.trim() || entry.name.length > 300) {
    throw new Error('Historical gallery entry identity is invalid.');
  }
  return `${entry.channel}:${entry.name}`;
}

function verifiedRevision(revision) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('Historical gallery requires a full pinned Git commit.');
  }
  const actual = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
  if (actual !== revision) throw new Error('Historical gallery revision is not the expected commit.');
  return revision;
}

function validateHistoricalEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 1500) throw new Error('Historical preview list is invalid.');
  const identities = new Set();
  for (const entry of entries) {
    const key = comparisonKey(entry);
    if (identities.has(key)) throw new Error(`Duplicate historical gallery identity: ${key}`);
    identities.add(key);
    if (typeof entry.sourcePath !== 'string' || !/^Backend\/(?:services|controllers|utils)\//.test(entry.sourcePath)
      || entry.sourcePath.includes('..') || !Number.isInteger(entry.sourceLine) || entry.sourceLine < 1) {
      throw new Error(`Historical source provenance is invalid: ${key}`);
    }
    const snapshot = entry.after;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error(`Historical snapshot is invalid: ${key}`);
    }
    if (entry.channel === 'email') {
      if (typeof snapshot.subject !== 'string' || !snapshot.subject.trim()
        || typeof snapshot.html !== 'string' || !snapshot.html.trim()) {
        throw new Error(`Historical email is empty: ${key}`);
      }
    } else if ((typeof snapshot.message !== 'string' || !snapshot.message.trim())
      && !(entry.activity === 'legacy' && typeof snapshot.title === 'string' && snapshot.title.trim()
        && Array.isArray(snapshot.buttons) && snapshot.buttons.length > 0)) {
      throw new Error(`Historical message is empty: ${key}`);
    }
    if (snapshot.buttons !== undefined && (!Array.isArray(snapshot.buttons)
      || snapshot.buttons.some(label => typeof label !== 'string'))) {
      throw new Error(`Historical action labels are invalid: ${key}`);
    }
  }
  return entries;
}

function parseHistoricalCapture(stdout, revision = BASELINE) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('Historical preview output is not valid JSON.'); }
  if (result?.revision !== revision || result?.sourceModes?.runtime !== revision
    || result?.sourceModes?.whatsapp !== revision || result?.sourceModes?.oldEmail !== true) {
    throw new Error('Historical preview did not use the pinned source and original email presentation.');
  }
  return validateHistoricalEntries(result.entries);
}

async function readHistoricalSourceEntries({ revision = BASELINE } = {}) {
  verifiedRevision(revision);
  // Do not hand production keys or dotenv selectors to the offline child.
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.ROZARE_GALLERY_SOURCE_REVISION = revision;
  env.ROZARE_GALLERY_OLD_EMAIL = 'true';
  const script = `
    (async () => {
      const runtime = require('./scripts/runtimeNotificationGallery');
      const fixed = require('./scripts/whatsappFixedGalleryEntries');
      const entries = [
        ...await runtime.buildRuntimeNotificationGalleryEntries({ includeApp: true }),
        ...fixed.buildFixedWhatsAppGalleryEntries({ includeBefore: false })
      ];
      process.stdout.write(JSON.stringify({
        revision: process.env.ROZARE_GALLERY_SOURCE_REVISION,
        sourceModes: { runtime: runtime.sourceRevision, whatsapp: fixed.sourceRevision, oldEmail: runtime.oldEmailMode },
        entries
      }));
    })().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
  `;
  const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
    cwd: BACKEND, env, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 60000,
    windowsHide: true,
  });
  return parseHistoricalCapture(stdout, revision);
}

function snapshotContent(channel, snapshot) {
  if (channel === 'email') return { subject: snapshot.subject || '', html: snapshot.html || '' };
  return { title: snapshot.title || '', message: snapshot.message || '', footer: snapshot.footer || '', buttons: snapshot.buttons || [], linkTo: snapshot.linkTo || '' };
}

function mergeHistoricalComparisons(entries, historicalEntries, { revision = BASELINE } = {}) {
  if (!Array.isArray(entries)) throw new Error('Current gallery list is invalid.');
  const historical = new Map(validateHistoricalEntries(historicalEntries).map(entry => [comparisonKey(entry), entry]));
  const stats = { revision, recovered: 0, preserved: 0, unavailable: 0, missing: [] };
  const result = entries.map(entry => {
    const key = comparisonKey(entry);
    // Direct account templates and WhatsApp entries already carry genuine
    // earlier comparisons. Keep those snapshots and their earlier provenance.
    if (entry.before) {
      stats.preserved += 1;
      return { ...entry, changed: JSON.stringify(snapshotContent(entry.channel, entry.before))
        !== JSON.stringify(snapshotContent(entry.channel, entry.after)) };
    }
    const old = historical.get(key);
    const sameSource = old && entry.sourcePath === old.sourcePath
      && (!entry.audienceRole || !old.audienceRole || entry.audienceRole === old.audienceRole)
      && (!entry.eventType || !old.eventType || entry.eventType === old.eventType);
    if (!sameSource) {
      stats.unavailable += 1;
      stats.missing.push(key);
      return { ...entry, comparison: 'No verified old version', historicalBaselineChecked: revision };
    }
    stats.recovered += 1;
    const before = { ...old.after, ...(old.after.buttons ? { buttons: [...old.after.buttons] } : {}) };
    return { ...entry, before, sourceBaseline: revision, historicalSourcePath: old.sourcePath,
      historicalSourceLine: old.sourceLine, comparison: 'Source snapshot',
      changed: JSON.stringify(snapshotContent(entry.channel, before))
        !== JSON.stringify(snapshotContent(entry.channel, entry.after)) };
  });
  Object.defineProperty(result, 'historicalCoverage', { value: stats, enumerable: false });
  return result;
}

async function attachHistoricalComparisons(entries, { revision = BASELINE } = {}) {
  const historicalEntries = await readHistoricalSourceEntries({ revision });
  return mergeHistoricalComparisons(entries, historicalEntries, { revision });
}

module.exports = { BASELINE, comparisonKey, verifiedRevision, validateHistoricalEntries,
  parseHistoricalCapture, readHistoricalSourceEntries, mergeHistoricalComparisons, attachHistoricalComparisons };
