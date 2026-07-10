'use strict';

// Periodic WhatsApp gateway health monitor with self-healing.
//
// Why this exists: the Baileys WebSocket inside Evolution can die silently
// (memory pressure on the VM, WhatsApp stream errors). Evolution then keeps
// reporting connectionState "open" while every send fails with Boom 428
// "Connection Closed" and no inbound webhooks arrive. Nothing recovers on its
// own — the outage persists until the instance is restarted.
//
// Every tick this monitor:
//   1. Reads connectionState.
//   2. If "open", runs a REAL socket operation (probeSocketHealth) to catch
//      zombie sessions that connectionState cannot see.
//   3. On confirmed zombie (2 consecutive failed probes, or 1 failed probe
//      plus a recent send failure from live traffic) it restarts the
//      instance and marks WhatsAppConfig disconnected so the send queue
//      pauses and dashboards show the truth.
//   4. If "close", it nudges the instance to reconnect.
//
// The VM-side watchdog (evolution-api/watchdog.sh on the Oracle host) is the
// second line of defense: it restarts the Docker container if the instance
// stays dead, which recovers failure modes an API-level restart cannot.

const WhatsAppConfig = require('../../models/WhatsAppConfig');
const evolution = require('./evolutionClient');
const { configKeyFor } = require('./gatewayMode');
const {
    hasRecentZombieSignal,
    markRestart,
    msSinceLastRestart,
} = require('./gatewayHealth');

const INTERVAL_MS = Number(process.env.WHATSAPP_HEALTH_INTERVAL_MS || 60 * 1000);
const RESTART_COOLDOWN_MS = Number(process.env.WHATSAPP_HEALTH_RESTART_COOLDOWN_MS || 10 * 60 * 1000);
const CONNECT_NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

let timer = null;
let ticking = false;
let consecutiveZombieProbes = 0;
let lastConnectNudgeAt = 0;
let cachedProbeNumber = '';

const singletonKey = () => configKeyFor('main');

const resolveProbeNumber = async () => {
    const fromEnv = String(process.env.WHATSAPP_HEALTH_PROBE_NUMBER || '').replace(/\D/g, '');
    if (fromEnv) return fromEnv;
    if (cachedProbeNumber) return cachedProbeNumber;
    const cfg = await WhatsAppConfig.findOne({ singletonKey: singletonKey() })
        .select('linkedNumber')
        .lean()
        .catch(() => null);
    const digits = String(cfg?.linkedNumber || '').replace(/\D/g, '');
    if (digits) cachedProbeNumber = digits;
    return digits;
};

const setGatewayStatus = async (status, lastError = '') => {
    await WhatsAppConfig.updateOne(
        { singletonKey: singletonKey() },
        {
            $set: {
                status,
                lastSeen: new Date(),
                lastError: lastError.slice(0, 500),
                ...(status === 'connected' ? { linkedAt: new Date() } : {}),
            },
        },
        { upsert: true }
    ).catch((err) => {
        console.warn('[whatsapp:health] failed to update WhatsAppConfig:', err.message);
    });
};

const healZombieGateway = async (reason) => {
    if (msSinceLastRestart() < RESTART_COOLDOWN_MS) {
        console.warn(`[whatsapp:health] zombie gateway detected (${reason}) but restart is on cooldown — VM watchdog will escalate if needed`);
        return;
    }
    markRestart();
    console.error(`[whatsapp:health] ZOMBIE GATEWAY: ${reason}. Restarting Evolution instance ${evolution.instanceName()}...`);
    await setGatewayStatus('disconnected', `Auto-heal: WhatsApp socket was dead (Connection Closed) while instance reported open. Instance restart triggered (${reason}).`);
    const result = await evolution.restartInstance();
    if (result?.error) {
        console.error('[whatsapp:health] instance restart failed:', JSON.stringify(result.error).slice(0, 300));
    } else {
        console.log('[whatsapp:health] instance restart requested — waiting for reconnection');
    }
};

const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
        if (!evolution.isConfigured()) return;

        const status = await evolution.getStatus();
        const state = status?.state || '';

        if (state === 'open') {
            const probeNumber = await resolveProbeNumber();
            if (!probeNumber) {
                // No number to probe with yet (fresh install). Traffic-based
                // zombie signals still work via the axios interceptor.
                if (hasRecentZombieSignal()) {
                    consecutiveZombieProbes += 1;
                } else {
                    consecutiveZombieProbes = 0;
                }
            } else {
                const probe = await evolution.probeSocketHealth(probeNumber);
                if (probe.ok) {
                    if (consecutiveZombieProbes > 0) {
                        console.log('[whatsapp:health] gateway socket recovered');
                    }
                    consecutiveZombieProbes = 0;
                    // Keep WhatsAppConfig truthful if we previously marked it down.
                    const cfg = await WhatsAppConfig.findOne({ singletonKey: singletonKey() })
                        .select('status lastError')
                        .lean()
                        .catch(() => null);
                    if (cfg && cfg.status !== 'connected' && /^Auto-heal:/.test(cfg.lastError || '')) {
                        await setGatewayStatus('connected', '');
                        console.log('[whatsapp:health] gateway back online — WhatsAppConfig marked connected');
                    }
                } else if (probe.zombie) {
                    consecutiveZombieProbes += 1;
                    console.warn(`[whatsapp:health] socket probe failed with Connection Closed (${consecutiveZombieProbes} consecutive) while state=open`);
                } else {
                    // Indeterminate failure (timeout, 5xx, network) — don't
                    // reset the counter, but don't escalate on it either.
                    console.warn(`[whatsapp:health] socket probe indeterminate: ${probe.error}`);
                }
            }

            if (consecutiveZombieProbes >= 2 ||
                (consecutiveZombieProbes >= 1 && hasRecentZombieSignal())) {
                await healZombieGateway(`probe failures=${consecutiveZombieProbes}, trafficSignal=${hasRecentZombieSignal()}`);
                consecutiveZombieProbes = 0;
            }
            return;
        }

        consecutiveZombieProbes = 0;

        if (state === 'close' || state === 'closed') {
            if (Date.now() - lastConnectNudgeAt > CONNECT_NUDGE_COOLDOWN_MS) {
                lastConnectNudgeAt = Date.now();
                console.warn('[whatsapp:health] instance state=close — nudging reconnect');
                await evolution.connectInstance();
            }
        }
        // 'connecting' — Evolution is already working on it; leave it alone.
    } catch (err) {
        console.warn('[whatsapp:health] tick error:', err.message);
    } finally {
        ticking = false;
    }
};

exports.startGatewayHealthMonitor = () => {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => null); }, INTERVAL_MS);
    timer.unref?.();
    console.log(`[whatsapp:health] gateway health monitor started (every ${Math.round(INTERVAL_MS / 1000)}s)`);
};

exports.stopGatewayHealthMonitor = () => {
    if (timer) clearInterval(timer);
    timer = null;
};

// Exported for tests.
exports._tick = tick;
