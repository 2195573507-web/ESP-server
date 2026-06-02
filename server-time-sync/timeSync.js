const express = require("express");

let latestPingRecord = null;

function toFiniteNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function toDeviceId(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    return String(value);
}

function makeServerTimeSnapshot(nowMs = Date.now()) {
    return {
        server_time_ms: nowMs,
        server_time_iso: new Date(nowMs).toISOString()
    };
}

function buildPingRecord(body = {}, serverRecvMs = Date.now()) {
    const espSendMs = toFiniteNumber(body.esp_send_ms);
    const espUptimeMs = toFiniteNumber(body.esp_uptime_ms);
    const serverReplyMs = Date.now();

    return {
        ok: true,
        device_id: toDeviceId(body.device_id),
        esp_send_ms: espSendMs,
        esp_uptime_ms: espUptimeMs,
        server_recv_ms: serverRecvMs,
        server_reply_ms: serverReplyMs,
        server_time_iso: new Date(serverReplyMs).toISOString(),
        estimated_one_way_delay_ms: espSendMs === null ? null : serverRecvMs - espSendMs
    };
}

function buildSensorTimingFields(body = {}, serverRecvMs = Date.now()) {
    const espTimeMs = toFiniteNumber(body.esp_time_ms);

    return {
        device_id: toDeviceId(body.device_id),
        esp_time_ms: espTimeMs,
        esp_uptime_ms: toFiniteNumber(body.esp_uptime_ms),
        server_recv_ms: serverRecvMs,
        server_time_iso: new Date(serverRecvMs).toISOString(),
        upload_delay_ms: espTimeMs === null ? null : serverRecvMs - espTimeMs
    };
}

function getLatestPingRecord() {
    return latestPingRecord ? { ...latestPingRecord } : null;
}

function getTimeSyncStatus() {
    return {
        ok: true,
        ...makeServerTimeSnapshot(),
        latest_ping: getLatestPingRecord()
    };
}

function withTimeSyncStatus(payload) {
    return {
        ...payload,
        time_sync: getTimeSyncStatus()
    };
}

function createTimeSyncRouter(options = {}) {
    const router = express.Router();
    const logger = options.logger || console;

    router.get("/now", (req, res) => {
        const snapshot = makeServerTimeSnapshot();
        logger.log(`[time-sync] now server_time_ms=${snapshot.server_time_ms}`);
        res.json({
            ok: true,
            ...snapshot
        });
    });

    router.get("/status", (req, res) => {
        res.json(getTimeSyncStatus());
    });

    router.post("/ping", (req, res) => {
        const serverRecvMs = Date.now();
        const record = buildPingRecord(req.body, serverRecvMs);
        latestPingRecord = record;

        logger.log(
            `[time-sync] ping device_id=${record.device_id || "-"} esp_send_ms=${record.esp_send_ms ?? "null"} server_recv_ms=${record.server_recv_ms} estimated_one_way_delay_ms=${record.estimated_one_way_delay_ms ?? "null"}`
        );

        res.json(record);
    });

    return router;
}

module.exports = {
    buildPingRecord,
    buildSensorTimingFields,
    createTimeSyncRouter,
    getLatestPingRecord,
    getTimeSyncStatus,
    makeServerTimeSnapshot,
    toFiniteNumber,
    withTimeSyncStatus
};
