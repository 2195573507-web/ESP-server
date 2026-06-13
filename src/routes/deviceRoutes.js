const express = require("express");
const {
    makeDeviceEnvelope,
    trimText
} = require("../services/deviceMetadata");
const {
    getDeviceContext
} = require("../services/deviceContextService");
const {
    readDeviceStatus,
    readModuleStatuses
} = require("../services/deviceStatusService");
const {
    ingestCsiMotion
} = require("../services/csiMotionService");
const {
    ingestBme690
} = require("../services/sensorBme690Service");
const {
    ingestDashboardSnapshot
} = require("../services/dashboardService");

function parseJsonObject(value, fallback = {}) {
    if (!value) {
        return fallback;
    }

    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function mapLatestSensor(row) {
    if (!row) {
        return {};
    }

    return {
        id: row.id,
        timestamp: row.timestamp,
        temperature: row.temperature,
        humidity: row.humidity,
        pressure: row.pressure,
        gas_resistance: row.gas_resistance,
        device_id: row.device_id,
        esp_time_ms: row.esp_time_ms,
        esp_uptime_ms: row.esp_uptime_ms,
        server_recv_ms: row.server_recv_ms,
        server_time_iso: row.server_time_iso,
        upload_delay_ms: row.upload_delay_ms,
        schema_version: row.schema_version,
        payload_type: row.payload_type || "sensor.bme690",
        sensor_id: row.sensor_id || "",
        metadata: parseJsonObject(row.metadata_json),
        raw_json: parseJsonObject(row.raw_json, null),
        air_quality: parseJsonObject(row.air_quality_json, {
            air_quality_score: row.air_quality_score,
            air_quality_level: row.air_quality_level,
            air_quality_confidence: row.air_quality_confidence,
            air_quality_source: row.air_quality_source
        }),
        air_quality_score: row.air_quality_score,
        air_quality_level: row.air_quality_level,
        air_quality_confidence: row.air_quality_confidence,
        air_quality_source: row.air_quality_source
    };
}

async function readLatestSensor(dbAll, deviceId) {
    const params = [];
    let where = "WHERE deleted_at IS NULL AND (payload_type='sensor.bme690' OR payload_type IS NULL OR payload_type='')";
    if (deviceId) {
        where += " AND device_id=?";
        params.push(deviceId);
    }

    const rows = await dbAll(
        `SELECT * FROM sensor_records
        ${where}
        ORDER BY COALESCE(server_recv_ms, timestamp, id) DESC, id DESC
        LIMIT 1`,
        params
    );
    return rows[0] || null;
}

function createDeviceRouter(options) {
    const router = express.Router();
    const dbRun = options.dbRun;
    const dbAll = options.dbAll;
    const logger = options.logger || console;

    router.post("/api/device/v1/ingest", async (req, res) => {
        const serverRecvMs = Date.now();
        const payloadType = trimText(req.body?.payload_type, 80);
        if (payloadType !== "sensor.bme690" && payloadType !== "csi.motion") {
            return res.status(400).json(makeDeviceEnvelope({
                ok: false,
                serverRecvMs,
                error: {
                    code: "UNSUPPORTED_PAYLOAD_TYPE",
                    message: "payload_type must be sensor.bme690 or csi.motion"
                }
            }));
        }

        try {
            const ingest = payloadType === "csi.motion" ? ingestCsiMotion : ingestBme690;
            const result = await ingest(dbRun, dbAll, req.body, {
                headers: req.headers,
                query: req.query,
                serverRecvMs
            });
            if (!result.ok) {
                return res.status(result.status || 400).json(makeDeviceEnvelope({
                    ok: false,
                    serverRecvMs,
                    error: {
                        code: result.code || "INVALID_PAYLOAD",
                        message: result.error || "invalid payload"
                    }
                }));
            }

            logger.log(
                `[device-v1] ingest payload_type=${result.data.payload_type} device_id=${result.data.device_id || "-"} id=${result.data.id ?? "-"} upload_delay_ms=${result.data.upload_delay_ms ?? "null"}`
            );

            return res.status(result.status).json(makeDeviceEnvelope({
                ok: true,
                serverRecvMs,
                data: result.data
            }));
        } catch (error) {
            logger.error(`[device-v1] ingest failed ${error?.message || error}`);
            return res.status(500).json(makeDeviceEnvelope({
                ok: false,
                serverRecvMs,
                error: {
                    code: "DEVICE_INGEST_FAILED",
                    message: "device ingest failed"
                }
            }));
        }
    });

    router.post("/api/device/v1/gateway-state", async (req, res) => {
        const serverRecvMs = Date.now();

        try {
            const result = await ingestDashboardSnapshot(req.body, {
                serverRecvMs
            });
            if (!result.ok) {
                return res.status(result.status || 400).json(makeDeviceEnvelope({
                    ok: false,
                    serverRecvMs,
                    error: {
                        code: result.code || "INVALID_DASHBOARD_SNAPSHOT",
                        message: result.error || "invalid dashboard snapshot"
                    }
                }));
            }

            logger.log(
                `[device-v1] gateway-state gateway_id=${result.data.gateway_id || "-"} devices=${result.data.device_count}`
            );

            return res.status(result.status).json(makeDeviceEnvelope({
                ok: true,
                serverRecvMs,
                data: result.data
            }));
        } catch (error) {
            logger.error(`[device-v1] gateway-state failed ${error?.message || error}`);
            return res.status(500).json(makeDeviceEnvelope({
                ok: false,
                serverRecvMs,
                error: {
                    code: "GATEWAY_STATE_INGEST_FAILED",
                    message: "gateway state ingest failed"
                }
            }));
        }
    });

    router.get("/api/device/v1/status", async (req, res) => {
        const deviceId = trimText(req.query.device_id, 128);
        const status = await readDeviceStatus(dbAll, deviceId);
        return res.json({
            ok: true,
            status,
            server_time_ms: Date.now()
        });
    });

    router.get("/api/device/v1/modules/status", async (req, res) => {
        const deviceId = trimText(req.query.device_id, 128);
        const modules = await readModuleStatuses(dbAll, deviceId);
        return res.json({
            ok: true,
            modules,
            server_time_ms: Date.now()
        });
    });

    router.get("/api/device/v1/context", async (req, res) => {
        const deviceId = trimText(req.query.device_id, 128);
        const context = await getDeviceContext(dbAll, deviceId);
        return res.json({
            ok: true,
            context,
            server_time_ms: Date.now()
        });
    });

    router.get("/api/device/v1/sensors/latest", async (req, res) => {
        const deviceId = trimText(req.query.device_id, 128);
        const row = await readLatestSensor(dbAll, deviceId);
        return res.json({
            ok: true,
            sensor: mapLatestSensor(row),
            server_time_ms: Date.now()
        });
    });

    return router;
}

module.exports = {
    createDeviceRouter,
    mapLatestSensor,
    readLatestSensor
};
