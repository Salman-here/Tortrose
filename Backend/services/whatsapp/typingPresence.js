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
    const noOp = { stop() {} };
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
    let startTimer = null;
    let renewalTimer = null;
    let maximumTimer = null;

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

    const runComposingPulse = () => {
        if (stopped || presenceUnavailable) return;
        requestPresence('composing', pulseMs)
            .then((result) => {
                if (stopped) return;
                // Virtual test numbers intentionally have no real WhatsApp chat.
                // Do not renew or create admin-inbox transport noise for them.
                if (result?.skipped) {
                    presenceUnavailable = true;
                    return;
                }

                // Evolution v2.3.x resolves the request after its finite pulse
                // has been cleared. Chain the next pulse only then, so slow or
                // failing provider requests can never overlap.
                renewalTimer = setTimeout(runComposingPulse, PULSE_RENEWAL_GAP_MS);
                unrefTimer(renewalTimer);
            })
            .catch(logFailureOnce);
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
            if (started && !presenceUnavailable) {
                // Do not await this request: clearing presence must never delay
                // the actual reply. The active composing pulse is also finite.
                requestPresence('paused', 0).catch(logFailureOnce);
            }
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
