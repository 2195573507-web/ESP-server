const express = require("express");
const {
    buildSensorTimingFields,
    withTimeSyncStatus
} = require("../../server-time-sync/timeSync");

const SENSOR_DEVICE_ID_MAX_LENGTH = 128;

function toFiniteSensorNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSensorBody(body = {}) {
    return {
        ...body,
        temperature: toFiniteSensorNumber(body.temperature),
        humidity: toFiniteSensorNumber(body.humidity),
        pressure: toFiniteSensorNumber(body.pressure),
        gas_resistance: toFiniteSensorNumber(body.gas_resistance),
        device_id: typeof body.device_id === "string"
            ? body.device_id.trim().slice(0, SENSOR_DEVICE_ID_MAX_LENGTH)
            : body.device_id
    };
}

function readHistoryLimit(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 50;
    }

    return Math.min(numeric, 500);
}

function sendSensorDbError(res, err, includeSuccess = false) {
    return res.status(500).json({
        ok: false,
        ...(includeSuccess ? { success: false } : {}),
        error: err.message
    });
}

function createSensorRouter(options) {
    const router = express.Router();
    const db = options.db;
    const logger = options.logger || console;

    router.post("/sensor", (req, res) => {
        const normalizedBody = normalizeSensorBody(req.body);
        const {
            temperature,
            humidity,
            pressure,
            gas_resistance
        } = normalizedBody;
        const serverRecvMs = Date.now();
        const timing = buildSensorTimingFields(normalizedBody, serverRecvMs);

        db.run(
            `INSERT INTO sensor_records
            (timestamp,temperature,humidity,pressure,gas_resistance,device_id,esp_time_ms,esp_uptime_ms,server_recv_ms,server_time_iso,upload_delay_ms)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            [
                serverRecvMs,
                temperature,
                humidity,
                pressure,
                gas_resistance,
                timing.device_id,
                timing.esp_time_ms,
                timing.esp_uptime_ms,
                timing.server_recv_ms,
                timing.server_time_iso,
                timing.upload_delay_ms
            ],
            function (err) {
                if (err) {
                    return sendSensorDbError(res, err, true);
                }

                logger.log(
                    `[sensor] upload device_id=${timing.device_id || "-"} server_recv_ms=${timing.server_recv_ms} upload_delay_ms=${timing.upload_delay_ms ?? "null"}`
                );

                res.json({
                    ok: true,
                    success: true,
                    id: this.lastID,
                    ...timing
                });
            }
        );
    });

    router.get("/sensor/latest", (req, res) => {
        db.get(
            "SELECT * FROM sensor_records ORDER BY id DESC LIMIT 1",
            [],
            (err, row) => {
                if (err) {
                    return sendSensorDbError(res, err);
                }

                res.json(row ? withTimeSyncStatus(row) : {});
            }
        );
    });

    router.get("/sensor/history", (req, res) => {
        const limit = readHistoryLimit(req.query.limit);

        db.all(
            `SELECT * FROM (
                SELECT * FROM sensor_records ORDER BY id DESC LIMIT ?
            ) ORDER BY id ASC`,
            [limit],
            (err, rows) => {
                if (err) {
                    return sendSensorDbError(res, err);
                }

                res.json(rows || []);
            }
        );
    });

    return router;
}

module.exports = {
    createSensorRouter,
    normalizeSensorBody,
    readHistoryLimit
};
