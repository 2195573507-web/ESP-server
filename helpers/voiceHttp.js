"use strict";

const DEFAULT_PCM_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";
const DEVICE_ID_MAX_LENGTH = 96;
const SESSION_ID_MAX_LENGTH = 128;

function readTextValue(value, maxLength) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().slice(0, maxLength);
}

function readPrepareRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {
            error: "JSON object body is required"
        };
    }

    const deviceId = readTextValue(body.device_id, DEVICE_ID_MAX_LENGTH);
    if (!deviceId) {
        return {
            error: "device_id is required"
        };
    }

    return {
        deviceId,
        sessionId: readTextValue(body.session_id, SESSION_ID_MAX_LENGTH)
    };
}

function readTurnHeaders(req) {
    const deviceId = readTextValue(
        req.get("X-Device-Id") || req.get("x-device-id"),
        DEVICE_ID_MAX_LENGTH
    );

    if (!deviceId) {
        return {
            error: "X-Device-Id header is required"
        };
    }

    return {
        deviceId,
        turnId: readTextValue(req.get("X-Turn-Id") || req.get("x-turn-id"), 80),
        contentType: req.get("Content-Type") || ""
    };
}

function maskLogValue(value) {
    if (!value) {
        return "-";
    }

    if (value.length <= 6) {
        return `${value.slice(0, 1)}***len${value.length}`;
    }

    return `${value.slice(0, 3)}***${value.slice(-2)}len${value.length}`;
}

function createTimingSnapshot(session) {
    return {
        prepared_ms: session.timings.preparedMs || null,
        receive_start_ms: session.timings.receiveStartMs || null,
        receive_end_ms: session.timings.receiveEndMs || null,
        stream_start_ms: session.timings.streamStartMs || null,
        stream_end_ms: session.timings.streamEndMs || null,
        completed_ms: session.timings.completedMs || null
    };
}

function toPublicSession(session) {
    if (!session) {
        return null;
    }

    return {
        ok: true,
        turn_id: session.turnId,
        device_id: session.deviceId,
        session_id: session.sessionId || "",
        status: session.status,
        pcm_in_bytes: session.pcmInBytes,
        pcm_out_bytes: session.pcmOutBytes,
        timings: createTimingSnapshot(session),
        error: session.error || null,
        expires_at_ms: session.expiresAtMs
    };
}

function writePcmHeaders(res, contentType = DEFAULT_PCM_CONTENT_TYPE) {
    res.status(200);
    res.set({
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
}

module.exports = {
    DEFAULT_PCM_CONTENT_TYPE,
    maskLogValue,
    readPrepareRequest,
    readTurnHeaders,
    toPublicSession,
    writePcmHeaders
};
