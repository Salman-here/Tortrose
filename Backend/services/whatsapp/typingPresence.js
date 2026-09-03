'use strict';

const DEFAULT_START_DELAY_MS = 500;
const DEFAULT_PULSE_MS = 10_000;
const DEFAULT_MAX_DURATION_MS = 90_000;
const PULSE_RENEWAL_GAP_MS = 250;

const boundedIntegerFromEnv = (name, fallback, min, max) => {
    const parsed = Number.parseInt(process.env[name], 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const envEnabled = (name, fallback = true) => {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
};

const unrefTimer = timer => timer?.unref?.();

/**
 * Starts a best-effort WhatsApp typing indicator without ever blocking the AI
 * request or the reply. The short start threshold prevents a distracting flash
 * for responses that are already ready, while renewed finite pulses cover real
 * AI/tool latency. Presence failures are deliberately isolated from delivery.
 */
function startTypingPresence({ client, recipient, logger = console } = {}) {
    const noOp = {
        stop() {},
        restoreOnlineAfterReply() {},
    };
    if (
        !envEnabled('WHATSAPP_AI_TYPING_ENABLED', true) ||
        !recipient ||
        typeof client?.sendChatPresence !== 'function'
    ) {
        return noOp;
    }

    const startDelayMs = boundedIntegerFromEnv(
        'WHATSAPP_AI_TYPING_START_DELAY_MS',
        DEFAULT_START_DELAY_MS,
        0,
        5_000
    );
    const pulseMs = boundedIntegerFromEnv(
        'WHATSAPP_AI_TYPING_PULSE_MS',
        DEFAULT_PULSE_MS,
        2_000,
        20_000
    );
    const maxDurationMs = boundedIntegerFromEnv(
        'WHATSAPP_AI_TYPING_MAX_MS',
        DEFAULT_MAX_DURATION_MS,
        pulseMs,
        5 * 60_000
    );
    let stopped = false;
    let started = false;
    let presenceUnavailable = false;
    let virtualRecipient = false;
    let availabilityFailureLogged = false;
    let startTimer = null;
    let renewalTimer = null;
    let maximumTimer = null;
    let availabilityRestoreQueue = Promise.resolve();

    const stopTimers = () => {
        if (startTimer) clearTimeout(startTimer);
        if (renewalTimer) clearTimeout(renewalTimer);
        if (maximumTimer) clearTimeout(maximumTimer);
        startTimer = null;
        renewalTimer = null;
        maximumTimer = null;
    };

    const logFailureOnce = (error) => {
        if (presenceUnavailable) return;
        presenceUnavailable = true;
        if (renewalTimer) clearTimeout(renewalTimer);
        renewalTimer = null;
        logger.warn?.(
            '[wa-ai-chat] Typing presence unavailable; continuing without it:',
            error?.response?.status || error?.message || 'unknown error'
        );
    };

    const requestPresence = (presence, delay) => Promise.resolve()
        .then(() => client.sendChatPresence(recipient, { presence, delay }));

    const queueOnlineRestore = () => {
        if (typeof client.restoreOnlinePresence !== 'function') return;

        // Serialize restorations. One is requested after the immediate `paused`
        // cleanup and another after any already-running finite composing request
        // resolves. The second call is intentional: Evolution appends its own
        // trailing `paused` after that request's delay, so `available` must win
        // the final race. This queue never blocks the reply.
        availabilityRestoreQueue = availabilityRestoreQueue
            .then(() => client.restoreOnlinePresence())
            .catch((error) => {
                if (availabilityFailureLogged) return;
                availabilityFailureLogged = true;
                logger.warn?.(
                    '[wa-ai-chat] Online presence restore failed; message delivery was unaffected:',
                    error?.response?.status || error?.message || 'unknown error'
                );
            });
    };

    const runComposingPulse = () => {
        if (stopped || presenceUnavailable) return;
        requestPresence('composing', pulseMs)
            .then((result) => {
                // Virtual test numbers intentionally have no real WhatsApp chat.
                // Do not renew or create admin-inbox transport noise for them.
                if (result?.skipped) {
                    virtualRecipient = true;
                    presenceUnavailable = true;
                    return;
                }

                if (stopped) {
                    // This request has just emitted Evolution's trailing
                    // `paused`. Restore `available` after it, so the delayed
                    // completion cannot hide the online label again.
                    queueOnlineRestore();
                    return;
                }

                // Evolution v2.3.x resolves the request after its finite pulse
                // has been cleared. Chain the next pulse only then, so slow or
                // failing provider requests can never overlap.
                renewalTimer = setTimeout(runComposingPulse, PULSE_RENEWAL_GAP_MS);
                unrefTimer(renewalTimer);
            })
            .catch((error) => {
                logFailureOnce(error);
                // If Evolution applied the state but its response failed or
                // timed out, restoring the configured online state is safe and
                // prevents a stale presence. Do not retry chat presence.
                queueOnlineRestore();
            });
    };

    const begin = () => {
        if (stopped) return;
        startTimer = null;
        started = true;
        runComposingPulse();

        maximumTimer = setTimeout(() => controller.stop(), maxDurationMs);
        unrefTimer(maximumTimer);
    };

    const controller = {
        stop() {
            if (stopped) return;
            stopped = true;
            stopTimers();
            if (started && !presenceUnavailable && !virtualRecipient) {
                // Do not await this chain: clearing chat state and restoring the
                // configured always-online state must never delay the reply.
                requestPresence('paused', 0)
                    .then((result) => {
                        if (!result?.skipped) queueOnlineRestore();
                    })
                    .catch((error) => {
                        logFailureOnce(error);
                        // A timeout can happen after Evolution already applied
                        // the state, so make a best-effort restore even on error.
                        queueOnlineRestore();
                    });
            }
        },
        restoreOnlineAfterReply() {
            // `stop()` runs before the outbound reply so "typing" disappears
            // promptly. The reply itself can then become the newest WhatsApp
            // chat-state event, so reassert `available` after delivery too.
            // This queues background work only and never delays the response.
            if (!started || virtualRecipient) return;
            queueOnlineRestore();
        },
    };

    startTimer = setTimeout(begin, startDelayMs);
    unrefTimer(startTimer);
    return controller;
}

module.exports = {
    DEFAULT_MAX_DURATION_MS,
    DEFAULT_PULSE_MS,
    DEFAULT_START_DELAY_MS,
    startTypingPresence,
};
