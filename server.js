require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const {
    buildSensorTimingFields,
    createTimeSyncRouter,
    withTimeSyncStatus
} = require("./server-time-sync/timeSync");

const app = express();

const LEGACY_LLM_BASE_URL = "https://fai-gateway.vei.volces.com";
const DEFAULT_LLM_BASE_URL = "https://ai-gateway.vei.volces.com";
const DEFAULT_LLM_CHAT_PATH = "/v1/chat/completions";
const DEFAULT_LLM_MODEL = "Doubao-Seed-1.6-flash";
const DEFAULT_LLM_TIMEOUT_MS = 30000;
const LLM_TEXT_MAX_CHARS = 4000;
const DEFAULT_VOLC_GATEWAY_WS_BASE_URL = "wss://ai-gateway.vei.volces.com";
const DEFAULT_VOLC_GATEWAY_HTTP_BASE_URL = "https://ai-gateway.vei.volces.com";
const DEFAULT_VOLC_GATEWAY_REALTIME_PATH = "/v1/realtime";
const DEFAULT_VOLC_GATEWAY_CHAT_PATH = "/v1/chat/completions";
const DEFAULT_VOLC_GATEWAY_ASR_MODEL = "bigmodel";
const DEFAULT_VOLC_GATEWAY_CHAT_MODEL = DEFAULT_LLM_MODEL;
const DEFAULT_VOLC_GATEWAY_ASR_FORMAT = "pcm";
const DEFAULT_VOLC_GATEWAY_ASR_CODEC = "raw";
const DEFAULT_VOLC_GATEWAY_ASR_RESOURCE_ID = "volc.bigasr.sauc.duration";
const DEFAULT_VOLC_GATEWAY_TTS_SAMPLE_RATE = 16000;
const DEFAULT_VOLC_GATEWAY_TTS_FORMAT = "pcm_s16le_mono_16k";
const DEFAULT_VOLC_GATEWAY_WS_AUDIO_CHUNK_BYTES = 32000;
const VOICE_TURN_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";
const VOICE_TURN_AUDIO_FORMAT = "pcm_s16le_mono_16k";
const DEFAULT_VOICE_TURN_TIMEOUT_MS = 45000;
const DEFAULT_VOICE_TURN_MAX_CONCURRENT = 1;
const DEFAULT_VOICE_TURN_MAX_BYTES = 4 * 1024 * 1024;
const VOICE_TURN_SAMPLE_RATE = 16000;
const VOICE_TURN_MOCK_BEEP_HZ = 1000;
const VOICE_TURN_MOCK_BEEP_AMPLITUDE = 12000;
const DEFAULT_TTS_FORMAT = VOICE_TURN_AUDIO_FORMAT;
const DEFAULT_TTS_SAMPLE_RATE = VOICE_TURN_SAMPLE_RATE;
const VOICE_WAKE_PROMPT_TEXT = "我在，你说";
const activeVoiceDevices = new Set();
let activeVoiceTurns = 0;
let legacyLlmBaseUrlWarned = false;

const voiceTurnRawParser = express.raw({
    type: () => true,
    limit: readPositiveInteger(process.env.VOICE_TURN_MAX_BYTES, DEFAULT_VOICE_TURN_MAX_BYTES),
    inflate: false
});

app.post("/api/voice/turn", voiceTurnRawParser, handleVoiceTurn);
app.get("/api/voice/prompt", handleVoicePrompt);

app.use(express.json());
app.use((err, req, res, next) => {
    if (req.path === "/api/voice/turn") {
        const status = err?.type === "entity.too.large" ? 413 : 400;
        const code = err?.type === "entity.too.large"
            ? "VOICE_BODY_TOO_LARGE"
            : "VOICE_BODY_PARSE_FAILED";
        const deviceId = readVoiceDeviceId(req);
        const inputBytes = Number.isFinite(err?.received)
            ? err.received
            : (Number.isFinite(err?.length) ? err.length : 0);

        console.warn(`[voice-turn] body parser failed device_id=${maskLogValue(deviceId)} input_bytes=${inputBytes} elapsed_ms=0 code=${code} status=${status} message=${JSON.stringify(err?.message || "-")}`);
        return sendVoiceError(res, status, code, err?.message || "Invalid PCM request body");
    }

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

function parseContentType(value) {
    const parts = String(value || "")
        .split(";")
        .map(part => part.trim())
        .filter(Boolean);
    const mediaType = (parts.shift() || "").toLowerCase();
    const params = {};

    for (const part of parts) {
        const separator = part.indexOf("=");
        if (separator <= 0) {
            continue;
        }

        const key = part.slice(0, separator).trim().toLowerCase();
        const rawValue = part.slice(separator + 1).trim();
        params[key] = rawValue.replace(/^"|"$/g, "");
    }

    return {
        mediaType,
        params
    };
}

function isVoiceTurnContentType(value) {
    const parsed = parseContentType(value);

    return parsed.mediaType === "audio/l16" &&
        parsed.params.rate === "16000" &&
        parsed.params.channels === "1";
}

function isVoiceTurnAudioFormat(value) {
    return String(value || "").trim().toLowerCase() === VOICE_TURN_AUDIO_FORMAT;
}

function readVoiceTurnConfig() {
    return {
        timeoutMs: readPositiveInteger(process.env.VOICE_TURN_TIMEOUT_MS, DEFAULT_VOICE_TURN_TIMEOUT_MS),
        maxConcurrent: readPositiveInteger(process.env.VOICE_TURN_MAX_CONCURRENT, DEFAULT_VOICE_TURN_MAX_CONCURRENT),
        mockEnabled: String(process.env.VOICE_TURN_MOCK || "").trim() === "1",
        wsAudioChunkBytes: readPositiveInteger(
            process.env.VOLC_GATEWAY_WS_AUDIO_CHUNK_BYTES,
            DEFAULT_VOLC_GATEWAY_WS_AUDIO_CHUNK_BYTES
        )
    };
}

function readTrimmedEnv(name, fallback = "") {
    const value = process.env[name];
    if (typeof value !== "string") {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
}

function readFirstTrimmedEnv(names, fallback = "") {
    for (const name of names) {
        const value = readTrimmedEnv(name);
        if (value) {
            return value;
        }
    }

    return fallback;
}

function readFirstGatewayPathEnv(names, fallback = "") {
    return normalizeGatewayPathValue(readFirstTrimmedEnv(names, fallback));
}

function readBooleanFlag(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeBaseUrl(value, fallback, expectedProtocols) {
    const rawValue = readTrimmedEnv(value, fallback).replace(/\/+$/, "");
    let parsed;
    try {
        parsed = new URL(rawValue);
    } catch (_) {
        return rawValue;
    }

    if (expectedProtocols.includes(parsed.protocol)) {
        return rawValue;
    }

    return rawValue;
}

function normalizeGatewayPathValue(value) {
    const pathValue = String(value || "").trim();
    if (!pathValue) {
        return "";
    }

    if (/^https?:\/\//i.test(pathValue) || /^wss?:\/\//i.test(pathValue)) {
        return pathValue;
    }

    return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function readGatewayPathEnv(name, fallback) {
    return normalizeGatewayPathValue(readTrimmedEnv(name, fallback));
}

function buildGatewayHttpUrl(baseUrl, pathValue) {
    const normalizedPath = normalizeGatewayPathValue(pathValue);
    if (/^https?:\/\//i.test(normalizedPath) || /^wss?:\/\//i.test(normalizedPath)) {
        return normalizedPath;
    }

    return `${baseUrl.replace(/\/+$/, "")}${normalizedPath || "/"}`;
}

function buildGatewayRealtimeUrl(baseUrl, pathValue, model) {
    const normalizedPath = normalizeGatewayPathValue(pathValue);
    const rawUrl = /^wss?:\/\//i.test(normalizedPath) || /^https?:\/\//i.test(normalizedPath)
        ? normalizedPath.replace(/^http/i, "ws")
        : buildGatewayHttpUrl(baseUrl.replace(/^http/i, "ws"), normalizedPath);
    const url = new URL(rawUrl);
    url.searchParams.set("model", model);
    return url.toString();
}

function buildGatewayTtsUrl(wsBaseUrl, httpBaseUrl, pathValue, model) {
    if (/^https?:\/\//i.test(pathValue) || /^wss?:\/\//i.test(pathValue)) {
        const url = new URL(pathValue);
        if (url.protocol === "ws:" || url.protocol === "wss:") {
            url.searchParams.set("model", model);
        }
        return url.toString();
    }

    if (pathValue.toLowerCase().includes("realtime")) {
        return buildGatewayRealtimeUrl(wsBaseUrl, pathValue, model);
    }

    return buildGatewayHttpUrl(httpBaseUrl, pathValue);
}

function summarizeSecret(value) {
    const secret = String(value || "");
    const length = secret.length;
    if (length === 0) {
        return "len=0, masked=-";
    }

    if (length <= 8) {
        return `len=${length}, masked=${secret.slice(0, 1)}***${secret.slice(-1)}`;
    }

    return `len=${length}, masked=${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function maskUrlForLog(value) {
    if (!value) {
        return "-";
    }

    try {
        const url = new URL(value);
        for (const key of Array.from(url.searchParams.keys())) {
            if (/key|token|secret|auth|password/i.test(key)) {
                url.searchParams.set(key, "***");
            }
        }
        return url.toString();
    } catch (_) {
        return normalizeLogPreview(value, 160);
    }
}

function readVolcGatewayConfig() {
    const apiKey = readTrimmedEnv("VOLC_GATEWAY_API_KEY");
    const wsBaseUrl = normalizeBaseUrl(
        "VOLC_GATEWAY_WS_BASE_URL",
        DEFAULT_VOLC_GATEWAY_WS_BASE_URL,
        ["ws:", "wss:"]
    );
    const httpBaseUrl = normalizeBaseUrl(
        "VOLC_GATEWAY_HTTP_BASE_URL",
        DEFAULT_VOLC_GATEWAY_HTTP_BASE_URL,
        ["http:", "https:"]
    );
    const realtimePath = readGatewayPathEnv("VOLC_GATEWAY_REALTIME_PATH", DEFAULT_VOLC_GATEWAY_REALTIME_PATH);
    const chatPath = readGatewayPathEnv("VOLC_GATEWAY_CHAT_PATH", DEFAULT_VOLC_GATEWAY_CHAT_PATH);
    const asrModel = readTrimmedEnv("VOLC_GATEWAY_ASR_MODEL", DEFAULT_VOLC_GATEWAY_ASR_MODEL);
    const chatModel = readTrimmedEnv("VOLC_GATEWAY_CHAT_MODEL", DEFAULT_VOLC_GATEWAY_CHAT_MODEL);
    const ttsModel = readFirstTrimmedEnv([
        "VOLC_GATEWAY_TTS_MODEL",
        "LLM_MODEL_TTS",
        "LLM_GATEWAY_TTS_MODEL",
        "TTS_MODEL"
    ]);
    const ttsVoice = readFirstTrimmedEnv([
        "VOLC_GATEWAY_TTS_VOICE",
        "LLM_TTS_VOICE",
        "TTS_VOICE",
        "TTS_VOICE_TYPE",
        "VOICE_TYPE"
    ]);
    const ttsPath = readFirstGatewayPathEnv([
        "VOLC_GATEWAY_TTS_PATH",
        "VOLC_GATEWAY_TTS_REALTIME_PATH",
        "LLM_TTS_PATH",
        "TTS_PATH",
        "TTS_URL",
        "TTS_ENDPOINT"
    ], ttsModel ? realtimePath : "");
    const asrSampleRate = readPositiveInteger(
        process.env.VOLC_GATEWAY_ASR_SAMPLE_RATE,
        VOICE_TURN_SAMPLE_RATE
    );
    const asrBits = readPositiveInteger(process.env.VOLC_GATEWAY_ASR_BITS, 16);
    const asrChannels = readPositiveInteger(process.env.VOLC_GATEWAY_ASR_CHANNELS, 1);
    const ttsSampleRate = readPositiveInteger(
        process.env.VOLC_GATEWAY_TTS_SAMPLE_RATE,
        DEFAULT_VOLC_GATEWAY_TTS_SAMPLE_RATE
    );
    const ttsFormat = readTrimmedEnv("VOLC_GATEWAY_TTS_FORMAT", DEFAULT_VOLC_GATEWAY_TTS_FORMAT);
    const ttsResourceId = readTrimmedEnv("VOLC_GATEWAY_TTS_RESOURCE_ID");

    return {
        apiKey,
        keySummary: summarizeSecret(apiKey),
        wsBaseUrl,
        httpBaseUrl,
        realtimePath,
        chatPath,
        asr: {
            model: asrModel,
            url: buildGatewayRealtimeUrl(wsBaseUrl, realtimePath, asrModel),
            sampleRate: asrSampleRate,
            bits: asrBits,
            channels: asrChannels,
            format: readTrimmedEnv("VOLC_GATEWAY_ASR_FORMAT", DEFAULT_VOLC_GATEWAY_ASR_FORMAT),
            codec: readTrimmedEnv("VOLC_GATEWAY_ASR_CODEC", DEFAULT_VOLC_GATEWAY_ASR_CODEC),
            useResourceId: readBooleanFlag(process.env.VOLC_GATEWAY_USE_RESOURCE_ID),
            resourceId: readTrimmedEnv("VOLC_GATEWAY_ASR_RESOURCE_ID", DEFAULT_VOLC_GATEWAY_ASR_RESOURCE_ID)
        },
        chat: {
            baseUrl: httpBaseUrl,
            path: chatPath,
            endpoint: buildGatewayHttpUrl(httpBaseUrl, chatPath),
            model: chatModel
        },
        tts: {
            model: ttsModel,
            voice: ttsVoice,
            path: ttsPath,
            url: ttsModel && ttsPath ? buildGatewayTtsUrl(wsBaseUrl, httpBaseUrl, ttsPath, ttsModel) : "",
            sampleRate: ttsSampleRate,
            format: ttsFormat,
            useResourceId: readBooleanFlag(process.env.VOLC_GATEWAY_TTS_USE_RESOURCE_ID),
            resourceId: ttsResourceId
        }
    };
}

function validateUrl(value, protocols, code, envName) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        return {
            status: 503,
            code,
            message: `${envName} must be an absolute http(s) URL`
        };
    }

    if (!protocols.includes(parsed.protocol)) {
        return {
            status: 503,
            code,
            message: `${envName} must use ${protocols.join(" or ").replace(/:/g, "")}`
        };
    }

    return null;
}

function validateVoiceAsrConfig(config) {
    if (!config.apiKey || !config.asr.model) {
        return {
            status: 503,
            code: "VOICE_ASR_NOT_CONFIGURED",
            message: "VOLC_GATEWAY_API_KEY and VOLC_GATEWAY_ASR_MODEL must be configured when VOICE_TURN_MOCK is not 1"
        };
    }

    const urlError = validateUrl(config.asr.url, ["ws:", "wss:"], "VOICE_ASR_NOT_CONFIGURED", "VOLC_GATEWAY_WS_BASE_URL/VOLC_GATEWAY_REALTIME_PATH");
    if (urlError) {
        return urlError;
    }

    if (config.asr.sampleRate !== VOICE_TURN_SAMPLE_RATE ||
        config.asr.bits !== 16 ||
        config.asr.channels !== 1 ||
        config.asr.format !== DEFAULT_VOLC_GATEWAY_ASR_FORMAT ||
        config.asr.codec !== DEFAULT_VOLC_GATEWAY_ASR_CODEC) {
        return {
            status: 503,
            code: "VOICE_ASR_NOT_CONFIGURED",
            message: "VOLC_GATEWAY_ASR_* must describe pcm_s16le_mono_16k raw PCM"
        };
    }

    return null;
}

function validateVoiceChatConfig(config) {
    if (!config.apiKey || !config.chat.model) {
        return {
            status: 503,
            code: "VOICE_LLM_FAILED",
            message: "VOLC_GATEWAY_API_KEY and VOLC_GATEWAY_CHAT_MODEL must be configured when VOICE_TURN_MOCK is not 1"
        };
    }

    return validateUrl(config.chat.endpoint, ["http:", "https:"], "VOICE_LLM_FAILED", "VOLC_GATEWAY_HTTP_BASE_URL/VOLC_GATEWAY_CHAT_PATH");
}

function validateVoiceTtsConfig(config) {
    if (!config.apiKey || !config.tts.model || !config.tts.voice || !config.tts.path) {
        return {
            status: 503,
            code: "VOICE_TTS_NOT_CONFIGURED",
            message: "VOLC_GATEWAY_TTS_MODEL, VOLC_GATEWAY_TTS_VOICE, and VOLC_GATEWAY_TTS_PATH must be configured when VOICE_TURN_MOCK is not 1"
        };
    }

    const urlError = validateUrl(config.tts.url, ["ws:", "wss:", "http:", "https:"], "VOICE_TTS_NOT_CONFIGURED", "VOLC_GATEWAY_WS_BASE_URL/VOLC_GATEWAY_TTS_PATH");
    if (urlError) {
        return urlError;
    }

    if (config.tts.format !== VOICE_TURN_AUDIO_FORMAT) {
        return {
            status: 503,
            code: "VOICE_TTS_NOT_CONFIGURED",
            message: `VOLC_GATEWAY_TTS_FORMAT must be ${VOICE_TURN_AUDIO_FORMAT}`
        };
    }

    if (config.tts.sampleRate !== VOICE_TURN_SAMPLE_RATE) {
        return {
            status: 503,
            code: "VOICE_TTS_NOT_CONFIGURED",
            message: `VOLC_GATEWAY_TTS_SAMPLE_RATE must be ${VOICE_TURN_SAMPLE_RATE}`
        };
    }

    return null;
}

function readVoiceDeviceId(req) {
    const value = readOptionalVoiceDeviceId(req) ||
        req.ip ||
        "unknown";

    return String(value).trim() || "unknown";
}

function readOptionalVoiceDeviceId(req) {
    const value = req.get("device_id") ||
        req.get("Device-Id") ||
        req.get("X-Device-Id") ||
        req.get("X-ESP-Device-Id") ||
        req.get("X-Client-Id") ||
        req.query.device_id;

    return String(value || "").trim();
}

function validateVoiceTurnRequest(req) {
    if (!isVoiceTurnContentType(req.get("Content-Type"))) {
        return {
            status: 415,
            code: "VOICE_UNSUPPORTED_CONTENT_TYPE",
            message: `Content-Type must be ${VOICE_TURN_CONTENT_TYPE}`
        };
    }

    if (!isVoiceTurnAudioFormat(req.get("X-Audio-Format"))) {
        return {
            status: 415,
            code: "VOICE_UNSUPPORTED_AUDIO_FORMAT",
            message: `X-Audio-Format must be ${VOICE_TURN_AUDIO_FORMAT}`
        };
    }

    if (!Buffer.isBuffer(req.body)) {
        return {
            status: 400,
            code: "VOICE_BODY_REQUIRED",
            message: "PCM request body is required"
        };
    }

    if (req.body.length === 0) {
        return {
            status: 400,
            code: "VOICE_BODY_EMPTY",
            message: "PCM request body must not be empty"
        };
    }

    if (req.body.length % 2 !== 0) {
        return {
            status: 400,
            code: "VOICE_PCM_ALIGNMENT_INVALID",
            message: "PCM s16le body length must be an even number of bytes"
        };
    }

    return null;
}

function acquireVoiceTurn(deviceId, config) {
    if (activeVoiceDevices.has(deviceId)) {
        return {
            status: 409,
            code: "VOICE_DEVICE_BUSY",
            message: "Device already has an active voice turn"
        };
    }

    if (activeVoiceTurns >= config.maxConcurrent) {
        return {
            status: 429,
            code: "VOICE_SERVER_BUSY",
            message: "Voice turn concurrency limit reached"
        };
    }

    activeVoiceDevices.add(deviceId);
    activeVoiceTurns += 1;
    return null;
}

function releaseVoiceTurn(deviceId) {
    if (activeVoiceDevices.delete(deviceId)) {
        activeVoiceTurns = Math.max(0, activeVoiceTurns - 1);
    }
}

function createVoiceError(code, message, status) {
    const error = new Error(message || code);
    error.code = code;
    error.status = status;
    return error;
}

function normalizeLogPreview(value, maxLength = 500) {
    const preview = String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    if (preview.length <= maxLength) {
        return preview;
    }

    return `${preview.slice(0, maxLength)}...`;
}

function extractErrorMessageFromBody(body) {
    const preview = normalizeLogPreview(body);
    if (!preview) {
        return "";
    }

    try {
        const payload = JSON.parse(body);
        const message = payload?.error?.message ||
            payload?.error?.code ||
            payload?.error ||
            payload?.message ||
            payload?.code;

        if (typeof message === "string" && message.trim()) {
            return message.trim();
        }
    } catch (_) {
        // Non-JSON upstream errors are still useful as bounded log previews.
    }

    return preview;
}

function describeVoiceError(error) {
    const parts = [
        `name=${error?.name || "Error"}`
    ];

    if (error?.stage) {
        parts.push(`stage=${error.stage}`);
    }

    if (error?.code) {
        parts.push(`code=${error.code}`);
    }

    if (typeof error?.status === "number") {
        parts.push(`status=${error.status}`);
    }

    if (typeof error?.upstreamStatus === "number") {
        parts.push(`upstream_status=${error.upstreamStatus}`);
    }

    if (typeof error?.bytes === "number") {
        parts.push(`bytes=${error.bytes}`);
    }

    if (typeof error?.bodyLength === "number") {
        parts.push(`body_len=${error.bodyLength}`);
    }

    if (error?.endpoint) {
        parts.push(`endpoint=${maskUrlForLog(error.endpoint)}`);
    }

    if (error?.model) {
        parts.push(`model=${error.model}`);
    }

    if (error?.bodyPreview) {
        parts.push(`body=${JSON.stringify(error.bodyPreview)}`);
    }

    return parts.join(" ");
}

function sendVoiceError(res, status, code, message, details = {}) {
    if (res.headersSent) {
        res.end();
        return;
    }

    const headers = {
        "X-Error-Code": code
    };
    const payload = {
        ok: false,
        code,
        error: message
    };

    if (typeof details.upstreamStatus === "number") {
        headers["X-Upstream-Status"] = String(details.upstreamStatus);
        payload.upstream_status = details.upstreamStatus;
    }

    res
        .status(status)
        .set(headers)
        .json(payload);
}

function writeVoiceTurnHeaders(res) {
    res
        .status(200)
        .set({
            "Content-Type": VOICE_TURN_CONTENT_TYPE,
            "X-Audio-Format": VOICE_TURN_AUDIO_FORMAT,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
}

function createMockVoiceTurnPcm(byteLength) {
    const output = Buffer.alloc(byteLength);
    const sampleCount = Math.floor(byteLength / 2);

    for (let i = 0; i < sampleCount; i += 1) {
        const phase = (2 * Math.PI * VOICE_TURN_MOCK_BEEP_HZ * i) / VOICE_TURN_SAMPLE_RATE;
        const sample = Math.round(Math.sin(phase) * VOICE_TURN_MOCK_BEEP_AMPLITUDE);
        output.writeInt16LE(sample, i * 2);
    }

    return output;
}

async function streamMockVoiceTurn(audioBuffer, res) {
    writeVoiceTurnHeaders(res);
    res.end(createMockVoiceTurnPcm(audioBuffer.length));

    return {
        bytes: audioBuffer.length,
        mode: "mock",
        asrTextLength: 0,
        llmReplyLength: 0,
        ttsPcmBytes: 0
    };
}

function createVoiceStageError(stage, code, message, status, details = {}) {
    const error = createVoiceError(code, message, status);
    error.stage = stage;
    Object.assign(error, details);
    return error;
}

function createUpstreamVoiceStageError(stage, code, response, responseBody, fallbackMessage) {
    const upstreamMessage = extractErrorMessageFromBody(responseBody);
    return createVoiceStageError(
        stage,
        code,
        upstreamMessage || fallbackMessage,
        502,
        {
            upstreamStatus: response.status,
            bodyLength: responseBody.length,
            bodyPreview: normalizeLogPreview(responseBody)
        }
    );
}

function findStringField(value, keys, visited = new Set()) {
    if (!value || typeof value !== "object") {
        return "";
    }

    if (visited.has(value)) {
        return "";
    }
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findStringField(item, keys, visited);
            if (found) {
                return found;
            }
        }

        return "";
    }

    for (const key of keys) {
        const fieldValue = value[key];
        if (typeof fieldValue === "string" && fieldValue.trim()) {
            return fieldValue.trim();
        }
    }

    for (const fieldValue of Object.values(value)) {
        const found = findStringField(fieldValue, keys, visited);
        if (found) {
            return found;
        }
    }

    return "";
}

function extractAsrTextFromBody(responseBody) {
    const trimmed = responseBody.trim();
    if (!trimmed) {
        return "";
    }

    try {
        const payload = JSON.parse(trimmed);
        return findStringField(payload, [
            "text",
            "asr_text",
            "transcript",
            "utterance",
            "result_text",
            "final_text",
            "content"
        ]);
    } catch (_) {
        return trimmed;
    }
}

function decodeBase64Buffer(value) {
    if (typeof value !== "string") {
        return null;
    }

    let normalized = value.trim();
    const dataUrlMatch = normalized.match(/^data:[^,]+,(.+)$/i);
    if (dataUrlMatch) {
        normalized = dataUrlMatch[1];
    }

    normalized = normalized.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        return null;
    }

    const decoded = Buffer.from(normalized, "base64");
    return decoded.length > 0 ? decoded : null;
}

function contentTypeIndicatesUnsupportedAudio(contentType) {
    const normalized = String(contentType || "").toLowerCase();
    return normalized.includes("audio/mpeg") ||
        normalized.includes("audio/mp3") ||
        normalized.includes("audio/ogg") ||
        normalized.includes("audio/flac") ||
        normalized.includes("audio/aac") ||
        normalized.includes("audio/mp4") ||
        normalized.includes("audio/webm") ||
        normalized.includes("application/ogg") ||
        normalized.includes("video/mp4") ||
        normalized.includes("video/webm") ||
        normalized.includes("application/json");
}

function bufferLooksLikeUnsupportedAudio(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return false;
    }

    const trimmedStart = buffer.toString("utf8", 0, Math.min(buffer.length, 32)).trimStart();
    return buffer.toString("ascii", 0, 3) === "ID3" ||
        buffer.toString("ascii", 0, 4) === "OggS" ||
        buffer.toString("ascii", 0, 4) === "fLaC" ||
        (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) ||
        buffer.toString("ascii", 4, 8) === "ftyp" ||
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
        trimmedStart.startsWith("{") ||
        trimmedStart.startsWith("[");
}

function extractPcmFromWav(buffer) {
    let fmt = null;
    let dataStart = -1;
    let dataEnd = -1;
    let offset = 12;

    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString("ascii", offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkSize;

        if (chunkEnd > buffer.length) {
            throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS WAV response is truncated", 502);
        }

        if (chunkId === "fmt ") {
            if (chunkSize < 16) {
                throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS WAV fmt chunk is invalid", 502);
            }

            fmt = {
                audioFormat: buffer.readUInt16LE(chunkStart),
                channels: buffer.readUInt16LE(chunkStart + 2),
                sampleRate: buffer.readUInt32LE(chunkStart + 4),
                bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
            };
        } else if (chunkId === "data") {
            dataStart = chunkStart;
            dataEnd = chunkEnd;
        }

        offset = chunkEnd + (chunkSize % 2);
    }

    if (!fmt || dataStart < 0) {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS WAV response is missing fmt or data chunk", 502);
    }

    if (fmt.audioFormat !== 1 ||
        fmt.channels !== 1 ||
        fmt.sampleRate !== VOICE_TURN_SAMPLE_RATE ||
        fmt.bitsPerSample !== 16) {
        throw createVoiceStageError(
            "tts",
            "VOICE_TTS_FAILED",
            "TTS WAV response must be PCM s16le mono 16kHz",
            502
        );
    }

    return buffer.subarray(dataStart, dataEnd);
}

function normalizeTtsPcmBuffer(buffer, contentType = "") {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS response did not contain audio", 502);
    }

    if (contentTypeIndicatesUnsupportedAudio(contentType) || bufferLooksLikeUnsupportedAudio(buffer)) {
        throw createVoiceStageError("tts", "VOICE_TTS_UNSUPPORTED_FORMAT", "TTS response must be raw PCM or WAV PCM s16le mono 16kHz", 502, {
            bodyLength: buffer.length
        });
    }

    let pcmBuffer = buffer;
    if (buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WAVE") {
        pcmBuffer = extractPcmFromWav(buffer);
    }

    if (pcmBuffer.length === 0 || pcmBuffer.length % 2 !== 0) {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS PCM response must be non-empty s16le data", 502);
    }

    return pcmBuffer;
}

function isSilentPcmBuffer(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
        return true;
    }

    for (let offset = 0; offset < pcmBuffer.length; offset += 1) {
        if (pcmBuffer[offset] !== 0) {
            return false;
        }
    }

    return true;
}

function extractTtsPcmFromJson(responseBody) {
    let payload;
    try {
        payload = JSON.parse(responseBody);
    } catch (error) {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS JSON response could not be parsed", 502, {
            bodyLength: responseBody.length,
            bodyPreview: normalizeLogPreview(responseBody),
            cause: error
        });
    }

    const encodedAudio = findStringField(payload, [
        "pcm_base64",
        "audio_base64",
        "pcm",
        "audio",
        "data"
    ]);
    const decoded = decodeBase64Buffer(encodedAudio);
    if (!decoded) {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS JSON response did not contain base64 PCM audio", 502, {
            bodyLength: responseBody.length,
            bodyPreview: normalizeLogPreview(responseBody)
        });
    }

    return normalizeTtsPcmBuffer(decoded);
}

function maybeExtractTtsPcmFromJson(responseBuffer) {
    const responseBody = responseBuffer.toString("utf8");
    const preview = responseBody.trimStart();
    const trimmed = preview.trimEnd();
    const looksLikeJson = (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (!looksLikeJson) {
        return null;
    }

    return extractTtsPcmFromJson(responseBody);
}

function buildVolcGatewayHeaders(config, purpose) {
    const headers = {
        Authorization: `Bearer ${config.apiKey}`
    };

    if (purpose === "asr" && config.asr.useResourceId && config.asr.resourceId) {
        headers["X-Api-Resource-Id"] = config.asr.resourceId;
    }

    if (purpose === "tts" && config.tts.useResourceId && config.tts.resourceId) {
        headers["X-Api-Resource-Id"] = config.tts.resourceId;
    }

    return headers;
}

function createAbortError() {
    const error = new Error("Operation was aborted");
    error.name = "AbortError";
    return error;
}

function createWebSocketAcceptValue(key) {
    return crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const headerLength = body.length < 126 ? 2 : (body.length <= 0xffff ? 4 : 10);
    const maskKey = crypto.randomBytes(4);
    const frame = Buffer.alloc(headerLength + 4 + body.length);
    frame[0] = 0x80 | opcode;

    if (body.length < 126) {
        frame[1] = 0x80 | body.length;
        maskKey.copy(frame, 2);
        for (let i = 0; i < body.length; i += 1) {
            frame[6 + i] = body[i] ^ maskKey[i % 4];
        }
        return frame;
    }

    if (body.length <= 0xffff) {
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(body.length, 2);
        maskKey.copy(frame, 4);
        for (let i = 0; i < body.length; i += 1) {
            frame[8 + i] = body[i] ^ maskKey[i % 4];
        }
        return frame;
    }

    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
    maskKey.copy(frame, 10);
    for (let i = 0; i < body.length; i += 1) {
        frame[14 + i] = body[i] ^ maskKey[i % 4];
    }
    return frame;
}

class MinimalWebSocket {
    constructor(socket, stage) {
        this.socket = socket;
        this.stage = stage;
        this.buffer = Buffer.alloc(0);
        this.messages = [];
        this.waiters = [];
        this.closed = false;
        this.closeError = null;
        this.fragmentOpcode = 0;
        this.fragmentBuffers = [];

        socket.on("data", chunk => this.onData(chunk));
        socket.on("error", error => this.fail(error));
        socket.on("close", () => this.close());
    }

    sendText(text) {
        if (this.closed) {
            throw createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, "Realtime WebSocket is closed", 502);
        }

        this.socket.write(encodeWebSocketFrame(0x1, Buffer.from(text)));
    }

    sendClose() {
        if (!this.closed) {
            this.socket.end(encodeWebSocketFrame(0x8));
        }
    }

    close() {
        if (this.closed) {
            return;
        }

        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter.reject(this.closeError || createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, "Realtime WebSocket closed before completion", 502));
        }
    }

    fail(error) {
        this.closeError = error?.code
            ? error
            : createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, error?.message || "Realtime WebSocket failed", 502, {
                cause: error
            });
        this.close();
    }

    pushMessage(message) {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.resolve(message);
            return;
        }

        this.messages.push(message);
    }

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 2) {
            const first = this.buffer[0];
            const second = this.buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let payloadLength = second & 0x7f;
            let offset = 2;

            if (payloadLength === 126) {
                if (this.buffer.length < offset + 2) {
                    return;
                }
                payloadLength = this.buffer.readUInt16BE(offset);
                offset += 2;
            } else if (payloadLength === 127) {
                if (this.buffer.length < offset + 8) {
                    return;
                }
                const bigLength = this.buffer.readBigUInt64BE(offset);
                if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                    this.fail(createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, "Realtime WebSocket frame is too large", 502));
                    return;
                }
                payloadLength = Number(bigLength);
                offset += 8;
            }

            let maskKey = null;
            if (masked) {
                if (this.buffer.length < offset + 4) {
                    return;
                }
                maskKey = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }

            if (this.buffer.length < offset + payloadLength) {
                return;
            }

            let payload = this.buffer.subarray(offset, offset + payloadLength);
            this.buffer = this.buffer.subarray(offset + payloadLength);

            if (masked && maskKey) {
                const unmasked = Buffer.alloc(payload.length);
                for (let i = 0; i < payload.length; i += 1) {
                    unmasked[i] = payload[i] ^ maskKey[i % 4];
                }
                payload = unmasked;
            }

            this.handleFrame(opcode, fin, payload);
        }
    }

    handleFrame(opcode, fin, payload) {
        if (opcode === 0x8) {
            this.sendClose();
            this.close();
            return;
        }

        if (opcode === 0x9) {
            this.socket.write(encodeWebSocketFrame(0xA, payload));
            return;
        }

        if (opcode === 0xA) {
            return;
        }

        if (opcode === 0x1 || opcode === 0x2) {
            if (fin) {
                this.pushMessage(payload.toString("utf8"));
                return;
            }
            this.fragmentOpcode = opcode;
            this.fragmentBuffers = [payload];
            return;
        }

        if (opcode === 0x0 && this.fragmentOpcode !== 0) {
            this.fragmentBuffers.push(payload);
            if (fin) {
                const message = Buffer.concat(this.fragmentBuffers).toString("utf8");
                this.fragmentOpcode = 0;
                this.fragmentBuffers = [];
                this.pushMessage(message);
            }
            return;
        }

        this.fail(createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, `Unsupported Realtime WebSocket opcode ${opcode}`, 502));
    }

    nextMessage(signal) {
        if (this.messages.length > 0) {
            return Promise.resolve(this.messages.shift());
        }

        if (this.closed) {
            return Promise.reject(this.closeError || createVoiceStageError(this.stage, `VOICE_${this.stage.toUpperCase()}_FAILED`, "Realtime WebSocket closed before completion", 502));
        }

        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) {
                    this.waiters.splice(index, 1);
                }
                reject(createAbortError());
            };

            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }

            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }

            waiter.resolve = value => {
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve(value);
            };
            waiter.reject = error => {
                if (signal) {
                    signal.removeEventListener("abort", onAbort);
                }
                reject(error);
            };
            this.waiters.push(waiter);
        });
    }
}

function openRealtimeWebSocket(url, headers, signal, stage) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request = null;
        const parsed = new URL(url);
        const isSecure = parsed.protocol === "wss:";
        const transport = isSecure ? https : http;
        const key = crypto.randomBytes(16).toString("base64");
        const requestHeaders = {
            Host: parsed.host,
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
            ...headers
        };

        const finishReject = error => {
            if (settled) {
                return;
            }
            settled = true;
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            reject(error);
        };
        const finishResolve = ws => {
            if (settled) {
                ws.sendClose();
                return;
            }
            settled = true;
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            resolve(ws);
        };
        const onAbort = () => {
            if (request) {
                request.destroy(createAbortError());
            }
            finishReject(createAbortError());
        };

        if (signal?.aborted) {
            finishReject(createAbortError());
            return;
        }
        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        request = transport.request({
            protocol: isSecure ? "https:" : "http:",
            hostname: parsed.hostname,
            port: parsed.port || (isSecure ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method: "GET",
            headers: requestHeaders
        });

        request.once("upgrade", (response, socket, head) => {
            const expectedAccept = createWebSocketAcceptValue(key);
            const actualAccept = response.headers["sec-websocket-accept"];
            if (response.statusCode !== 101 || actualAccept !== expectedAccept) {
                socket.destroy();
                finishReject(createVoiceStageError(stage, `VOICE_${stage.toUpperCase()}_FAILED`, "Realtime WebSocket upgrade was rejected", 502, {
                    upstreamStatus: response.statusCode,
                    endpoint: url
                }));
                return;
            }

            const ws = new MinimalWebSocket(socket, stage);
            if (head && head.length > 0) {
                ws.onData(head);
            }
            finishResolve(ws);
        });

        request.once("response", response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                finishReject(createVoiceStageError(stage, `VOICE_${stage.toUpperCase()}_FAILED`, extractErrorMessageFromBody(body) || "Realtime WebSocket upgrade failed", 502, {
                    upstreamStatus: response.statusCode,
                    bodyLength: body.length,
                    bodyPreview: normalizeLogPreview(body),
                    endpoint: url
                }));
            });
        });

        request.once("error", error => {
            if (error?.name === "AbortError") {
                finishReject(error);
                return;
            }
            finishReject(createVoiceStageError(stage, `VOICE_${stage.toUpperCase()}_FAILED`, error?.message || "Realtime WebSocket connection failed", 502, {
                endpoint: url,
                cause: error
            }));
        });

        request.end();
    });
}

function parseRealtimeJsonMessage(message, stage) {
    try {
        return JSON.parse(message);
    } catch (error) {
        throw createVoiceStageError(stage, `VOICE_${stage.toUpperCase()}_FAILED`, "Realtime WebSocket response was not valid JSON", 502, {
            bodyLength: message.length,
            bodyPreview: normalizeLogPreview(message),
            cause: error
        });
    }
}

function readRealtimeEventName(payload) {
    return typeof payload?.type === "string" && payload.type
        ? payload.type
        : (typeof payload?.event === "string" ? payload.event : "");
}

function extractRealtimeErrorMessage(payload) {
    const errorValue = payload?.error;
    if (typeof errorValue === "string" && errorValue.trim()) {
        return errorValue.trim();
    }

    if (errorValue && typeof errorValue === "object") {
        return findStringField(errorValue, ["message", "code", "error"]);
    }

    return findStringField(payload, ["message", "code"]);
}

function parseAsrRealtimeEvent(message) {
    const payload = parseRealtimeJsonMessage(message, "asr");
    const eventName = readRealtimeEventName(payload);
    const lowerName = eventName.toLowerCase();
    const text = findStringField(payload, [
        "text",
        "asr_text",
        "transcript",
        "utterance",
        "result_text",
        "final_text",
        "content",
        "delta"
    ]);

    return {
        eventName,
        text,
        isError: lowerName.includes("error") || Boolean(payload?.error),
        errorMessage: extractRealtimeErrorMessage(payload),
        isFinal: lowerName.includes("final") ||
            lowerName.includes("completed") ||
            lowerName.includes("conversation.item.input_audio_transcription.completed") ||
            lowerName.includes("transcription.done") ||
            payload?.final === true,
        isPartial: lowerName.includes("partial") ||
            lowerName.includes("conversation.item.input_audio_transcription.result") ||
            lowerName.includes("delta") ||
            lowerName.includes("transcription.delta")
    };
}

function parseTtsRealtimeEvent(message) {
    const payload = parseRealtimeJsonMessage(message, "tts");
    const eventName = readRealtimeEventName(payload);
    const lowerName = eventName.toLowerCase();
    const delta = typeof payload?.delta === "string" ? payload.delta : findStringField(payload, [
        "audio_base64",
        "pcm_base64",
        "audio",
        "data"
    ]);

    return {
        eventName,
        delta,
        isError: lowerName.includes("error") || Boolean(payload?.error),
        errorMessage: extractRealtimeErrorMessage(payload),
        isSessionUpdated: lowerName === "tts_session.updated",
        isAudioDelta: lowerName === "response.audio.delta" || lowerName.includes("audio.delta"),
        isAudioDone: lowerName === "response.audio.done" ||
            lowerName.includes("audio.done") ||
            lowerName.includes("completed")
    };
}

function buildAsrSessionUpdate(config) {
    return JSON.stringify({
        type: "transcription_session.update",
        session: {
            input_audio_format: config.asr.format,
            input_audio_codec: config.asr.codec,
            input_audio_sample_rate: config.asr.sampleRate,
            input_audio_bits: config.asr.bits,
            input_audio_channel: config.asr.channels,
            input_audio_transcription: {
                model: config.asr.model
            }
        }
    });
}

function buildTtsSessionUpdate(config) {
    return JSON.stringify({
        type: "tts_session.update",
        session: {
            voice: config.tts.voice,
            output_audio_format: "pcm",
            output_audio_sample_rate: config.tts.sampleRate,
            text_to_speech: {
                model: config.tts.model
            }
        }
    });
}

async function requestVoiceAsr(audioBuffer, config, voiceConfig, signal) {
    let ws = null;
    let latestText = "";
    let finalText = "";

    try {
        ws = await openRealtimeWebSocket(
            config.asr.url,
            buildVolcGatewayHeaders(config, "asr"),
            signal,
            "asr"
        );
        ws.sendText(buildAsrSessionUpdate(config));

        for (let offset = 0; offset < audioBuffer.length; offset += voiceConfig.wsAudioChunkBytes) {
            const chunk = audioBuffer.subarray(offset, Math.min(offset + voiceConfig.wsAudioChunkBytes, audioBuffer.length));
            ws.sendText(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: chunk.toString("base64")
            }));
        }
        ws.sendText(JSON.stringify({
            type: "input_audio_buffer.commit"
        }));

        while (!signal?.aborted) {
            const event = parseAsrRealtimeEvent(await ws.nextMessage(signal));
            if (event.isError) {
                throw createVoiceStageError("asr", "VOICE_ASR_FAILED", event.errorMessage || "ASR Realtime WebSocket returned an error", 502, {
                    endpoint: config.asr.url,
                    model: config.asr.model
                });
            }

            if (event.text) {
                latestText = event.text;
                if (event.isFinal) {
                    finalText = event.text;
                }
            }

            if (event.isFinal) {
                break;
            }
        }

        const text = (finalText || latestText).trim();
        if (!text) {
            throw createVoiceStageError("asr", "VOICE_ASR_FAILED", "ASR Realtime response did not contain text", 502, {
                endpoint: config.asr.url,
                model: config.asr.model
            });
        }

        return { text };
    } catch (error) {
        if (error?.code) {
            throw error;
        }

        if (error?.name === "AbortError") {
            throw createVoiceStageError("asr", "VOICE_ASR_FAILED", "ASR Realtime request was aborted or timed out", 502, {
                endpoint: config.asr.url,
                model: config.asr.model,
                cause: error
            });
        }

        throw createVoiceStageError("asr", "VOICE_ASR_FAILED", error?.message || "ASR Realtime request failed", 502, {
            endpoint: config.asr.url,
            model: config.asr.model,
            cause: error
        });
    } finally {
        if (ws) {
            ws.sendClose();
        }
    }
}

async function requestVoiceTurnLlm(asrText, config, signal) {
    try {
        return await requestLlmText(asrText, {
            apiKey: config.apiKey,
            endpoint: config.chat.endpoint,
            baseUrl: config.chat.baseUrl,
            chatPath: config.chat.path,
            model: config.chat.model,
            timeoutMs: readPositiveInteger(process.env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS)
        }, signal);
    } catch (error) {
        throw createVoiceStageError("llm", "VOICE_LLM_FAILED", error?.message || "LLM request failed", 502, {
            upstreamStatus: error?.status,
            bodyLength: error?.bodyLength,
            bodyPreview: error?.bodyPreview,
            endpoint: error?.endpoint || config.chat.endpoint,
            model: error?.model || config.chat.model,
            cause: error
        });
    }
}

async function requestRealtimeVoiceTts(text, config, signal) {
    let ws = null;
    const audioChunks = [];

    try {
        ws = await openRealtimeWebSocket(
            config.tts.url,
            buildVolcGatewayHeaders(config, "tts"),
            signal,
            "tts"
        );
        ws.sendText(buildTtsSessionUpdate(config));
        while (!signal?.aborted) {
            const event = parseTtsRealtimeEvent(await ws.nextMessage(signal));
            if (event.isError) {
                throw createVoiceStageError("tts", "VOICE_TTS_FAILED", event.errorMessage || "TTS Realtime WebSocket returned an error", 502, {
                    endpoint: config.tts.url,
                    model: config.tts.model
                });
            }

            if (event.isSessionUpdated) {
                break;
            }
        }

        ws.sendText(JSON.stringify({
            type: "input_text.append",
            delta: text
        }));
        ws.sendText(JSON.stringify({
            type: "input_text.done"
        }));

        while (!signal?.aborted) {
            const event = parseTtsRealtimeEvent(await ws.nextMessage(signal));
            if (event.isError) {
                throw createVoiceStageError("tts", "VOICE_TTS_FAILED", event.errorMessage || "TTS Realtime WebSocket returned an error", 502, {
                    endpoint: config.tts.url,
                    model: config.tts.model
                });
            }

            if (event.isAudioDelta) {
                const decoded = decodeBase64Buffer(event.delta);
                if (!decoded) {
                    throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS Realtime audio delta was not valid base64 PCM", 502, {
                        endpoint: config.tts.url,
                        model: config.tts.model
                    });
                }
                audioChunks.push(decoded);
            }

            if (event.isAudioDone) {
                break;
            }
        }

        const audioBuffer = Buffer.concat(audioChunks);
        return {
            pcm: normalizeTtsPcmBuffer(audioBuffer)
        };
    } catch (error) {
        if (error?.code) {
            throw error;
        }

        if (error?.name === "AbortError") {
            throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS Realtime request was aborted or timed out", 502, {
                endpoint: config.tts.url,
                model: config.tts.model,
                cause: error
            });
        }

        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", error?.message || "TTS Realtime request failed", 502, {
            endpoint: config.tts.url,
            model: config.tts.model,
            cause: error
        });
    } finally {
        if (ws) {
            ws.sendClose();
        }
    }
}

async function requestHttpVoiceTts(text, config, deviceId, signal) {
    if (typeof fetch !== "function") {
        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "fetch is unavailable", 502);
    }

    try {
        const upstreamResponse = await fetch(config.tts.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: `${VOICE_TURN_CONTENT_TYPE}, audio/wav, audio/x-wav, application/octet-stream, application/json`,
                "X-Device-Id": deviceId,
                ...buildVolcGatewayHeaders(config, "tts")
            },
            body: JSON.stringify({
                model: config.tts.model,
                text,
                input: text,
                voice: config.tts.voice,
                voice_type: config.tts.voice,
                format: "pcm",
                response_format: "pcm",
                output_audio_format: "pcm",
                sample_rate: config.tts.sampleRate,
                output_audio_sample_rate: config.tts.sampleRate
            }),
            signal
        });
        const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

        if (!upstreamResponse.ok) {
            const responseBody = responseBuffer.toString("utf8");
            throw createUpstreamVoiceStageError(
                "tts",
                "VOICE_TTS_FAILED",
                upstreamResponse,
                responseBody,
                "TTS upstream request failed"
            );
        }

        const contentType = upstreamResponse.headers.get("content-type") || "";
        const pcmBuffer = normalizeTtsPcmBuffer(responseBuffer, contentType);

        return {
            pcm: pcmBuffer
        };
    } catch (error) {
        if (error?.code) {
            throw error;
        }

        if (error?.name === "AbortError") {
            throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS request was aborted or timed out", 502, {
                endpoint: config.tts.url,
                model: config.tts.model,
                cause: error
            });
        }

        throw createVoiceStageError("tts", "VOICE_TTS_FAILED", error?.message || "TTS request failed", 502, {
            endpoint: config.tts.url,
            model: config.tts.model,
            cause: error
        });
    }
}

async function requestVoiceTts(text, config, deviceId, signal) {
    const protocol = new URL(config.tts.url).protocol;
    if (protocol === "ws:" || protocol === "wss:") {
        return requestRealtimeVoiceTts(text, config, signal);
    }

    return requestHttpVoiceTts(text, config, deviceId, signal);
}

async function runVoiceTurnChain(audioBuffer, deviceId, voiceConfig, gatewayConfig, signal, metrics) {
    let stageStartedAt = Date.now();
    const asrResult = await requestVoiceAsr(audioBuffer, gatewayConfig, voiceConfig, signal);
    metrics.asrTextLength = asrResult.text.length;
    metrics.asrTextPreview = normalizeLogPreview(asrResult.text, 60);
    console.log(
        `[voice-turn] asr_success device_id=${maskLogValue(deviceId)} input_bytes=${audioBuffer.length} asr_ws_url=${maskUrlForLog(gatewayConfig.asr.url)} asr_text_length=${metrics.asrTextLength} asr_text=${JSON.stringify(metrics.asrTextPreview)} elapsed_ms=${Date.now() - stageStartedAt}`
    );

    stageStartedAt = Date.now();
    const llmResult = await requestVoiceTurnLlm(asrResult.text, gatewayConfig, signal);
    metrics.llmReplyLength = llmResult.text.length;
    console.log(
        `[voice-turn] llm_success device_id=${maskLogValue(deviceId)} asr_text_length=${metrics.asrTextLength} llm_reply_length=${metrics.llmReplyLength} elapsed_ms=${Date.now() - stageStartedAt}`
    );

    stageStartedAt = Date.now();
    const ttsResult = await requestVoiceTts(llmResult.text, gatewayConfig, deviceId, signal);
    metrics.ttsPcmBytes = ttsResult.pcm.length;
    console.log(
        `[voice-turn] tts_success device_id=${maskLogValue(deviceId)} llm_reply_length=${metrics.llmReplyLength} tts_pcm_bytes=${metrics.ttsPcmBytes} elapsed_ms=${Date.now() - stageStartedAt}`
    );

    return {
        bytes: ttsResult.pcm.length,
        mode: "chain",
        asrTextLength: metrics.asrTextLength,
        asrTextPreview: metrics.asrTextPreview,
        llmReplyLength: metrics.llmReplyLength,
        ttsPcmBytes: metrics.ttsPcmBytes,
        pcm: ttsResult.pcm
    };
}

function sendVoiceTurnPcm(res, pcmBuffer) {
    writeVoiceTurnHeaders(res);
    res.end(pcmBuffer);
}

function formatOptionalDeviceLog(deviceId) {
    return deviceId ? ` device_id=${maskLogValue(deviceId)}` : "";
}

async function handleVoicePrompt(req, res) {
    const startedAt = Date.now();
    const deviceId = readOptionalVoiceDeviceId(req);
    const upstreamDeviceId = readVoiceDeviceId(req);
    const gatewayConfig = readVolcGatewayConfig();
    const ttsConfigError = validateVoiceTtsConfig(gatewayConfig);
    let ttsPcmBytes = 0;

    if (ttsConfigError) {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
            `[voice-prompt] rejected${formatOptionalDeviceLog(deviceId)} prompt_text=${JSON.stringify(VOICE_WAKE_PROMPT_TEXT)} tts_pcm_bytes=${ttsPcmBytes} elapsed_ms=${elapsedMs} code=${ttsConfigError.code} status=${ttsConfigError.status} message=${JSON.stringify(ttsConfigError.message)} key_${gatewayConfig.keySummary}`
        );
        return sendVoiceError(res, 503, "VOICE_TTS_NOT_CONFIGURED", ttsConfigError.message);
    }

    const config = readVoiceTurnConfig();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, config.timeoutMs);

    const abortOnClientClose = () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    };
    req.on("aborted", abortOnClientClose);
    res.on("close", abortOnClientClose);

    try {
        const ttsResult = await requestVoiceTts(
            VOICE_WAKE_PROMPT_TEXT,
            gatewayConfig,
            upstreamDeviceId,
            controller.signal
        );
        ttsPcmBytes = ttsResult.pcm.length;

        if (isSilentPcmBuffer(ttsResult.pcm)) {
            throw createVoiceStageError("tts", "VOICE_TTS_FAILED", "TTS prompt PCM must not be silent", 502);
        }

        sendVoiceTurnPcm(res, ttsResult.pcm);

        const elapsedMs = Date.now() - startedAt;
        console.log(
            `[voice-prompt] success${formatOptionalDeviceLog(deviceId)} prompt_text=${JSON.stringify(VOICE_WAKE_PROMPT_TEXT)} tts_pcm_bytes=${ttsPcmBytes} elapsed_ms=${elapsedMs}`
        );
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const message = timedOut
            ? "TTS prompt request timed out"
            : (error?.message || "TTS prompt request failed");

        console.error(
            `[voice-prompt] failed${formatOptionalDeviceLog(deviceId)} prompt_text=${JSON.stringify(VOICE_WAKE_PROMPT_TEXT)} tts_pcm_bytes=${ttsPcmBytes} elapsed_ms=${elapsedMs} code=VOICE_TTS_FAILED status=502 message=${JSON.stringify(message)} ${describeVoiceError(error)}`
        );

        sendVoiceError(res, 502, "VOICE_TTS_FAILED", message, {
            upstreamStatus: error?.upstreamStatus
        });
    } finally {
        clearTimeout(timeout);
        req.off("aborted", abortOnClientClose);
        res.off("close", abortOnClientClose);
    }
}

async function handleVoiceTurn(req, res) {
    const startedAt = Date.now();
    const deviceId = readVoiceDeviceId(req);
    const requestBytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
    const validationError = validateVoiceTurnRequest(req);
    if (validationError) {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
            `[voice-turn] rejected device_id=${maskLogValue(deviceId)} input_bytes=${requestBytes} elapsed_ms=${elapsedMs} code=${validationError.code} status=${validationError.status} message=${JSON.stringify(validationError.message)}`
        );

        return sendVoiceError(
            res,
            validationError.status,
            validationError.code,
            validationError.message
        );
    }

    const config = readVoiceTurnConfig();
    const gatewayConfig = readVolcGatewayConfig();
    const asrConfigError = config.mockEnabled ? null : validateVoiceAsrConfig(gatewayConfig);
    const chatConfigError = config.mockEnabled ? null : validateVoiceChatConfig(gatewayConfig);
    const ttsConfigError = config.mockEnabled ? null : validateVoiceTtsConfig(gatewayConfig);
    const configError = asrConfigError || chatConfigError || ttsConfigError;

    if (configError) {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
            `[voice-turn] rejected device_id=${maskLogValue(deviceId)} input_bytes=${requestBytes} elapsed_ms=${elapsedMs} code=${configError.code} status=${configError.status} message=${JSON.stringify(configError.message)} mode=chain key_${gatewayConfig.keySummary}`
        );
        return sendVoiceError(res, configError.status, configError.code, configError.message);
    }

    const acquireError = acquireVoiceTurn(deviceId, config);
    if (acquireError) {
        const elapsedMs = Date.now() - startedAt;
        console.warn(
            `[voice-turn] rejected device_id=${maskLogValue(deviceId)} input_bytes=${requestBytes} elapsed_ms=${elapsedMs} code=${acquireError.code} status=${acquireError.status} message=${JSON.stringify(acquireError.message)} active=${activeVoiceTurns}/${config.maxConcurrent}`
        );

        return sendVoiceError(res, acquireError.status, acquireError.code, acquireError.message);
    }

    const metrics = {
        asrTextLength: 0,
        asrTextPreview: "",
        llmReplyLength: 0,
        ttsPcmBytes: 0
    };
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, config.timeoutMs);

    const abortOnClientClose = () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    };
    req.on("aborted", abortOnClientClose);
    res.on("close", abortOnClientClose);

    console.log(
        `[voice-turn] start device_id=${maskLogValue(deviceId)} input_bytes=${requestBytes} active=${activeVoiceTurns}/${config.maxConcurrent} mode=${config.mockEnabled ? "mock" : "chain"} asr_ws_url=${maskUrlForLog(gatewayConfig.asr.url)} timeout_ms=${config.timeoutMs} key_${gatewayConfig.keySummary}`
    );

    try {
        let result;
        if (config.mockEnabled) {
            result = await streamMockVoiceTurn(req.body, res);
        } else {
            result = await runVoiceTurnChain(
                req.body,
                deviceId,
                config,
                gatewayConfig,
                controller.signal,
                metrics
            );
            sendVoiceTurnPcm(res, result.pcm);
        }

        const elapsedMs = Date.now() - startedAt;

        console.log(
            `[voice-turn] success device_id=${maskLogValue(deviceId)} mode=${result.mode} input_bytes=${requestBytes} asr_ws_url=${maskUrlForLog(gatewayConfig.asr.url)} asr_text_length=${result.asrTextLength} asr_text=${JSON.stringify(result.asrTextPreview || "")} llm_reply_length=${result.llmReplyLength} tts_pcm_bytes=${result.ttsPcmBytes} response_bytes=${result.bytes} elapsed_ms=${elapsedMs}`
        );
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const normalizedError = timedOut && !error?.code
            ? createVoiceError("VOICE_TURN_TIMEOUT", "Voice turn timed out", 504)
            : error;
        const status = normalizedError.status || 500;
        const code = normalizedError.code || "VOICE_TURN_FAILED";
        const message = normalizedError.message || "Voice turn failed";

        console.error(
            `[voice-turn] failed device_id=${maskLogValue(deviceId)} input_bytes=${requestBytes} asr_ws_url=${maskUrlForLog(gatewayConfig.asr.url)} asr_text_length=${metrics.asrTextLength} asr_text=${JSON.stringify(metrics.asrTextPreview)} llm_reply_length=${metrics.llmReplyLength} tts_pcm_bytes=${metrics.ttsPcmBytes} elapsed_ms=${elapsedMs} code=${code} status=${status} message=${JSON.stringify(message)} ${describeVoiceError(normalizedError)}`
        );

        sendVoiceError(res, status, code, message, {
            upstreamStatus: normalizedError.upstreamStatus
        });
    } finally {
        clearTimeout(timeout);
        req.off("aborted", abortOnClientClose);
        res.off("close", abortOnClientClose);
        releaseVoiceTurn(deviceId);
    }
}

function readLlmConfig() {
    const apiKey = readTrimmedEnv("VOLC_GATEWAY_API_KEY", readTrimmedEnv("LLM_API_KEY"));
    const baseUrl = readTrimmedEnv(
        "VOLC_GATEWAY_HTTP_BASE_URL",
        readTrimmedEnv("LLM_BASE_URL", DEFAULT_LLM_BASE_URL)
    ).replace(/\/+$/, "");
    const chatPath = readGatewayPathEnv(
        "VOLC_GATEWAY_CHAT_PATH",
        readTrimmedEnv("LLM_CHAT_PATH", DEFAULT_LLM_CHAT_PATH)
    );
    const model = readTrimmedEnv(
        "VOLC_GATEWAY_CHAT_MODEL",
        readTrimmedEnv("LLM_MODEL", DEFAULT_LLM_MODEL)
    );

    return {
        apiKey,
        keySummary: summarizeSecret(apiKey),
        baseUrl: normalizeLlmBaseUrl(baseUrl),
        chatPath,
        model,
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

    if (error?.endpoint) {
        parts.push(`endpoint=${error.endpoint}`);
    }

    if (error?.model) {
        parts.push(`model=${error.model}`);
    }

    if (error?.bodyPreview) {
        parts.push(`body=${JSON.stringify(error.bodyPreview)}`);
    }

    return parts.join(" ");
}

function getLlmResponseStatus(error) {
    if (error?.code === "LLM_API_KEY_MISSING") {
        return 503;
    }

    if (error?.code === "LLM_TIMEOUT") {
        return 504;
    }

    if (error?.code === "LLM_UPSTREAM_STATUS" ||
        error?.code === "LLM_JSON_PARSE_FAILED" ||
        error?.code === "LLM_REPLY_EMPTY") {
        return 502;
    }

    return 500;
}

function normalizeLlmBaseUrl(baseUrl) {
    if (baseUrl === LEGACY_LLM_BASE_URL) {
        if (!legacyLlmBaseUrlWarned) {
            console.warn(`[llm-text] LLM_BASE_URL uses legacy ${LEGACY_LLM_BASE_URL}; using ${DEFAULT_LLM_BASE_URL}`);
            legacyLlmBaseUrlWarned = true;
        }

        return DEFAULT_LLM_BASE_URL;
    }

    return baseUrl;
}

async function requestLlmText(text, config, externalSignal) {
    if (!config.apiKey) {
        throw createLlmError("LLM_API_KEY_MISSING");
    }

    if (typeof fetch !== "function") {
        throw createLlmError("FETCH_UNAVAILABLE");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const endpoint = config.endpoint || `${config.baseUrl}${config.chatPath}`;
    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal?.aborted) {
        controller.abort();
    } else if (externalSignal) {
        externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
    }

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
            error.endpoint = endpoint;
            error.model = config.model;
            error.bodyPreview = normalizeLogPreview(responseBody);
            error.message = extractErrorMessageFromBody(responseBody) || error.message;
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
            const error = createLlmError("LLM_REPLY_EMPTY");
            error.endpoint = endpoint;
            error.model = config.model;
            throw error;
        }

        return {
            text: reply.text,
            model: reply.model || config.model
        };
    } catch (error) {
        if (error?.name === "AbortError") {
            const timeoutError = createLlmError("LLM_TIMEOUT");
            timeoutError.endpoint = endpoint;
            timeoutError.model = config.model;
            timeoutError.cause = error;
            throw timeoutError;
        }

        throw error;
    } finally {
        clearTimeout(timer);
        if (externalSignal) {
            externalSignal.removeEventListener("abort", abortFromExternalSignal);
        }
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
        `[llm-text] request text_len=${llmRequest.text.length} device_id=${maskLogValue(llmRequest.deviceId)} session_id=${maskLogValue(llmRequest.sessionId)} key_${config.keySummary} endpoint=${config.baseUrl}${config.chatPath} model=${config.model}`
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

        const status = getLlmResponseStatus(error);
        const payload = {
            ok: false,
            code: error?.code || "LLM_REQUEST_FAILED",
            error: "LLM request failed"
        };

        if (typeof error?.status === "number") {
            payload.upstream_status = error.status;
        }

        return res.status(status).json(payload);
    }
});

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
