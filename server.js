const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const {
    buildSensorTimingFields,
    createTimeSyncRouter,
    withTimeSyncStatus
} = require("./server-time-sync/timeSync");

const app = express();

app.use(express.json());
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({
            ok: false,
            error: "Invalid JSON body"
        });
    }

    return next(err);
});
app.use(express.static(path.join(__dirname, "public")));

// 数据库连接
const db = new sqlite3.Database(path.join(__dirname, "db", "database.db"));

const SENSOR_TIMING_COLUMNS = [
    { name: "device_id", type: "TEXT" },
    { name: "esp_time_ms", type: "INTEGER" },
    { name: "esp_uptime_ms", type: "INTEGER" },
    { name: "server_recv_ms", type: "INTEGER" },
    { name: "server_time_iso", type: "TEXT" },
    { name: "upload_delay_ms", type: "INTEGER" }
];

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                reject(err);
                return;
            }

            resolve(this);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(rows);
        });
    });
}

async function ensureSensorTimingColumns() {
    const columns = await dbAll("PRAGMA table_info(sensor_records)");
    const existingNames = new Set(columns.map(column => column.name));

    for (const column of SENSOR_TIMING_COLUMNS) {
        if (!existingNames.has(column.name)) {
            await dbRun(`ALTER TABLE sensor_records ADD COLUMN ${column.name} ${column.type}`);
            console.log(`[db] sensor_records added column ${column.name}`);
        }
    }
}

app.use("/api/time", createTimeSyncRouter());

// 首页跳转到仪表盘
app.get("/", (req, res) => {
    res.redirect("/dashboard");
});

// 获取最新 ASR
app.get("/asr/latest", (req, res) => {
    db.get(
        "SELECT * FROM asr_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row || {});
        }
    );
});

// 写入 ASR
app.post("/asr", (req, res) => {
    const { text } = req.body;

    db.run(
        "INSERT INTO asr_records(timestamp,text) VALUES(?,?)",
        [Date.now(), text],
        function (err) {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success: true,
                id: this.lastID
            });
        }
    );
});
// 获取最新 LLM
app.get("/llm/latest", (req, res) => {
    db.get(
        "SELECT * FROM llm_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row || {});
        }
    );
});

// 写入 LLM
app.post("/llm", (req, res) => {
    const { prompt, response } = req.body;

    db.run(
        "INSERT INTO llm_records(timestamp,prompt,response) VALUES(?,?,?)",
        [Date.now(), prompt, response],
        function (err) {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success: true,
                id: this.lastID
            });
        }
    );
});
// 获取最新 Sensor
app.get("/sensor/latest", (req, res) => {
    db.get(
        "SELECT * FROM sensor_records ORDER BY id DESC LIMIT 1",
        [],
        (err, row) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(row ? withTimeSyncStatus(row) : {});
        }
    );
});

// 写入 Sensor
app.post("/sensor", (req, res) => {
    const {
        temperature,
        humidity,
        pressure,
        gas_resistance
    } = req.body;
    const serverRecvMs = Date.now();
    const timing = buildSensorTimingFields(req.body, serverRecvMs);

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
                return res.status(500).json({
                    ok: false,
                    success: false,
                    error: err.message
                });
            }

            console.log(
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
// Dashboard
app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});
const PORT = process.env.PORT || 3000;

async function startServer() {
    await ensureSensorTimingColumns();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch(error => {
    console.error("[server] failed to start", error);
    process.exit(1);
});
