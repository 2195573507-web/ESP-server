require("dotenv").config();

const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const {
    buildSensorTimingFields,
    createTimeSyncRouter,
    withTimeSyncStatus
} = require("./server-time-sync/timeSync");
const { createVoiceRouter } = require("./routes/voice");

const app = express();

const DEFAULT_LLM_BASE_URL = "https://fai-gateway.vei.volces.com";
const DEFAULT_LLM_CHAT_PATH = "/v1/chat/completions";
const DEFAULT_LLM_MODEL = "Doubao-Seed-1.6-flash";
const DEFAULT_LLM_TIMEOUT_MS = 30000;
const LLM_TEXT_MAX_CHARS = 4000;

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

function readHistoryLimit(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 50;
    }

    return Math.min(numeric, 500);
}

function readPositiveInteger(value, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }

    return numeric;
}

function readLlmConfig() {
    const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL)
        .trim()
        .replace(/\/+$/, "");
    const chatPath = (process.env.LLM_CHAT_PATH || DEFAULT_LLM_CHAT_PATH).trim();

    return {
        apiKey: (process.env.LLM_API_KEY || "").trim(),
        baseUrl,
        chatPath: chatPath.startsWith("/") ? chatPath : `/${chatPath}`,
        model: (process.env.LLM_MODEL || DEFAULT_LLM_MODEL).trim() || DEFAULT_LLM_MODEL,
        timeoutMs: readPositiveInteger(process.env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS)
    };
}

function readLlmTextRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {
            error: "JSON object body is required"
        };
    }

    if (typeof body.text !== "string") {
        return {
            error: "text is required"
        };
    }

    const text = body.text.trim();
    if (!text) {
        return {
            error: "text is required"
        };
    }

    if (text.length > LLM_TEXT_MAX_CHARS) {
        return {
            error: `text exceeds ${LLM_TEXT_MAX_CHARS} characters`
        };
    }

    return {
        text,
        deviceId: typeof body.device_id === "string" ? body.device_id.trim() : "",
        sessionId: typeof body.session_id === "string" ? body.session_id.trim() : ""
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

function normalizeLlmContent(content) {
    if (typeof content === "string") {
        return content.trim();
    }

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === "string") {
                    return part;
                }

                if (part && typeof part.text === "string") {
                    return part.text;
                }

                return "";
            })
            .join("")
            .trim();
    }

    return "";
}

function extractLlmReply(payload) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const replyText = normalizeLlmContent(
        choice?.message?.content ??
        choice?.delta?.content ??
        choice?.text
    );

    return {
        text: replyText,
        model: typeof payload?.model === "string" && payload.model.trim() ? payload.model.trim() : ""
    };
}

function createLlmError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function describeLlmError(error) {
    const parts = [
        `name=${error?.name || "Error"}`
    ];

    if (error?.code) {
        parts.push(`code=${error.code}`);
    }

    if (typeof error?.status === "number") {
        parts.push(`upstream_status=${error.status}`);
    }

    if (typeof error?.bodyLength === "number") {
        parts.push(`body_len=${error.bodyLength}`);
    }

    return parts.join(" ");
}

async function requestLlmText(text, config) {
    if (!config.apiKey) {
        throw createLlmError("LLM_API_KEY_MISSING");
    }

    if (typeof fetch !== "function") {
        throw createLlmError("FETCH_UNAVAILABLE");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const endpoint = `${config.baseUrl}${config.chatPath}`;

    try {
        const upstreamResponse = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    {
                        role: "user",
                        content: text
                    }
                ],
                stream: false
            }),
            signal: controller.signal
        });
        const responseBody = await upstreamResponse.text();

        if (!upstreamResponse.ok) {
            const error = createLlmError("LLM_UPSTREAM_STATUS");
            error.status = upstreamResponse.status;
            error.bodyLength = responseBody.length;
            throw error;
        }

        let payload;
        try {
            payload = responseBody ? JSON.parse(responseBody) : null;
        } catch (parseError) {
            const error = createLlmError("LLM_JSON_PARSE_FAILED");
            error.bodyLength = responseBody.length;
            error.cause = parseError;
            throw error;
        }

        const reply = extractLlmReply(payload);
        if (!reply.text) {
            throw createLlmError("LLM_REPLY_EMPTY");
        }

        return {
            text: reply.text,
            model: reply.model || config.model
        };
    } finally {
        clearTimeout(timer);
    }
}

// Static frontend routes
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ESP text-only LLM proxy API
app.post("/api/llm/text", async (req, res) => {
    const llmRequest = readLlmTextRequest(req.body);
    if (llmRequest.error) {
        return res.status(400).json({
            ok: false,
            error: llmRequest.error
        });
    }

    const config = readLlmConfig();
    console.log(
        `[llm-text] request text_len=${llmRequest.text.length} device_id=${maskLogValue(llmRequest.deviceId)} session_id=${maskLogValue(llmRequest.sessionId)} api_key_len=${config.apiKey.length} model=${config.model}`
    );

    try {
        const llmResult = await requestLlmText(llmRequest.text, config);
        const serverTimeMs = Date.now();
        const insertResult = await dbRun(
            "INSERT INTO llm_records(timestamp,prompt,response) VALUES(?,?,?)",
            [serverTimeMs, llmRequest.text, llmResult.text]
        );

        console.log(
            `[llm-text] success id=${insertResult.lastID} reply_len=${llmResult.text.length} model=${llmResult.model}`
        );

        return res.json({
            ok: true,
            text: llmResult.text,
            id: insertResult.lastID,
            model: llmResult.model,
            server_time_ms: serverTimeMs
        });
    } catch (error) {
        console.error(`[llm-text] failed ${describeLlmError(error)}`);

        return res.status(500).json({
            ok: false,
            error: "LLM request failed"
        });
    }
});

// ESP server-side voice turn mock/protocol API
app.use("/api/voice", createVoiceRouter({
    db,
    requestLlmText,
    readLlmConfig
}));

// ESP ingest API
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

// Frontend query API
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

// 获取 Sensor 历史数据
app.get("/sensor/history", (req, res) => {
    const limit = readHistoryLimit(req.query.limit);

    db.all(
        `SELECT * FROM (
            SELECT * FROM sensor_records ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC`,
        [limit],
        (err, rows) => {
            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(rows || []);
        }
    );
});

// Health/debug API
app.use("/api/time", createTimeSyncRouter());

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
