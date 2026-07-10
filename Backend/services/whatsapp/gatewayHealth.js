'use strict';

// Shared zombie-gateway signal store.
//
// The Evolution/Baileys WebSocket to WhatsApp can die silently: the instance
// keeps reporting connectionState "open" while every socket operation fails
// with a Boom 428 "Connection Closed". Evolution does not always recover on
// its own, so the backend has to detect the state and trigger a restart.
//
// This module only records signals — it never talks to Evolution — so it can
// be required from the low-level client without creating an import cycle.
// The gatewayHealthMonitor reads these signals and performs the recovery.

const state = {
    lastZombieSignalAt: 0,
    zombieSignalCount: 0,
    lastRestartAt: 0,
    lastLogAt: 0,
};

// Recognize the "socket is dead" failure shape in any of the places
// Evolution surfaces it (HTTP error body, Boom payload, plain message).
const isZombieGatewayError = (err) => {
    if (!err) return false;
    const body = err.response?.data ?? err;
    const haystack = [
        body?.message,
        body?.output?.payload?.message,
        body?.response?.message,
        err.message,
    ]
        .flat()
        .filter(v => typeof v === 'string')
        .join(' | ');
    if (/connection closed/i.test(haystack)) return true;
    const statusCode = body?.output?.statusCode || body?.statusCode;
    return statusCode === 428;
};

// Some builds return the Boom body with HTTP 200 — detect it in response data.
const isZombieGatewayBody = (data) => {
    if (!data || typeof data !== 'object') return false;
    const message = data?.output?.payload?.message || data?.message || '';
    if (data.isBoom && /connection closed/i.test(String(message))) return true;
    return data?.output?.statusCode === 428;
};

const reportZombieSignal = (source = 'unknown') => {
    const now = Date.now();
    state.lastZombieSignalAt = now;
    state.zombieSignalCount += 1;
    // Throttle logging so a webhook/send storm doesn't flood the logs.
    if (now - state.lastLogAt > 30 * 1000) {
        state.lastLogAt = now;
        console.warn(`[whatsapp:health] zombie gateway signal from ${source} (socket reports Connection Closed while instance is "open")`);
    }
};

const hasRecentZombieSignal = (windowMs = 3 * 60 * 1000) =>
    state.lastZombieSignalAt > 0 && Date.now() - state.lastZombieSignalAt < windowMs;

const markRestart = () => {
    state.lastRestartAt = Date.now();
    state.zombieSignalCount = 0;
};

const msSinceLastRestart = () =>
    state.lastRestartAt ? Date.now() - state.lastRestartAt : Number.POSITIVE_INFINITY;

const getState = () => ({ ...state });

module.exports = {
    isZombieGatewayError,
    isZombieGatewayBody,
    reportZombieSignal,
    hasRecentZombieSignal,
    markRestart,
    msSinceLastRestart,
    getState,
};
