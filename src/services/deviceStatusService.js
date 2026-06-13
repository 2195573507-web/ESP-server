const {
    runUpdateThenInsert
} = require("../db/upsert");
const {
    isValidUploadDelay,
    trimText
} = require("./deviceMetadata");

const DEVICE_ONLINE_THRESHOLD_MS = 120000;
const MODULE_ONLINE_THRESHOLD_MS = 30000;

function nowIso() {
    return new Date().toISOString();
}

function rowFirst(rows) {
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function numberOrNull(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function integerOrNull(value) {
    const numeric = numberOrNull(value);
    return numeric === null ? null : Math.trunc(numeric);
}

function computeDelayStats(row, delayMs) {
    const previousCount = Math.max(0, integerOrNull(row?.delay_sample_count) || 0);
    const previousAvg = numberOrNull(row?.avg_upload_delay_ms);
    const previousLatest = integerOrNull(row?.latest_upload_delay_ms);
    if (!isValidUploadDelay(delayMs)) {
        return {
            latest_upload_delay_ms: previousLatest,
            avg_upload_delay_ms: previousAvg === null ? null : Math.round(previousAvg),
            delay_sample_count: previousCount
        };
    }

    const nextCount = previousCount + 1;
    const nextAvg = previousCount > 0 && previousAvg !== null
        ? Math.round(((previousAvg * previousCount) + delayMs) / nextCount)
        : Math.round(delayMs);

    return {
        latest_upload_delay_ms: Math.round(delayMs),
        avg_upload_delay_ms: nextAvg,
        delay_sample_count: nextCount
    };
}

async function getDeviceStatusRow(dbAll, deviceId) {
    const rows = await dbAll(
        "SELECT * FROM device_status WHERE device_id=? AND deleted_at IS NULL LIMIT 1",
        [deviceId]
    );
    return rowFirst(rows);
}

async function getModuleStatusRow(dbAll, deviceId, moduleType) {
    const rows = await dbAll(
        "SELECT * FROM device_module_status WHERE device_id=? AND module_type=? AND deleted_at IS NULL LIMIT 1",
        [deviceId, moduleType]
    );
    return rowFirst(rows);
}

function computeRebootCount(row, metadata) {
    const previousUptime = integerOrNull(row?.last_esp_uptime_ms);
    const currentUptime = integerOrNull(metadata.esp_uptime_ms);
    const previousCount = Math.max(0, integerOrNull(row?.reboot_count) || 0);
    if (previousUptime !== null && currentUptime !== null && currentUptime + 5000 < previousUptime) {
        return previousCount + 1;
    }

    return previousCount;
}

async function updateDeviceStatus(dbRun, dbAll, metadata, options = {}) {
    const deviceId = trimText(metadata?.device_id, 128);
    if (!deviceId || typeof dbRun !== "function" || typeof dbAll !== "function") {
        return {
            ok: false,
            skipped: true
        };
    }

    const moduleType = trimText(options.moduleType || metadata.payload_type || "", 80);
    const timestampIso = metadata.server_time_iso || new Date(metadata.server_recv_ms || Date.now()).toISOString();
    const updatedAt = nowIso();
    const existing = await getDeviceStatusRow(dbAll, deviceId);
    const stats = computeDelayStats(existing, metadata.upload_delay_ms);
    const rebootCount = computeRebootCount(existing, metadata);

    await runUpdateThenInsert(dbRun, {
        updateSql: `UPDATE device_status
            SET device_type=?,
                firmware_version=?,
                last_seen_ms=?,
                last_seen_iso=?,
                last_payload_type=?,
                last_module_type=?,
                last_esp_uptime_ms=?,
                last_esp_time_ms=?,
                time_synced=?,
                reboot_count=?,
                latest_upload_delay_ms=?,
                avg_upload_delay_ms=?,
                delay_sample_count=?,
                created_at=CASE WHEN deleted_at IS NULL THEN created_at ELSE ? END,
                deleted_at=NULL,
                delete_reason=NULL,
                updated_at=?
            WHERE device_id=?`,
        updateParams: [
            metadata.device_type || existing?.device_type || "",
            metadata.firmware_version || existing?.firmware_version || "",
            metadata.server_recv_ms,
            timestampIso,
            metadata.payload_type || moduleType,
            moduleType,
            metadata.esp_uptime_ms,
            metadata.esp_time_ms,
            metadata.time_synced === null ? null : (metadata.time_synced ? 1 : 0),
            rebootCount,
            stats.latest_upload_delay_ms,
            stats.avg_upload_delay_ms,
            stats.delay_sample_count,
            updatedAt,
            updatedAt,
            deviceId
        ],
        insertSql: `INSERT INTO device_status
            (device_id,device_type,firmware_version,last_seen_ms,last_seen_iso,last_payload_type,last_module_type,last_esp_uptime_ms,last_esp_time_ms,time_synced,reboot_count,latest_upload_delay_ms,avg_upload_delay_ms,delay_sample_count,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        insertParams: [
            deviceId,
            metadata.device_type || "",
            metadata.firmware_version || "",
            metadata.server_recv_ms,
            timestampIso,
            metadata.payload_type || moduleType,
            moduleType,
            metadata.esp_uptime_ms,
            metadata.esp_time_ms,
            metadata.time_synced === null ? null : (metadata.time_synced ? 1 : 0),
            rebootCount,
            stats.latest_upload_delay_ms,
            stats.avg_upload_delay_ms,
            stats.delay_sample_count,
            updatedAt,
            updatedAt
        ]
    });

    return {
        ok: true,
        device_id: deviceId,
        module_type: moduleType,
        ...stats
    };
}

async function updateDeviceModuleStatus(dbRun, dbAll, metadata, moduleType) {
    const deviceId = trimText(metadata?.device_id, 128);
    const safeModuleType = trimText(moduleType || metadata?.payload_type || "", 80);
    if (!deviceId || !safeModuleType || typeof dbRun !== "function" || typeof dbAll !== "function") {
        return {
            ok: false,
            skipped: true
        };
    }

    const timestampIso = metadata.server_time_iso || new Date(metadata.server_recv_ms || Date.now()).toISOString();
    const updatedAt = nowIso();
    const existing = await getModuleStatusRow(dbAll, deviceId, safeModuleType);
    const stats = computeDelayStats(existing, metadata.upload_delay_ms);

    await runUpdateThenInsert(dbRun, {
        updateSql: `UPDATE device_module_status
            SET last_seen_ms=?,
                last_seen_iso=?,
                last_payload_type=?,
                last_esp_uptime_ms=?,
                last_esp_time_ms=?,
                time_synced=?,
                latest_upload_delay_ms=?,
                avg_upload_delay_ms=?,
                delay_sample_count=?,
                created_at=CASE WHEN deleted_at IS NULL THEN created_at ELSE ? END,
                deleted_at=NULL,
                delete_reason=NULL,
                updated_at=?
            WHERE device_id=? AND module_type=?`,
        updateParams: [
            metadata.server_recv_ms,
            timestampIso,
            metadata.payload_type || safeModuleType,
            metadata.esp_uptime_ms,
            metadata.esp_time_ms,
            metadata.time_synced === null ? null : (metadata.time_synced ? 1 : 0),
            stats.latest_upload_delay_ms,
            stats.avg_upload_delay_ms,
            stats.delay_sample_count,
            updatedAt,
            updatedAt,
            deviceId,
            safeModuleType
        ],
        insertSql: `INSERT INTO device_module_status
            (device_id,module_type,last_seen_ms,last_seen_iso,last_payload_type,last_esp_uptime_ms,last_esp_time_ms,time_synced,latest_upload_delay_ms,avg_upload_delay_ms,delay_sample_count,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        insertParams: [
            deviceId,
            safeModuleType,
            metadata.server_recv_ms,
            timestampIso,
            metadata.payload_type || safeModuleType,
            metadata.esp_uptime_ms,
            metadata.esp_time_ms,
            metadata.time_synced === null ? null : (metadata.time_synced ? 1 : 0),
            stats.latest_upload_delay_ms,
            stats.avg_upload_delay_ms,
            stats.delay_sample_count,
            updatedAt,
            updatedAt
        ]
    });

    return {
        ok: true,
        device_id: deviceId,
        module_type: safeModuleType,
        ...stats
    };
}

async function refreshDeviceActivity(dbRun, dbAll, metadata, moduleType) {
    const device = await updateDeviceStatus(dbRun, dbAll, metadata, { moduleType });
    const module = await updateDeviceModuleStatus(dbRun, dbAll, metadata, moduleType);
    return {
        device,
        module
    };
}

function mapDeviceStatus(row, nowMs = Date.now()) {
    if (!row) {
        return null;
    }

    const lastSeenMs = integerOrNull(row.last_seen_ms);
    const ageMs = lastSeenMs === null ? null : Math.max(0, nowMs - lastSeenMs);
    return {
        device_id: row.device_id,
        device_type: row.device_type || "",
        firmware_version: row.firmware_version || "",
        last_seen_ms: lastSeenMs,
        last_seen_iso: row.last_seen_iso || "",
        last_seen_age_ms: ageMs,
        device_online: ageMs !== null && ageMs <= DEVICE_ONLINE_THRESHOLD_MS,
        online: ageMs !== null && ageMs <= DEVICE_ONLINE_THRESHOLD_MS,
        last_payload_type: row.last_payload_type || "",
        last_module_type: row.last_module_type || "",
        last_esp_uptime_ms: integerOrNull(row.last_esp_uptime_ms),
        last_esp_time_ms: integerOrNull(row.last_esp_time_ms),
        time_synced: row.time_synced === null || row.time_synced === undefined ? null : Boolean(Number(row.time_synced)),
        reboot_count: integerOrNull(row.reboot_count) || 0,
        latest_upload_delay_ms: integerOrNull(row.latest_upload_delay_ms),
        avg_upload_delay_ms: integerOrNull(row.avg_upload_delay_ms),
        delay_sample_count: integerOrNull(row.delay_sample_count) || 0,
        updated_at: row.updated_at || ""
    };
}

function mapModuleStatus(row, nowMs = Date.now()) {
    if (!row) {
        return null;
    }

    const lastSeenMs = integerOrNull(row.last_seen_ms);
    const ageMs = lastSeenMs === null ? null : Math.max(0, nowMs - lastSeenMs);
    return {
        device_id: row.device_id,
        module_type: row.module_type,
        last_seen_ms: lastSeenMs,
        last_seen_iso: row.last_seen_iso || "",
        last_seen_age_ms: ageMs,
        module_online: ageMs !== null && ageMs <= MODULE_ONLINE_THRESHOLD_MS,
        online: ageMs !== null && ageMs <= MODULE_ONLINE_THRESHOLD_MS,
        last_payload_type: row.last_payload_type || "",
        last_esp_uptime_ms: integerOrNull(row.last_esp_uptime_ms),
        last_esp_time_ms: integerOrNull(row.last_esp_time_ms),
        time_synced: row.time_synced === null || row.time_synced === undefined ? null : Boolean(Number(row.time_synced)),
        latest_upload_delay_ms: integerOrNull(row.latest_upload_delay_ms),
        avg_upload_delay_ms: integerOrNull(row.avg_upload_delay_ms),
        delay_sample_count: integerOrNull(row.delay_sample_count) || 0,
        updated_at: row.updated_at || ""
    };
}

async function readDeviceStatus(dbAll, deviceId, nowMs = Date.now()) {
    const rows = await dbAll(
        deviceId
            ? "SELECT * FROM device_status WHERE device_id=? AND deleted_at IS NULL LIMIT 1"
            : "SELECT * FROM device_status WHERE deleted_at IS NULL ORDER BY last_seen_ms DESC LIMIT 1",
        deviceId ? [deviceId] : []
    );
    return mapDeviceStatus(rowFirst(rows), nowMs);
}

async function readModuleStatuses(dbAll, deviceId, nowMs = Date.now()) {
    const params = [];
    let where = "";
    if (deviceId) {
        where = "WHERE device_id=? AND deleted_at IS NULL";
        params.push(deviceId);
    } else {
        where = "WHERE deleted_at IS NULL";
    }

    const rows = await dbAll(
        `SELECT * FROM device_module_status ${where} ORDER BY last_seen_ms DESC`,
        params
    );
    return rows.map(row => mapModuleStatus(row, nowMs));
}

module.exports = {
    DEVICE_ONLINE_THRESHOLD_MS,
    MODULE_ONLINE_THRESHOLD_MS,
    mapDeviceStatus,
    mapModuleStatus,
    readDeviceStatus,
    readModuleStatuses,
    refreshDeviceActivity,
    updateDeviceModuleStatus,
    updateDeviceStatus
};
