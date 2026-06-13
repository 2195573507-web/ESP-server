"use strict";

const crypto = require("crypto");

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TURN_TTL_MS = 120000;
const DEFAULT_RETAIN_DONE_MS = 300000;

const ACTIVE_STATUSES = new Set([
    "prepared",
    "receiving",
    "processing",
    "streaming"
]);

function readPositiveInteger(value, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }

    return numeric;
}

function createTurnId() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return crypto.randomBytes(16).toString("hex");
}

class VoiceSessionStore {
    constructor(options = {}) {
        this.maxConcurrent = readPositiveInteger(
            options.maxConcurrent,
            DEFAULT_MAX_CONCURRENT
        );
        this.turnTtlMs = readPositiveInteger(options.turnTtlMs, DEFAULT_TURN_TTL_MS);
        this.retainDoneMs = readPositiveInteger(
            options.retainDoneMs,
            DEFAULT_RETAIN_DONE_MS
        );
        this.sessions = new Map();
        this.deviceLocks = new Map();
    }

    cleanupExpired(nowMs = Date.now()) {
        for (const session of this.sessions.values()) {
            if (ACTIVE_STATUSES.has(session.status) && session.expiresAtMs <= nowMs) {
                this.finish(session.turnId, "expired", "voice turn expired", nowMs);
                continue;
            }

            if (!ACTIVE_STATUSES.has(session.status) && session.retainUntilMs <= nowMs) {
                this.sessions.delete(session.turnId);
            }
        }
    }

    countActive() {
        let active = 0;
        for (const session of this.sessions.values()) {
            if (ACTIVE_STATUSES.has(session.status)) {
                active += 1;
            }
        }

        return active;
    }

    prepare({ deviceId, sessionId = "", nowMs = Date.now() }) {
        this.cleanupExpired(nowMs);

        const lockedTurnId = this.deviceLocks.get(deviceId);
        if (lockedTurnId) {
            const lockedSession = this.sessions.get(lockedTurnId);
            if (lockedSession && ACTIVE_STATUSES.has(lockedSession.status)) {
                return {
                    ok: false,
                    code: "VOICE_DEVICE_BUSY",
                    status: 409,
                    session: lockedSession
                };
            }

            this.deviceLocks.delete(deviceId);
        }

        if (this.countActive() >= this.maxConcurrent) {
            return {
                ok: false,
                code: "VOICE_GLOBAL_BUSY",
                status: 503
            };
        }

        const turnId = createTurnId();
        const session = {
            turnId,
            deviceId,
            sessionId,
            status: "prepared",
            error: "",
            pcmInBytes: 0,
            pcmOutBytes: 0,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            expiresAtMs: nowMs + this.turnTtlMs,
            retainUntilMs: nowMs + this.turnTtlMs + this.retainDoneMs,
            timings: {
                preparedMs: nowMs
            }
        };

        this.sessions.set(turnId, session);
        this.deviceLocks.set(deviceId, turnId);

        return {
            ok: true,
            session
        };
    }

    get(turnId, nowMs = Date.now()) {
        this.cleanupExpired(nowMs);
        return this.sessions.get(turnId) || null;
    }

    beginTurn({ deviceId, turnId = "", nowMs = Date.now() }) {
        this.cleanupExpired(nowMs);

        if (turnId) {
            const session = this.sessions.get(turnId);
            if (!session) {
                return {
                    ok: false,
                    code: "VOICE_TURN_NOT_FOUND",
                    status: 404
                };
            }

            if (session.deviceId !== deviceId) {
                return {
                    ok: false,
                    code: "VOICE_DEVICE_MISMATCH",
                    status: 409,
                    session
                };
            }

            if (!ACTIVE_STATUSES.has(session.status)) {
                return {
                    ok: false,
                    code: "VOICE_TURN_CLOSED",
                    status: 409,
                    session
                };
            }

            this.markReceiving(session, nowMs);
            return {
                ok: true,
                session
            };
        }

        const prepared = this.prepare({ deviceId, nowMs });
        if (!prepared.ok) {
            return prepared;
        }

        this.markReceiving(prepared.session, nowMs);
        return prepared;
    }

    markReceiving(session, nowMs = Date.now()) {
        session.status = "receiving";
        session.updatedAtMs = nowMs;
        session.expiresAtMs = nowMs + this.turnTtlMs;
        session.timings.receiveStartMs = session.timings.receiveStartMs || nowMs;
    }

    markProcessing(turnId, pcmInBytes, nowMs = Date.now()) {
        const session = this.sessions.get(turnId);
        if (!session) {
            return null;
        }

        session.status = "processing";
        session.pcmInBytes = pcmInBytes;
        session.updatedAtMs = nowMs;
        session.timings.receiveEndMs = nowMs;
        return session;
    }

    markStreaming(turnId, nowMs = Date.now()) {
        const session = this.sessions.get(turnId);
        if (!session) {
            return null;
        }

        session.status = "streaming";
        session.updatedAtMs = nowMs;
        session.timings.streamStartMs = nowMs;
        return session;
    }

    addOutputBytes(turnId, bytes, nowMs = Date.now()) {
        const session = this.sessions.get(turnId);
        if (!session) {
            return null;
        }

        session.pcmOutBytes += bytes;
        session.updatedAtMs = nowMs;
        return session;
    }

    finish(turnId, status = "completed", error = "", nowMs = Date.now()) {
        const session = this.sessions.get(turnId);
        if (!session) {
            return null;
        }

        session.status = status;
        session.error = error;
        session.updatedAtMs = nowMs;
        session.timings.streamEndMs = session.timings.streamEndMs || nowMs;
        session.timings.completedMs = nowMs;
        session.expiresAtMs = nowMs;
        session.retainUntilMs = nowMs + this.retainDoneMs;

        if (this.deviceLocks.get(session.deviceId) === turnId) {
            this.deviceLocks.delete(session.deviceId);
        }

        return session;
    }
}

function createVoiceSessionStore(options = {}) {
    return new VoiceSessionStore(options);
}

module.exports = {
    ACTIVE_STATUSES,
    createVoiceSessionStore
};
