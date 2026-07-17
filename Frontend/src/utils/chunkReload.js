// Recovery for stale hashed chunks after a deployment.
//
// When a new version is deployed, all /assets/*-<hash>.js filenames change.
// A tab that was opened before the deploy will eventually lazy-load a route
// chunk whose old filename no longer exists — the request fails (or the SPA
// fallback returns index.html with a text/html MIME type) and the app crashes
// to the error boundary. A reload always fixes it because the fresh index.html
// references the new hashes. So: reload automatically, at most once per
// window, and let the error boundary handle anything that persists.

const KEY = 'rozare_chunk_reload_at';
const MIN_INTERVAL_MS = 30 * 1000;

export function isStaleChunkError(error) {
  const text = String(error?.message || error || '');
  return /dynamically imported module|Importing a module script|module script failed|Expected a JavaScript.*module|Failed to fetch dynamically/i.test(text);
}

// Returns true if a reload was triggered.
export function reloadOnceForStaleChunk() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) || 0);
  } catch { /* storage unavailable — still allow one reload */ }
  if (Date.now() - last < MIN_INTERVAL_MS) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* ignore */ }
  window.location.reload();
  return true;
}
