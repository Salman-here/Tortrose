let unauthorizedHandler = null;
let pendingUnauthorized = false;
let unauthorizedCleanup = null;

const runPendingUnauthorized = () => {
  if (!pendingUnauthorized || !unauthorizedHandler) return Promise.resolve(false);
  if (unauthorizedCleanup) return unauthorizedCleanup;

  pendingUnauthorized = false;
  unauthorizedCleanup = Promise.resolve()
    .then(() => unauthorizedHandler())
    .then(() => true)
    .finally(() => {
      unauthorizedCleanup = null;
      if (pendingUnauthorized && unauthorizedHandler) runPendingUnauthorized();
    });
  return unauthorizedCleanup;
};

export function registerUnauthorizedSessionHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null;
  if (unauthorizedHandler && pendingUnauthorized) runPendingUnauthorized();
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export function notifyUnauthorizedSession() {
  pendingUnauthorized = true;
  return runPendingUnauthorized();
}
