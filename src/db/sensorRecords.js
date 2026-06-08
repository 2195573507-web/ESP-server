const {
    ensureTableColumns
} = require("./migrations");

const SENSOR_RECORD_COLUMNS = [
    { name: "id", type: "INTEGER PRIMARY KEY AUTOINCREMENT" },
    { name: "timestamp", type: "INTEGER" },
    { name: "temperature", type: "REAL" },
    { name: "humidity", type: "REAL" },
    { name: "pressure", type: "REAL" },
    { name: "gas_resistance", type: "REAL" },
    { name: "device_id", type: "TEXT" },
    { name: "esp_time_ms", type: "INTEGER" },
    { name: "esp_uptime_ms", type: "INTEGER" },
    { name: "server_recv_ms", type: "INTEGER" },
    { name: "server_time_iso", type: "TEXT" },
    { name: "upload_delay_ms", type: "INTEGER" }
];

function columnSql(columns) {
    return columns.map(column => `${column.name} ${column.type}`).join(",\n            ");
}

function addableColumns(columns) {
    return columns.filter(column => !column.type.includes("PRIMARY KEY"));
}

async function ensureSensorTimingColumns(dbRun, dbAll, logger = console) {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS sensor_records (
            ${columnSql(SENSOR_RECORD_COLUMNS)}
        )
    `);

    if (typeof dbAll !== "function") {
        return;
    }

    const columns = await dbAll("PRAGMA table_info(sensor_records)");
    const existingNames = new Set(columns.map(column => column.name));
    await ensureTableColumns(dbRun, dbAll, "sensor_records", addableColumns(SENSOR_RECORD_COLUMNS));

    for (const column of SENSOR_RECORD_COLUMNS) {
        if (!column.type.includes("PRIMARY KEY") && !existingNames.has(column.name)) {
            logger.log(`[db] sensor_records added column ${column.name}`);
        }
    }
}

module.exports = {
    ensureSensorTimingColumns
};
