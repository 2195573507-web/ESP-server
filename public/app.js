const LEVELS = {
    normal: { label: "正常", className: "normal" },
    warning: { label: "警告", className: "warning" },
    danger: { label: "严重", className: "danger" }
};

const metricDefinitions = {
    temperature: {
        name: "温度",
        unit: "°C",
        accent: "#2874ff",
        icon: "thermometer",
        historyField: "temperature"
    },
    humidity: {
        name: "湿度",
        unit: "%",
        accent: "#10b981",
        icon: "drop",
        historyField: "humidity"
    },
    air: {
        name: "空气质量",
        unit: "",
        accent: "#8a35ea",
        icon: "cloud",
        historyField: "air_quality_score"
    },
    esp: {
        name: "ESP 状态",
        unit: "",
        accent: "#f97316",
        icon: "chip",
        historyField: null
    }
};

const DEVICE_IDS = {
    c51: "C51",
    c52: "C52"
};
const LOADING_TEXT = "Loading...";
const EMPTY_TEXT = "暂无数据";
const NO_DATA_TEXT = "未连接";
const ERROR_TEXT = "接口请求失败";
const UNKNOWN_TEXT = "未知";
const OFFLINE_TEXT = "离线";
const DISCONNECTED_TEXT = "未连接";

const SMART_HOME_UNAVAILABLE_MESSAGE = "智能家居状态未接入。";
const FEATURE_IN_PROGRESS_MESSAGE = "功能开发中";

let dashboardState = {
    sensor: null,
    deviceStatus: null,
    asr: null,
    llm: null,
    metrics: createEmptyMetrics(),
    history: [],
    alertLogs: [],
    systemLogs: [],
    commandLogs: [],
    operationLogs: [],
    smartHomeDevices: null,
    sources: {
        sensor: "idle",
        deviceStatus: "idle",
        asr: "idle",
        llm: "idle",
        history: "idle",
        alerts: "idle",
        logs: "idle",
        commands: "idle"
    }
};

let lastSourceSignature = "";
const THEME_STORAGE_KEY = "dashboardTheme";
const DASHBOARD_REFRESH_INTERVAL_MS = 3000;
const ESP_DELAY_REFRESH_INTERVAL_MS = 1000;
const CHART_RANGE_OPTIONS = [12, 24, 36, 48];
const DEFAULT_CHART_RANGE_HOURS = 24;
const ALERT_LOG_PREVIEW_LIMIT = 4;
const SYSTEM_LOG_PREVIEW_LIMIT = 4;
const OPERATION_LOG_PREVIEW_LIMIT = 5;
const CUSTOM_COMMAND_MAX_LENGTH = 500;
let dashboardRefreshTimer = null;
let espDelayRefreshTimer = null;
let selectedChartRangeHours = DEFAULT_CHART_RANGE_HOURS;
let activeLogModalType = null;
let pendingConfirmAction = null;
let activeDashboardPage = "c51";
let s3DashboardRendered = false;

// 主题功能：读取 CSS 主题变量，Canvas 图表调用它来适配黑色/白色背景。
function readThemeColor(name, defaultColor) {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || defaultColor;
}

// 主题功能：更新黑白切换按钮文字；dark 显示“白色模式”，light 显示“黑色模式”。
function updateThemeButtonText(button, theme) {
    if (theme === "dark") {
        button.textContent = "☀️ 白色模式";
    } else {
        button.textContent = "🌙 黑色模式";
    }
}

// 主题功能：初始化右上角黑白背景切换按钮；页面加载时读取 localStorage，默认使用 dark。
function initThemeToggle() {
    const themeToggleBtn = document.getElementById("themeToggleBtn");
    if (!themeToggleBtn) {
        console.warn("未找到主题切换按钮 themeToggleBtn");
        return;
    }

    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "dark";
    const initialTheme = savedTheme === "light" ? "light" : "dark";
    document.body.dataset.theme = initialTheme;
    updateThemeButtonText(themeToggleBtn, initialTheme);

    themeToggleBtn.addEventListener("click", () => {
        const currentTheme = document.body.dataset.theme || "dark";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";

        document.body.dataset.theme = nextTheme;
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        updateThemeButtonText(themeToggleBtn, nextTheme);

        if (typeof window.updateChartTheme === "function") {
            window.updateChartTheme(nextTheme);
        }
    });
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasData(value) {
    return isPlainObject(value) && Object.keys(value).length > 0;
}

function createEmptyMetric(label, unit = "") {
    return {
        value: null,
        display: NO_DATA_TEXT,
        level: "unknown",
        label,
        unit,
        source: "empty"
    };
}

function createEmptyMetrics(status = UNKNOWN_TEXT, note = EMPTY_TEXT) {
    const esp = {
        value: status,
        latency: null,
        level: "unknown",
        note,
        source: "empty"
    };
    return {
        temperature: createEmptyMetric("温度", "°C"),
        humidity: createEmptyMetric("湿度", "%"),
        air: createEmptyMetric("空气质量", ""),
        esp,
        overall: "unknown"
    };
}

function getActiveDeviceId() {
    return DEVICE_IDS[activeDashboardPage] || DEVICE_IDS.c51;
}

function buildUrl(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    });
    return `${url.pathname}${url.search}`;
}

function unwrapEnvelope(payload) {
    if (payload && typeof payload === "object" && "data" in payload && "ok" in payload) {
        return payload.data;
    }
    return payload;
}

function readListPayload(payload, keys = []) {
    const data = unwrapEnvelope(payload);
    if (Array.isArray(data)) return data;
    if (!isPlainObject(data)) return [];
    for (const key of keys) {
        if (Array.isArray(data[key])) return data[key];
    }
    return [];
}

function formatTime(timestamp) {
    const date = parseTimestamp(timestamp);
    if (!date) return EMPTY_TEXT;
    return date.toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

// 曲线时间范围：格式化横轴标签，36/48 小时时显示日期，避免跨天数据看不清。
function formatChartTime(timestamp) {
    const date = parseTimestamp(timestamp);
    if (!date) return EMPTY_TEXT;

    const options = selectedChartRangeHours > 24
        ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
        : { hour: "2-digit", minute: "2-digit", hour12: false };
    return date.toLocaleString("zh-CN", options);
}

function parseTimestamp(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    if (typeof value === "number") {
        const milliseconds = value < 10000000000 ? value * 1000 : value;
        const date = new Date(milliseconds);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return parseTimestamp(numeric);
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function pickFirst(data, keys) {
    for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== "") {
            return data[key];
        }
    }
    return undefined;
}

function toNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function sourceLabel(source) {
    if (source === "real") return "来源：后端真实数据";
    if (source === "loading") return LOADING_TEXT;
    if (source === "error") return ERROR_TEXT;
    if (source === "not-integrated") return "未接入";
    return DISCONNECTED_TEXT;
}

function getHistoryValues(field) {
    if (!field) return [];
    return (dashboardState.history || [])
        .map(point => normalizeHistoryPoint(point))
        .filter(Boolean)
        .map(point => toNumber(point[field]))
        .filter(value => value !== null);
}

function hasHistoryValues(field) {
    return getHistoryValues(field).length > 0;
}

// 日志弹窗：所有日志内容写入 HTML 前先转义，防止日志文本破坏页面结构。
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatNumber(value, digits = 1) {
    const numeric = toNumber(value);
    if (numeric === null) {
        return NO_DATA_TEXT;
    }
    return Number(numeric.toFixed(digits)).toString();
}

// 曲线时间范围：从历史点中读取真实时间戳字段；没有绝对时间的点不参与 12/24/36/48 小时筛选。
function getHistoryPointTimestamp(point) {
    if (!isPlainObject(point)) return null;

    const timestampValue = pickFirst(point, [
        "timestamp",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "received_at",
        "receivedAt",
        "upload_time",
        "uploadTime",
        "time"
    ]);
    return parseTimestamp(timestampValue);
}

// 曲线时间范围：把后端历史数据点规范成 Canvas 可绘制结构，只保留真实数值字段。
function normalizeHistoryPoint(point) {
    if (!isPlainObject(point)) return null;

    const timestamp = getHistoryPointTimestamp(point);
    if (!timestamp) return null;

    const temperature = toNumber(pickFirst(point, ["temperature", "temp"]));
    const humidity = toNumber(pickFirst(point, ["humidity"]));
    const pressure = toNumber(pickFirst(point, ["pressure"]));
    const airQualityObject = isPlainObject(point.air_quality) ? point.air_quality : {};
    const airScore = toNumber(point.air_quality_score) ?? toNumber(airQualityObject.air_quality_score);

    if (temperature === null && humidity === null && pressure === null && airScore === null) {
        return null;
    }

    return {
        timestamp,
        time: formatChartTime(timestamp),
        temperature,
        humidity,
        pressure,
        air: airScore,
        air_quality_score: airScore
    };
}

function getLatestSensorChartPoint() {
    const sensor = dashboardState.sensor;
    if (!sensor || sensor.source !== "real" || !sensor.timestamp) return null;

    return {
        timestamp: sensor.timestamp,
        time: formatChartTime(sensor.timestamp),
        temperature: toNumber(sensor.temperature),
        humidity: toNumber(sensor.humidity),
        pressure: toNumber(sensor.pressure),
        air: toNumber(sensor.airQualityScore),
        air_quality_score: toNumber(sensor.airQualityScore)
    };
}

// 曲线时间范围：按当前下拉选中的小时数筛选真实时间戳数据，时间戳无效的数据会被跳过。
function getFilteredChartData() {
    const rangeMs = selectedChartRangeHours * 60 * 60 * 1000;
    const now = Date.now();
    const history = Array.isArray(dashboardState.history) ? dashboardState.history : [];
    const points = history
        .map(normalizeHistoryPoint)
        .filter(Boolean);
    const latestPoint = getLatestSensorChartPoint();

    if (latestPoint) {
        const duplicateIndex = points.findIndex(point => point.timestamp.getTime() === latestPoint.timestamp.getTime());
        if (duplicateIndex >= 0) {
            points[duplicateIndex] = latestPoint;
        } else {
            points.push(latestPoint);
        }
    }

    return points
        .filter(point => {
            const timestamp = point.timestamp.getTime();
            return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= rangeMs;
        })
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

// 曲线时间范围：更新下拉按钮文字和选中态，供初始化和点击选项后调用。
function updateChartRangeSelector() {
    const label = document.querySelector("[data-range-label]");
    const button = document.getElementById("chartRangeButton");

    if (label) {
        label.textContent = `最近 ${selectedChartRangeHours} 小时`;
    }

    document.querySelectorAll("[data-range-hours]").forEach(option => {
        const selected = Number(option.dataset.rangeHours) === selectedChartRangeHours;
        option.setAttribute("aria-selected", selected ? "true" : "false");
    });

    if (button) {
        button.setAttribute("aria-label", `当前显示最近 ${selectedChartRangeHours} 小时数据`);
    }
}

// 曲线时间范围：初始化自定义下拉菜单，点击选项后只改变前端筛选范围并重绘图表。
function initChartRangeSelector() {
    const selector = document.querySelector("[data-range-selector]");
    const button = document.getElementById("chartRangeButton");
    const menu = document.querySelector("[data-range-menu]");
    if (!selector || !button || !menu) return;

    const closeMenu = () => {
        selector.classList.remove("is-open");
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
    };

    const openMenu = () => {
        selector.classList.add("is-open");
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
    };

    updateChartRangeSelector();

    button.addEventListener("click", event => {
        event.stopPropagation();
        if (menu.hidden) {
            openMenu();
        } else {
            closeMenu();
        }
    });

    menu.querySelectorAll("[data-range-hours]").forEach(option => {
        option.addEventListener("click", () => {
            const nextHours = Number(option.dataset.rangeHours);
            if (CHART_RANGE_OPTIONS.includes(nextHours)) {
                selectedChartRangeHours = nextHours;
                updateChartRangeSelector();
                renderMainChart();
            }
            closeMenu();
        });
    });

    document.addEventListener("click", event => {
        if (!selector.contains(event.target)) {
            closeMenu();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeMenu();
        }
    });
}

// ESP 延迟显示：把毫秒格式化为 ms、s 或 m s，不写死 1ms。
function formatDelayText(prefix, delayMs, options = {}) {
    const numeric = toNumber(delayMs);
    if (numeric === null) {
        return `${prefix} ${NO_DATA_TEXT}`;
    }

    const decimalSeconds = options.decimalSeconds !== false;
    const safeMs = Math.max(0, Math.round(numeric));
    if (safeMs < 1000) {
        return `${prefix} ${safeMs}ms`;
    }

    if (safeMs < 60000) {
        const seconds = decimalSeconds ? (safeMs / 1000).toFixed(1) : String(Math.round(safeMs / 1000));
        return `${prefix} ${seconds}s`;
    }

    const minutes = Math.floor(safeMs / 60000);
    const seconds = Math.floor((safeMs % 60000) / 1000);
    return `${prefix} ${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// ESP 延迟显示：基于最新传感器 timestamp 计算数据新鲜度；时间戳无效时返回 null。
function getSensorDelayMs(sensor) {
    if (!sensor || sensor.source !== "real" || !sensor.timestamp || Number.isNaN(sensor.timestamp.getTime())) {
        return null;
    }

    return Math.max(0, Date.now() - sensor.timestamp.getTime());
}

async function fetchJson(path, options = {}) {
    const response = await fetch(path, { cache: "no-store", ...options });
    if (!response.ok) {
        throw new Error(`${response.url} ${response.status}`);
    }
    return response.json();
}

async function readEndpoint(path, label, options = {}) {
    try {
        const raw = await fetchJson(path, options);
        const data = unwrapEnvelope(raw);
        const empty = data === null ||
            data === undefined ||
            (Array.isArray(data) && data.length === 0) ||
            (isPlainObject(data) && Object.keys(data).length === 0);
        return {
            ok: true,
            data,
            source: empty ? "empty" : "real",
            empty,
            error: null
        };
    } catch (error) {
        console.warn(`[Dashboard] ${label}: request failed`, error.message);
        return {
            ok: false,
            data: null,
            source: "error",
            empty: true,
            error
        };
    }
}

async function fetchLatestSensor(deviceId = getActiveDeviceId()) {
    return readEndpoint(
        buildUrl("/api/dashboard/v1/sensors/latest", { device_id: deviceId }),
        `Sensor ${deviceId}`
    );
}

async function fetchDeviceStatus(deviceId = getActiveDeviceId()) {
    return readEndpoint(
        buildUrl("/api/dashboard/v1/device/status", { device_id: deviceId }),
        `Device status ${deviceId}`
    );
}

async function fetchLatestASR() {
    return readEndpoint("/api/dashboard/v1/asr/latest", "ASR");
}

async function fetchLatestLLM() {
    return readEndpoint("/api/dashboard/v1/llm/latest", "LLM");
}

async function fetchHistoryData(deviceId = getActiveDeviceId()) {
    const result = await readEndpoint(
        buildUrl("/api/dashboard/v1/sensors/history", {
            device_id: deviceId,
            limit: 500
        }),
        `History ${deviceId}`
    );
    return {
        ...result,
        data: Array.isArray(result.data) ? result.data : []
    };
}

async function fetchAlertLogs(deviceId = getActiveDeviceId()) {
    const result = await readEndpoint(
        buildUrl("/api/emergency/events", {
            device_id: deviceId,
            limit: 20
        }),
        `Emergency events ${deviceId}`
    );
    return {
        ...result,
        data: readListPayload(result.data, ["events"])
    };
}

async function fetchSystemLogs() {
    return {
        ok: true,
        data: null,
        source: "not-integrated",
        empty: true,
        error: null
    };
}

async function fetchCommandLogs(deviceId = getActiveDeviceId()) {
    const result = await readEndpoint(
        buildUrl("/api/commands/history", {
            device_id: deviceId,
            limit: 20
        }),
        `Commands ${deviceId}`
    );
    return {
        ...result,
        data: readListPayload(result.data, ["commands"])
    };
}

function normalizeSensor(rawSensor, source) {
    const sensor = isPlainObject(rawSensor) ? rawSensor : {};
    const temperature = toNumber(pickFirst(sensor, ["temperature", "temp"]));
    const humidity = toNumber(pickFirst(sensor, ["humidity"]));
    const pressure = toNumber(pickFirst(sensor, ["pressure"]));
    const airQualityObject = isPlainObject(sensor.air_quality) ? sensor.air_quality : {};
    const airQualityScore = toNumber(sensor.air_quality_score) ?? toNumber(airQualityObject.air_quality_score);
    const airQualityLevel = pickFirst(sensor, [
        "air_quality_level",
        "air_quality_label"
    ]) ?? pickFirst(airQualityObject, ["air_quality_level", "level", "label"]);
    const timestampValue = pickFirst(rawSensor, [
        "timestamp",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "last_seen",
        "lastSeen",
        "received_at",
        "receivedAt",
        "upload_time",
        "uploadTime",
        "time"
    ]);
    const timestamp = parseTimestamp(timestampValue);

    return {
        raw: sensor,
        source,
        device_id: sensor.device_id || getActiveDeviceId(),
        temperature,
        humidity,
        pressure,
        airQualityScore,
        airQualityLevel: airQualityLevel ? String(airQualityLevel) : "",
        online: typeof sensor.online === "boolean" ? sensor.online : null,
        lastSeenMs: toNumber(pickFirst(sensor, ["last_seen_ms", "lastSeenMs"])),
        lastSeenAgeMs: toNumber(pickFirst(sensor, ["last_seen_age_ms", "lastSeenAgeMs"])),
        latestUploadDelayMs: toNumber(pickFirst(sensor, ["latest_upload_delay_ms", "upload_delay_ms"])),
        timestamp,
        hasTimestamp: Boolean(timestamp)
    };
}

function normalizeDeviceStatus(rawStatus, source) {
    const status = isPlainObject(rawStatus) ? rawStatus : {};
    const online = typeof status.online === "boolean"
        ? status.online
        : (typeof status.device_online === "boolean" ? status.device_online : null);
    const lastSeenMs = toNumber(pickFirst(status, ["last_seen_ms", "lastSeenMs"]));
    const lastSeenAgeMs = toNumber(pickFirst(status, ["last_seen_age_ms", "lastSeenAgeMs"]));
    const latestUploadDelayMs = toNumber(pickFirst(status, ["latest_upload_delay_ms", "upload_delay_ms"]));

    return {
        raw: status,
        source,
        device_id: status.device_id || getActiveDeviceId(),
        online,
        lastSeenMs,
        lastSeenAgeMs,
        latestUploadDelayMs,
        lastSeenIso: status.last_seen_iso || "",
        timeSynced: typeof status.time_synced === "boolean" ? status.time_synced : null
    };
}

function normalizeAlertLog(event) {
    const payload = isPlainObject(event?.payload) ? event.payload : {};
    const severity = String(event?.severity || "").toLowerCase();
    const status = String(event?.status || "");
    const level = severity === "critical"
        ? "danger"
        : (severity === "warning" ? "warning" : "normal");

    return {
        type: event?.event_type || payload.type || "报警",
        time: formatTime(event?.created_at || event?.updated_at),
        content: payload.summary || payload.message || event?.local_action || event?.event_id || "",
        status: status === "resolved" ? "已恢复" : (status || "未处理"),
        level
    };
}

function getTemperatureLevel(value) {
    if (value > 45) return "danger";
    if (value > 35) return "warning";
    return "normal";
}

function getHumidityLevel(value) {
    if (value > 85) return "danger";
    if (value > 75) return "warning";
    return "normal";
}

function getAirLevel(value) {
    if (value > 150) return "danger";
    if (value > 100) return "warning";
    return "normal";
}

function getEspStatus(deviceStatus) {
    if (!deviceStatus) {
        return {
            value: UNKNOWN_TEXT,
            latency: null,
            level: "unknown",
            note: EMPTY_TEXT
        };
    }

    if (typeof deviceStatus.online !== "boolean") {
        return {
            value: UNKNOWN_TEXT,
            latency: deviceStatus.latestUploadDelayMs ?? null,
            level: "unknown",
            note: "状态未知"
        };
    }

    const ageMs = deviceStatus.lastSeenAgeMs ?? deviceStatus.latestUploadDelayMs;
    const note = deviceStatus.online
        ? (ageMs === null ? "在线" : formatDelayText("延迟", ageMs))
        : (ageMs === null ? OFFLINE_TEXT : formatDelayText(OFFLINE_TEXT, ageMs, { decimalSeconds: false }));

    return {
        value: deviceStatus.online ? "在线" : OFFLINE_TEXT,
        latency: ageMs,
        level: deviceStatus.online ? "normal" : "danger",
        note,
        source: deviceStatus.source
    };
}

function getOverallLevel(metrics) {
    const levels = [metrics.temperature.level, metrics.humidity.level, metrics.air.level, metrics.esp.level];
    if (levels.includes("danger")) return "danger";
    if (levels.includes("warning")) return "warning";
    if (levels.includes("unknown")) return "unknown";
    return "normal";
}

function buildMetrics(sensor, deviceStatus = dashboardState.deviceStatus) {
    if (!sensor) {
        const metrics = createEmptyMetrics(UNKNOWN_TEXT, DISCONNECTED_TEXT);
        metrics.esp = getEspStatus(deviceStatus);
        metrics.overall = getOverallLevel(metrics);
        return metrics;
    }
    const esp = getEspStatus(deviceStatus);
    const temperatureLevel = sensor.temperature === null ? "unknown" : getTemperatureLevel(sensor.temperature);
    const humidityLevel = sensor.humidity === null ? "unknown" : getHumidityLevel(sensor.humidity);
    const airLevel = sensor.airQualityScore === null ? "unknown" : "normal";
    const airDisplay = sensor.airQualityScore === null
        ? DISCONNECTED_TEXT
        : `${formatNumber(sensor.airQualityScore, 0)} 分${sensor.airQualityLevel ? ` · ${sensor.airQualityLevel}` : ""}`;

    return {
        temperature: {
            value: sensor.temperature,
            display: formatNumber(sensor.temperature),
            level: temperatureLevel,
            source: sensor.temperature === null ? "empty" : sensor.source,
            label: "温度",
            unit: "°C"
        },
        humidity: {
            value: sensor.humidity,
            display: formatNumber(sensor.humidity),
            level: humidityLevel,
            source: sensor.humidity === null ? "empty" : sensor.source,
            label: "湿度",
            unit: "%"
        },
        air: {
            value: sensor.airQualityScore,
            display: airDisplay,
            level: airLevel,
            label: "空气质量",
            unit: "",
            source: sensor.airQualityScore === null ? "empty" : sensor.source
        },
        esp,
        overall: getOverallLevel({
            temperature: { level: temperatureLevel },
            humidity: { level: humidityLevel },
            air: { level: airLevel },
            esp
        })
    };
}

function metricDisplay(metric) {
    if (!metric) {
        return NO_DATA_TEXT;
    }
    if (metric.source === "loading") {
        return LOADING_TEXT;
    }
    if (metric.source === "error") {
        return ERROR_TEXT;
    }
    if (metric.value === null || metric.value === undefined) {
        return DISCONNECTED_TEXT;
    }
    return `${metric.display}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function createLoadingMetrics() {
    const metrics = createEmptyMetrics(UNKNOWN_TEXT, LOADING_TEXT);
    Object.values(metrics).forEach(metric => {
        if (metric && typeof metric === "object") {
            metric.display = LOADING_TEXT;
            metric.source = "loading";
        }
    });
    metrics.esp.value = UNKNOWN_TEXT;
    metrics.esp.note = LOADING_TEXT;
    metrics.overall = "unknown";
    return metrics;
}

function setDashboardLoadingState(deviceId) {
    dashboardState.sensor = null;
    dashboardState.deviceStatus = null;
    dashboardState.asr = null;
    dashboardState.llm = null;
    dashboardState.metrics = createLoadingMetrics();
    dashboardState.history = [];
    dashboardState.alertLogs = [];
    dashboardState.systemLogs = [];
    dashboardState.operationLogs = [];
    dashboardState.sources = {
        sensor: "loading",
        deviceStatus: "loading",
        asr: "loading",
        llm: "loading",
        history: "loading",
        alerts: "loading",
        logs: "loading",
        commands: "loading"
    };
    renderMetricCards();
    renderMainChart();
    renderAlertSummary();
    renderAlertLogs();
    renderSystemLogs();
    renderOperationLogs();
    renderStatusHeader();
    renderSourceDebug();
    const deviceNameElement = document.querySelector("[data-active-device-name]");
    if (deviceNameElement) {
        deviceNameElement.textContent = deviceId || UNKNOWN_TEXT;
    }
}

function iconSvg(name) {
    const icons = {
        thermometer: '<svg viewBox="0 0 24 24"><path d="M10 4a2 2 0 1 1 4 0v8.4a5 5 0 1 1-4 0V4Zm2 1.5a.5.5 0 0 0-.5.5v9.1l-.8.5a3 3 0 1 0 3.2 0l-.9-.5V6a.5.5 0 0 0-.5-.5Z"/></svg>',
        drop: '<svg viewBox="0 0 24 24"><path d="M12 2.5 6.4 10a7 7 0 1 0 11.2 0L12 2.5Zm0 18a5 5 0 0 1-5-5c0-1.5.9-3.1 2-4.7.8-1.2 1.8-2.5 3-4.1 1.2 1.6 2.2 2.9 3 4.1 1.1 1.6 2 3.2 2 4.7a5 5 0 0 1-5 5Z"/></svg>',
        cloud: '<svg viewBox="0 0 24 24"><path d="M8.5 18.5a5.5 5.5 0 0 1-.9-10.9 6 6 0 0 1 11.5 2 4.5 4.5 0 0 1-.6 8.9h-10Z"/></svg>',
        chip: '<svg viewBox="0 0 24 24"><path d="M8 3h8v3h3v3h2v6h-2v3h-3v3H8v-3H5v-3H3V9h2V6h3V3Zm1.5 6.5v5h5v-5h-5Z"/></svg>',
        bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.5-2h-5A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5-6.7V3a2 2 0 1 0-4 0v1.3A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>',
        "air-conditioner": '<svg viewBox="0 0 24 24"><path d="M4 5h16a2 2 0 0 1 2 2v6H2V7a2 2 0 0 1 2-2Zm0 2v6h16V7H4Zm2 2h8v2H6V9Zm13.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM7 15h2v2.2l2-1.1 1 1.7-2 1.2 2 1.2-1 1.7-2-1.1V23H7v-2.2l-2 1.1-1-1.7L6 19l-2-1.2 1-1.7 2 1.1V15Zm8 0h2v2.2l2-1.1 1 1.7-2 1.2 2 1.2-1 1.7-2-1.1V23h-2v-2.2l-2 1.1-1-1.7 2-1.2-2-1.2 1-1.7 2 1.1V15Z"/></svg>',
        fan: '<svg viewBox="0 0 24 24"><path d="M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm1-8c3.2 0 5 1.8 5 4.4 0 2.3-1.7 4.3-4.2 5.2-.2-.9-.8-1.7-1.6-2.1C13.4 8 14 6.8 13.8 5.8 13.6 4.8 12.9 4 11 4V2h2ZM6.4 6.1c2-.9 4.6-.1 6.4 1.9-.8.4-1.4 1.1-1.7 1.9-1.9-.4-3.3-.1-4 .7-.7.7-.8 1.7.1 3.3l-1.7 1C3.9 12.2 4 7.3 6.4 6.1Zm11 9.8c-2 1.2-4.7.8-6.7-.9.7-.5 1.3-1.2 1.5-2 1.9.1 3.2-.4 3.8-1.3.6-.8.5-1.8-.5-3.3l1.7-1.1c1.8 2.7 2.1 7.3-.8 8.9ZM11 22c-3.2 0-5-1.8-5-4.4 0-2.2 1.6-4.1 4-5.1.3.9.9 1.6 1.7 2-1.2 1.5-1.7 2.7-1.5 3.7.2 1 .9 1.8 2.8 1.8v2h-2Z"/></svg>',
        door: '<svg viewBox="0 0 24 24"><path d="M5 3h11a2 2 0 0 1 2 2v16h2v2H3v-2h2V3Zm2 18h9V5H7v16Zm10 0h1V5h-1v16Zm-4-9h2v2h-2v-2Z"/></svg>',
        light: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 1 4 12.7V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.3A7 7 0 0 1 12 2Zm0 2a5 5 0 0 0-3 9l1 .7V17h4v-3.3l1-.7A5 5 0 0 0 12 4Zm-2 17h4v2h-4v-2Z"/></svg>',
        "air-purifier": '<svg viewBox="0 0 24 24"><path d="M7 3h10a3 3 0 0 1 3 3v15H4V6a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v13h12V6a1 1 0 0 0-1-1H7Zm2 2h6v2H9V7Zm-1 5c2.2-1.5 4.2.8 6.4-.6.8-.5 1.6-.4 2.2.2l-1.2 1.6c-.4-.3-.8-.2-1.3.1-2.2 1.5-4.2-.8-6.4.6-.7.5-1.5.4-2.2-.2l1.2-1.6c.4.3.8.2 1.3-.1Zm0 4c2.2-1.5 4.2.8 6.4-.6.8-.5 1.6-.4 2.2.2l-1.2 1.6c-.4-.3-.8-.2-1.3.1-2.2 1.5-4.2-.8-6.4.6-.7.5-1.5.4-2.2-.2l1.2-1.6c.4.3.8.2 1.3-.1Z"/></svg>',
        humidifier: '<svg viewBox="0 0 24 24"><path d="M7 8h10a3 3 0 0 1 3 3v10H4V11a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v8h12v-8a1 1 0 0 0-1-1H7Zm2 4h6v2H9v-2ZM9 2h2v2a2 2 0 0 1-2 2H8V4h1V2Zm5 0h2v2a2 2 0 0 1-2 2h-1V4h1V2Z"/></svg>'
    };
    return icons[name] || "";
}

function createSparkline(values, color) {
    const width = 260;
    const height = 58;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = values.map((value, index) => {
        const x = (index / (values.length - 1)) * width;
        const y = height - 10 - ((value - min) / range) * (height - 20);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const area = `0,${height} ${points.join(" ")} ${width},${height}`;

    return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
            <polygon points="${area}" fill="${color}" opacity="0.12"></polygon>
            <polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
            ${points.map(point => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="2.3" fill="${color}"></circle>`).join("")}
        </svg>
    `;
}

function setText(selector, value) {
    const element = document.querySelector(selector);
    if (element) {
        element.textContent = value;
    }
}

function setStateBadge(selector, levelKey) {
    const element = document.querySelector(selector);
    if (!element) return;

    const level = LEVELS[levelKey] || { label: UNKNOWN_TEXT, className: "unknown" };
    element.textContent = level.label;
    element.className = `state-badge state-${level.className}`;
}

function clearStateBadge(selector) {
    const element = document.querySelector(selector);
    if (!element) return;

    element.textContent = "";
    element.className = "state-badge is-empty";
}

function setMetricChange(selector, text, levelKey = "normal") {
    const element = document.querySelector(selector);
    if (!element) return;

    element.textContent = text;
    element.className = `metric-change ${levelKey === "normal" ? "" : levelKey}`;
}

function setStatusDot(element, level) {
    if (!element) return;
    element.className = `status-dot ${level === "normal" ? "online" : ""}`;
}

function renderDeviceChrome() {
    const metrics = dashboardState.metrics || createEmptyMetrics();
    const deviceId = getActiveDeviceId();
    const statusText = metrics.esp?.value || UNKNOWN_TEXT;
    const statusLevel = metrics.esp?.level || "unknown";
    const label = `设备${statusText}`;

    document.querySelectorAll("[data-active-device-name]").forEach(element => {
        element.textContent = deviceId;
    });
    document.querySelectorAll("[data-device-status-text]").forEach(element => {
        element.textContent = statusText;
    });
    document.querySelectorAll("[data-top-status-label]").forEach(element => {
        element.textContent = label;
    });
    document.querySelectorAll("[data-sidebar-status-label]").forEach(element => {
        element.textContent = label;
    });
    document.querySelectorAll("[data-top-status-dot], [data-sidebar-status-dot], [data-device-status-dot]").forEach(element => {
        setStatusDot(element, statusLevel);
    });
}

function renderMetricCards() {
    Object.entries(metricDefinitions).forEach(([key, definition]) => {
        const icon = document.querySelector(`[data-metric-icon="${key}"]`);
        const sparkline = document.querySelector(`[data-sparkline="${key}"]`);
        if (icon) icon.innerHTML = iconSvg(definition.icon);
        if (sparkline) {
            const values = getHistoryValues(definition.historyField);
            sparkline.innerHTML = values.length > 1
                ? createSparkline(values, definition.accent)
                : '<span class="sparkline-empty">暂无数据</span>';
        }
    });

    const metrics = dashboardState.metrics;
    setText("#temperatureValue", metrics.temperature.display || NO_DATA_TEXT);
    setText("#humidityValue", metrics.humidity.display || NO_DATA_TEXT);
    setText("#airQualityValue", metrics.air.display || NO_DATA_TEXT);
    setText('[data-field="temperatureUnit"]', metrics.temperature.value === null || metrics.temperature.source === "loading" || metrics.temperature.source === "error" ? "" : metrics.temperature.unit);
    setText('[data-field="humidityUnit"]', metrics.humidity.value === null || metrics.humidity.source === "loading" || metrics.humidity.source === "error" ? "" : metrics.humidity.unit);
    setText("#airQualityLabel", metrics.air.label);
    setText("#airQualityUnit", metrics.air.unit);
    setText("#espStatusValue", metrics.esp.value);

    setStateBadge('[data-field="temperatureStatus"]', metrics.temperature.level);
    setStateBadge('[data-field="humidityStatus"]', metrics.humidity.level);
    clearStateBadge('[data-field="airStatus"]');
    setStateBadge('[data-field="espStatusBadge"]', metrics.esp.level);

    setMetricChange('[data-field="temperatureChange"]', sourceLabel(metrics.temperature.source), metrics.temperature.level);
    setMetricChange('[data-field="humidityChange"]', sourceLabel(metrics.humidity.source), metrics.humidity.level);
    setMetricChange('[data-field="airChange"]', sourceLabel(metrics.air.source), metrics.air.level);
    setMetricChange('[data-field="espLatency"]', metrics.esp.note, metrics.esp.level);
    renderDeviceChrome();
}

// ESP 延迟显示：设备在线状态只来自 device/status，这里只刷新已获取的状态展示。
function refreshEspDelayDisplay() {
    if (!dashboardState.deviceStatus) return;
    if (!dashboardState.metrics.temperature || !dashboardState.metrics.humidity || !dashboardState.metrics.air) return;

    dashboardState.metrics.esp = getEspStatus(dashboardState.deviceStatus);
    dashboardState.metrics.overall = getOverallLevel(dashboardState.metrics);

    setText("#espStatusValue", dashboardState.metrics.esp.value);
    setStateBadge('[data-field="espStatusBadge"]', dashboardState.metrics.esp.level);
    setMetricChange('[data-field="espLatency"]', dashboardState.metrics.esp.note, dashboardState.metrics.esp.level);
    renderDeviceChrome();
}

function renderMainChart() {
    const canvas = document.getElementById("mainChart");
    if (!canvas) return;

    const context = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const padding = { top: 22, right: 26, bottom: 42, left: 52 };
    const width = rect.width - padding.left - padding.right;
    const height = rect.height - padding.top - padding.bottom;
    const data = getFilteredChartData();
    const chartColors = {
        grid: readThemeColor("--chart-grid", "#dfe7f3"),
        label: readThemeColor("--chart-label", "#33537f"),
        axisLabel: readThemeColor("--chart-axis-label", "#1f3b68"),
        temperature: readThemeColor("--chart-temperature", "#2266f3"),
        humidity: readThemeColor("--chart-humidity", "#10b981"),
        pressure: readThemeColor("--orange", "#f97316"),
        air: readThemeColor("--chart-air", "#7c3aed")
    };
    const chartFields = [
        { field: "temperature", color: chartColors.temperature },
        { field: "humidity", color: chartColors.humidity },
        { field: "pressure", color: chartColors.pressure }
    ];
    if (hasHistoryValues("air")) {
        chartFields.push({ field: "air", color: chartColors.air });
    }
    const allValues = data.flatMap(point => chartFields
        .map(item => toNumber(point[item.field]))
        .filter(value => value !== null));
    if (data.length === 0 || allValues.length === 0) {
        context.fillStyle = chartColors.axisLabel;
        context.font = "15px Avenir Next, PingFang SC, sans-serif";
        context.textAlign = "center";
        context.fillText("暂无数据", rect.width / 2, padding.top + height / 2);
        context.textAlign = "left";
        return;
    }

    const rawMin = Math.min(...allValues);
    const rawMax = Math.max(...allValues);
    const valueRange = rawMax - rawMin || 1;
    const yMin = Math.max(0, rawMin - valueRange * 0.08);
    const yMax = rawMax + valueRange * 0.08;

    context.strokeStyle = chartColors.grid;
    context.lineWidth = 1;
    context.setLineDash([3, 4]);
    context.font = "13px Avenir Next, PingFang SC, sans-serif";
    context.fillStyle = chartColors.label;

    [0, 0.25, 0.5, 0.75, 1].forEach(ratioValue => {
        const value = yMin + (yMax - yMin) * ratioValue;
        const y = padding.top + height - ratioValue * height;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(padding.left + width, y);
        context.stroke();
        context.fillText(formatNumber(value, value >= 1000 ? 0 : 1), 18, y + 4);
    });

    context.setLineDash([]);
    const xFor = index => data.length === 1
        ? padding.left + width / 2
        : padding.left + (index / (data.length - 1)) * width;
    const yFor = value => padding.top + height - ((Math.max(yMin, Math.min(yMax, value)) - yMin) / (yMax - yMin)) * height;

    const drawLine = (field, color) => {
        const drawablePoints = data
            .map((point, index) => ({ point, index, value: toNumber(point[field]) }))
            .filter(item => item.value !== null);

        if (drawablePoints.length === 0) return;

        context.beginPath();
        drawablePoints.forEach((item, drawableIndex) => {
            const x = xFor(item.index);
            const y = yFor(item.value);
            if (drawableIndex === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.strokeStyle = color;
        context.lineWidth = 3;
        context.lineJoin = "round";
        context.lineCap = "round";
        if (drawablePoints.length > 1) {
            context.stroke();
        }

        drawablePoints.forEach(item => {
            const x = xFor(item.index);
            const y = yFor(item.value);
            context.beginPath();
            context.arc(x, y, 4, 0, Math.PI * 2);
            context.fillStyle = color;
            context.fill();
        });
    };

    chartFields.forEach(item => drawLine(item.field, item.color));

    context.fillStyle = chartColors.axisLabel;
    data.forEach((point, index) => {
        if (index % 2 === 0 || rect.width > 760) {
            context.fillText(point.time, xFor(index) - 17, padding.top + height + 30);
        }
    });
}

function renderAlertSummary() {
    const container = document.querySelector("[data-alert-summary]");
    if (!container) return;

    const rows = [
        { label: "温度", value: metricDisplay(dashboardState.metrics.temperature), key: "temperature", icon: "thermometer" },
        { label: "湿度", value: metricDisplay(dashboardState.metrics.humidity), key: "humidity", icon: "drop" },
        {
            label: dashboardState.metrics.air.label,
            value: metricDisplay(dashboardState.metrics.air),
            key: "air",
            icon: "cloud"
        },
        { label: "ESP 状态", value: `${dashboardState.metrics.esp.value} (${dashboardState.metrics.esp.note})`, key: "esp", icon: "chip" }
    ];

    container.innerHTML = rows.map(row => {
        const metric = dashboardState.metrics[row.key];
        const level = LEVELS[metric.level] || { label: UNKNOWN_TEXT, className: "warning" };
        const definition = metricDefinitions[row.key];

        return `
            <div class="summary-row">
                <span class="summary-icon" style="--accent:${definition.accent}">${iconSvg(row.icon)}</span>
                <span>${row.label}</span>
                <span class="summary-value">${row.value}</span>
                <span class="summary-state ${level.className}">${level.label}</span>
            </div>
        `;
    }).join("");
}

function renderAlertLogs() {
    const body = document.querySelector("[data-alert-logs]");
    if (!body) return;

    if (dashboardState.sources.alerts === "loading") {
        body.innerHTML = '<tr><td colspan="5" class="table-empty">Loading...</td></tr>';
        return;
    }
    if (dashboardState.sources.alerts === "error") {
        body.innerHTML = `<tr><td colspan="5" class="table-empty">${ERROR_TEXT}</td></tr>`;
        return;
    }

    const previewLogs = dashboardState.alertLogs.slice(0, ALERT_LOG_PREVIEW_LIMIT);
    if (previewLogs.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="table-empty">暂无报警记录</td></tr>';
        return;
    }

    body.innerHTML = previewLogs.map(log => {
        const type = String(log.type || "报警");
        const time = log.time || EMPTY_TEXT;
        const content = log.content || "";
        const status = log.status || UNKNOWN_TEXT;
        const level = LEVELS[log.level] || LEVELS.normal;
        const accent = log.level === "danger" ? "#ef3340" : log.level === "warning" ? "#f97316" : "#10b981";
        const statusClass = status === "已恢复" ? "recovered" : "pending";

        return `
            <tr>
                <td>${escapeHtml(time)}</td>
                <td><span class="type-cell"><i class="type-icon" style="--accent:${accent}">${iconSvg(type.includes("湿度") ? "drop" : type.includes("温度") ? "thermometer" : type.includes("ESP") ? "chip" : "cloud")}</i>${escapeHtml(type)}</span></td>
                <td>${escapeHtml(content)}</td>
                <td><span class="level-badge level-${level.className}">${level.label}</span></td>
                <td><span class="status-text ${statusClass}">${escapeHtml(status)}</span></td>
            </tr>
        `;
    }).join("");
}

function renderSystemLogs() {
    const container = document.getElementById("latestLogList");
    if (!container) return;

    if (dashboardState.sources.logs === "loading") {
        container.innerHTML = '<div class="system-log empty">Loading...</div>';
        return;
    }
    if (dashboardState.sources.logs === "error") {
        container.innerHTML = `<div class="system-log empty">${ERROR_TEXT}</div>`;
        return;
    }

    const previewLogs = dashboardState.systemLogs.slice(0, SYSTEM_LOG_PREVIEW_LIMIT);
    if (previewLogs.length === 0) {
        container.innerHTML = '<div class="system-log empty">未接入</div>';
        return;
    }

    container.innerHTML = previewLogs.map(log => `
        <div class="system-log">
            <i style="--accent:${log.color}"></i>
            <time>${escapeHtml(log.time)}</time>
            <span>${escapeHtml(log.text)}</span>
        </div>
    `).join("");
}

const OPERATION_STATUS_LABELS = {
    queued: "已排队",
    dispatched: "已下发",
    completed: "已完成",
    pending: "请求中",
    success: "成功",
    failed: "失败",
    unavailable: "不可用"
};

function renderOperationLogItem(log) {
    const status = log.status || "unknown";
    const statusLabel = OPERATION_STATUS_LABELS[status] || UNKNOWN_TEXT;
    const title = log.name || log.command || log.command_id || "命令记录";
    const content = log.device_id ? `设备：${log.device_id}` : "";
    const result = log.error_message || (log.result ? JSON.stringify(log.result) : "");

    return `
        <article class="operation-log-item">
            <div class="operation-log-meta">
                <time>${escapeHtml(log.created_at || log.updated_at || log.time || EMPTY_TEXT)}</time>
                <span class="operation-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
            </div>
            <strong class="operation-log-title">${escapeHtml(title)}</strong>
            ${content ? `<div class="operation-log-content">${escapeHtml(content)}</div>` : ""}
            ${result ? `<div class="operation-log-result">${escapeHtml(result)}</div>` : ""}
        </article>
    `;
}

function renderOperationLogs() {
    const container = document.querySelector("[data-operation-log-list]");
    if (!container) return;

    if (dashboardState.sources.commands === "loading") {
        container.innerHTML = '<div class="operation-log-item empty">Loading...</div>';
        return;
    }
    if (dashboardState.sources.commands === "error") {
        container.innerHTML = `<div class="operation-log-item empty">${ERROR_TEXT}</div>`;
        return;
    }

    const previewLogs = dashboardState.operationLogs.slice(0, OPERATION_LOG_PREVIEW_LIMIT);
    if (previewLogs.length === 0) {
        container.innerHTML = '<div class="operation-log-item empty">暂无命令记录</div>';
        return;
    }

    container.innerHTML = previewLogs.map(renderOperationLogItem).join("");
}

function renderOperationLogModal(logs) {
    if (!logs.length) {
        return '<div class="log-empty">暂无命令记录</div>';
    }

    return `
        <div class="modal-system-log-list">
            ${logs.map(renderOperationLogItem).join("")}
        </div>
    `;
}

// 日志弹窗：渲染报警日志完整列表，数据只来自 dashboardState.alertLogs。
function renderAlertLogModal(logs) {
    if (!logs.length) {
        return '<div class="log-empty">暂无报警记录</div>';
    }

    return `
        <div class="modal-alert-list">
            ${logs.map(log => {
                const type = String(log.type || "报警");
                const time = log.time || EMPTY_TEXT;
                const content = log.content || "";
                const status = log.status || UNKNOWN_TEXT;
                const level = LEVELS[log.level] || LEVELS.normal;
                const statusClass = status === "已恢复" ? "recovered" : "pending";

                return `
                    <article class="modal-alert-log">
                        <time>${escapeHtml(time)}</time>
                        <strong class="modal-alert-type">${escapeHtml(type)}</strong>
                        <span class="modal-alert-content">${escapeHtml(content)}</span>
                        <span class="level-badge level-${level.className}">${level.label}</span>
                        <span class="status-text ${statusClass}">${escapeHtml(status)}</span>
                    </article>
                `;
            }).join("")}
        </div>
    `;
}

// 日志弹窗：渲染最新日志完整列表，保持“时间 + 来源 + 内容”横向阅读方式。
function renderSystemLogModal(logs) {
    if (!logs.length) {
        return '<div class="log-empty">未接入</div>';
    }

    return `
        <div class="modal-system-log-list">
            ${logs.map(log => `
                <article class="modal-system-log">
                    <time>${escapeHtml(log.time || EMPTY_TEXT)}</time>
                    <span class="modal-source-badge">${escapeHtml(log.source || UNKNOWN_TEXT)}</span>
                    <span class="modal-system-content">${escapeHtml(log.text || "")}</span>
                </article>
            `).join("")}
        </div>
    `;
}

// 日志弹窗：根据当前打开类型刷新弹窗内容，Dashboard 轮询更新后会复用它。
function renderActiveLogModal() {
    if (!activeLogModalType) return;

    const title = document.querySelector("[data-log-modal-title]");
    const body = document.querySelector("[data-log-modal-body]");
    if (!title || !body) return;

    if (activeLogModalType === "alerts") {
        title.textContent = "报警日志";
        body.innerHTML = renderAlertLogModal(dashboardState.alertLogs);
        return;
    }

    if (activeLogModalType === "operations") {
        title.textContent = "页面操作记录";
        body.innerHTML = renderOperationLogModal(dashboardState.operationLogs);
        return;
    }

    title.textContent = "最新日志";
    body.innerHTML = renderSystemLogModal(dashboardState.systemLogs);
}

// 日志弹窗：打开覆盖层并渲染当前前端已获取的完整日志数组。
function openLogModal(type) {
    const overlay = document.querySelector("[data-log-modal]");
    if (!overlay) return;

    if (type === "alerts" || type === "operations") {
        activeLogModalType = type;
    } else {
        activeLogModalType = "system";
    }
    renderActiveLogModal();
    overlay.hidden = false;
    document.body.classList.add("log-modal-open");
}

// 日志弹窗：关闭覆盖层并清空当前类型，避免遮罩残留。
function closeLogModal() {
    const overlay = document.querySelector("[data-log-modal]");
    if (!overlay) return;

    overlay.hidden = true;
    activeLogModalType = null;
    document.body.classList.remove("log-modal-open");
}

// 日志弹窗：绑定两个“查看更多”按钮、遮罩、关闭按钮和 Esc 快捷键。
function initLogModals() {
    const overlay = document.querySelector("[data-log-modal]");
    if (!overlay) return;

    document.querySelectorAll("[data-open-log-modal]").forEach(button => {
        button.addEventListener("click", () => {
            openLogModal(button.dataset.openLogModal);
        });
    });

    document.querySelectorAll("[data-open-operation-log]").forEach(button => {
        button.addEventListener("click", () => {
            openLogModal("operations");
        });
    });

    document.querySelectorAll("[data-close-log-modal]").forEach(button => {
        button.addEventListener("click", closeLogModal);
    });

    overlay.addEventListener("click", event => {
        if (event.target === overlay) {
            closeLogModal();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && activeLogModalType) {
            closeLogModal();
        }
    });
}

function renderStatusHeader() {
    const activeAlerts = dashboardState.alertLogs.filter(log => log.level !== "normal" && log.status !== "已恢复");
    const newestAlert = activeAlerts[0] || null;
    const overallLevel = dashboardState.metrics.overall;
    const level = LEVELS[overallLevel] || { label: UNKNOWN_TEXT, className: "warning" };
    const sensorSource = dashboardState.sources.sensor;
    const updatedText = dashboardState.sensor?.hasTimestamp
        ? formatTime(dashboardState.sensor.timestamp)
        : sensorSource === "loading"
            ? LOADING_TEXT
            : sensorSource === "error"
                ? ERROR_TEXT
                : EMPTY_TEXT;

    document.querySelectorAll("[data-last-updated]").forEach(element => {
        element.textContent = updatedText;
    });

    setText("[data-alert-badge]", activeAlerts.length);
    setText("[data-alert-count]", activeAlerts.length);
    setText("[data-alert-log-count]", dashboardState.alertLogs.length);
    setText("[data-current-state]", level.label);

    const stateElement = document.querySelector("[data-current-state]");
    if (stateElement) {
        stateElement.style.color = overallLevel === "danger"
            ? "#ef3340"
            : overallLevel === "warning"
                ? "#f97316"
                : overallLevel === "normal"
                    ? "#10b981"
                    : "#94a3b8";
    }

    const alertPanel = document.getElementById("alertPanel");
    if (alertPanel) {
        alertPanel.dataset.level = overallLevel;
    }

    if (newestAlert) {
        setText("[data-latest-alert] span", `最近报警：${newestAlert.time.slice(0, 5)} ${newestAlert.content}`);
    } else {
        setText("[data-latest-alert] span", "最近报警：暂无数据");
    }
}

function renderSourceDebug() {
    const sources = dashboardState.sources;
    setText('[data-source="sensor"]', sources.sensor);
    setText('[data-source="asr"]', sources.asr);
    setText('[data-source="llm"]', sources.llm);

    const signature = `Sensor: ${sources.sensor} / ASR: ${sources.asr} / LLM: ${sources.llm}`;
    if (signature !== lastSourceSignature) {
        console.info(`[Dashboard] data source -> ${signature}`);
        lastSourceSignature = signature;
    }
}

function showDashboardToast(message, status = "success") {
    const previous = document.querySelector(".dashboard-toast");
    if (previous) {
        previous.remove();
    }

    const toast = document.createElement("div");
    toast.className = `dashboard-toast ${status}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => {
        toast.remove();
    }, 3600);
}

function getSmartHomeDeviceStatusText(device) {
    if (device.loading) return "提交中";
    if (device.disabled) return "未连接";
    if (device.status === true) return "开";
    if (device.status === false) return "关";
    return "暂不可用";
}

function renderSmartHomeControls() {
    const list = document.querySelector("[data-smart-home-list]");
    const note = document.querySelector("[data-smart-home-note]");
    if (!list) return;

    const devices = Array.isArray(dashboardState.smartHomeDevices) ? dashboardState.smartHomeDevices : [];
    const hasEnabledDevice = devices.some(device => !device.disabled);
    if (note) {
        note.hidden = false;
        note.textContent = SMART_HOME_UNAVAILABLE_MESSAGE;
    }
    if (!devices.length) {
        list.innerHTML = '<div class="system-log empty">未接入</div>';
        return;
    }

    list.innerHTML = devices.map(device => {
        const disabled = Boolean(device.disabled || device.loading);
        const statusText = getSmartHomeDeviceStatusText(device);
        const rowClass = [
            "smart-device-row",
            disabled ? "is-disabled" : "",
            device.loading ? "is-loading" : ""
        ].filter(Boolean).join(" ");
        const disabledAttr = disabled ? " disabled" : "";

        return `
            <div class="${rowClass}" data-smart-home-device="${escapeHtml(device.id)}">
                <span class="smart-device-icon" aria-hidden="true">${iconSvg(device.icon)}</span>
                <strong class="smart-device-name">${escapeHtml(device.name)}</strong>
                <span class="smart-device-status">当前状态：${escapeHtml(statusText)}</span>
                <div class="smart-device-segment" role="group" aria-label="${escapeHtml(device.name)}开关状态">
                    <button class="smart-device-option ${device.status === true ? "is-active" : ""}" type="button" data-smart-home-action="on"${disabledAttr}>开</button>
                    <button class="smart-device-option ${device.status === false ? "is-active" : ""}" type="button" data-smart-home-action="off"${disabledAttr}>关</button>
                </div>
            </div>
        `;
    }).join("");
}

function closeSmartHomeConfirmModal() {
    const overlay = document.querySelector("[data-smart-home-confirm-modal]");
    if (!overlay) return;

    overlay.hidden = true;
    document.body.classList.remove("log-modal-open");
}

function handleSmartHomeOptionClick(event) {
    const button = event.target.closest("[data-smart-home-action]");
    if (button && !button.disabled) {
        showDashboardToast(FEATURE_IN_PROGRESS_MESSAGE, "unavailable");
    }
}

async function loadSmartHomeStatuses() {
    dashboardState.smartHomeDevices = null;
    renderSmartHomeControls();
}

// 智能家居控制：绑定卡片按钮和确认弹窗，只复用现有前端方法，不新增 API 地址。
function initSmartHomeControls() {
    const list = document.querySelector("[data-smart-home-list]");
    const overlay = document.querySelector("[data-smart-home-confirm-modal]");

    renderSmartHomeControls();

    if (list) {
        list.addEventListener("click", handleSmartHomeOptionClick);
    }

    document.querySelectorAll("[data-smart-home-confirm-cancel]").forEach(button => {
        button.addEventListener("click", closeSmartHomeConfirmModal);
    });

    if (overlay) {
        overlay.addEventListener("click", event => {
            if (event.target === overlay) {
                closeSmartHomeConfirmModal();
            }
        });
    }

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && overlay && !overlay.hidden) {
            closeSmartHomeConfirmModal();
        }
    });

    loadSmartHomeStatuses();
}

function setCommandButtonLoading(button, loading, loadingText = "处理中...") {
    if (!button) return;

    const label = button.querySelector("span");
    if (label && !button.dataset.originalLabel) {
        button.dataset.originalLabel = label.textContent;
    }

    button.disabled = loading;
    button.classList.toggle("is-loading", loading);

    if (label) {
        label.textContent = loading ? loadingText : button.dataset.originalLabel;
    }
}

function getCommandButton(action) {
    return document.querySelector(`[data-command-action="${action}"]`);
}

function buildSensorSnapshotText(rawSensor, sensor, deviceStatus = dashboardState.deviceStatus) {
    const parts = [];
    const temperature = toNumber(pickFirst(rawSensor, ["temperature", "temp"]));
    const humidity = toNumber(pickFirst(rawSensor, ["humidity"]));
    const pressure = toNumber(pickFirst(rawSensor, ["pressure"]));
    const airQualityObject = isPlainObject(rawSensor.air_quality) ? rawSensor.air_quality : {};
    const airQualityScore = toNumber(rawSensor.air_quality_score) ?? toNumber(airQualityObject.air_quality_score);
    const airQualityLevel = pickFirst(rawSensor, [
        "air_quality_level",
        "air_quality_label"
    ]) ?? pickFirst(airQualityObject, ["air_quality_level", "level", "label"]);

    if (temperature !== null) {
        parts.push(`温度 ${formatNumber(temperature)}°C`);
    }
    if (humidity !== null) {
        parts.push(`湿度 ${formatNumber(humidity)}%`);
    }
    if (pressure !== null) {
        parts.push(`气压 ${formatNumber(pressure)} hPa`);
    }
    if (airQualityScore !== null) {
        parts.push(`空气质量 ${formatNumber(airQualityScore, 0)} 分${airQualityLevel ? ` · ${airQualityLevel}` : ""}`);
    }
    if (sensor && sensor.hasTimestamp) {
        parts.push(`时间 ${formatTime(sensor.timestamp)}`);
    }

    const esp = getEspStatus(deviceStatus);
    if (esp && esp.value) {
        parts.push(`ESP 状态：${esp.value}`);
    }

    return parts.length > 0 ? `已获取当前传感器数据：${parts.join("，")}。` : "已获取当前传感器数据，但接口未返回可展示字段。";
}

function closeCustomCommandModal() {
    const overlay = document.querySelector("[data-custom-command-modal]");
    if (!overlay) return;

    overlay.hidden = true;
    document.body.classList.remove("log-modal-open");
}

function openCustomCommandModal() {
    const overlay = document.querySelector("[data-custom-command-modal]");
    const input = document.querySelector("[data-custom-command-input]");
    const error = document.querySelector("[data-custom-command-error]");
    if (!overlay || !input) return;

    input.value = "";
    if (error) error.textContent = "";
    updateCustomCommandCount();
    overlay.hidden = false;
    document.body.classList.add("log-modal-open");
    input.focus();
}

function updateCustomCommandCount() {
    const input = document.querySelector("[data-custom-command-input]");
    const count = document.querySelector("[data-custom-command-count]");
    if (!input || !count) return;

    count.textContent = `${input.value.length} / ${CUSTOM_COMMAND_MAX_LENGTH}`;
}

function closeCommandConfirmModal() {
    const overlay = document.querySelector("[data-command-confirm-modal]");
    if (!overlay) return;

    overlay.hidden = true;
    pendingConfirmAction = null;
    document.body.classList.remove("log-modal-open");
}

function openCommandConfirmModal(config) {
    const overlay = document.querySelector("[data-command-confirm-modal]");
    const title = document.querySelector("[data-command-confirm-title]");
    const message = document.querySelector("[data-command-confirm-message]");
    const submit = document.querySelector("[data-command-confirm-submit]");
    if (!overlay || !title || !message || !submit) return;

    pendingConfirmAction = config;
    title.textContent = config.title;
    message.textContent = config.message;
    submit.textContent = config.submitText;
    submit.classList.toggle("danger-action", Boolean(config.danger));
    overlay.hidden = false;
    document.body.classList.add("log-modal-open");
}

async function updateDashboard() {
    const deviceId = getActiveDeviceId();
    setDashboardLoadingState(deviceId);

    const [sensorResult, deviceStatusResult, asrResult, llmResult, historyResult, alertResult, systemResult, commandResult] = await Promise.all([
        fetchLatestSensor(deviceId),
        fetchDeviceStatus(deviceId),
        fetchLatestASR(),
        fetchLatestLLM(),
        fetchHistoryData(deviceId),
        fetchAlertLogs(deviceId),
        fetchSystemLogs(deviceId),
        fetchCommandLogs(deviceId)
    ]);

    if (activeDashboardPage === "s3" || getActiveDeviceId() !== deviceId) {
        return;
    }

    const sensor = sensorResult.ok && !sensorResult.empty
        ? normalizeSensor(sensorResult.data, sensorResult.source)
        : null;
    const deviceStatus = deviceStatusResult.ok && !deviceStatusResult.empty
        ? normalizeDeviceStatus(deviceStatusResult.data, deviceStatusResult.source)
        : null;

    dashboardState.sensor = sensor;
    dashboardState.deviceStatus = deviceStatus;
    dashboardState.asr = asrResult.ok && !asrResult.empty ? asrResult.data : null;
    dashboardState.llm = llmResult.ok && !llmResult.empty ? llmResult.data : null;
    dashboardState.sources = {
        sensor: sensorResult.source,
        deviceStatus: deviceStatusResult.source,
        asr: asrResult.source,
        llm: llmResult.source,
        history: historyResult.source,
        alerts: alertResult.source,
        logs: systemResult.source,
        commands: commandResult.source
    };
    dashboardState.metrics = buildMetrics(sensor, deviceStatus);
    dashboardState.history = Array.isArray(historyResult.data) ? historyResult.data : [];
    dashboardState.alertLogs = Array.isArray(alertResult.data) ? alertResult.data.map(normalizeAlertLog) : [];
    dashboardState.systemLogs = Array.isArray(systemResult.data) ? systemResult.data : [];
    dashboardState.operationLogs = Array.isArray(commandResult.data) ? commandResult.data : [];

    renderMetricCards();
    renderMainChart();
    renderAlertSummary();
    renderAlertLogs();
    renderSystemLogs();
    renderActiveLogModal();
    renderStatusHeader();
    renderSourceDebug();
}

async function handleFetchCurrentData(button) {
    setCommandButtonLoading(button, true, "获取中...");
    const deviceId = getActiveDeviceId();

    try {
        const [sensorResult, deviceStatusResult] = await Promise.all([
            fetchLatestSensor(deviceId),
            fetchDeviceStatus(deviceId)
        ]);
        if (!sensorResult.ok || sensorResult.empty) {
            const message = sensorResult.ok ? EMPTY_TEXT : ERROR_TEXT;
            showDashboardToast(message, "failed");
            await updateDashboard();
            return;
        }

        if (activeDashboardPage === "s3" || getActiveDeviceId() !== deviceId) {
            return;
        }

        const sensor = normalizeSensor(sensorResult.data, sensorResult.source);
        const deviceStatus = deviceStatusResult.ok && !deviceStatusResult.empty
            ? normalizeDeviceStatus(deviceStatusResult.data, deviceStatusResult.source)
            : dashboardState.deviceStatus;
        dashboardState.sensor = sensor;
        dashboardState.deviceStatus = deviceStatus;
        dashboardState.sources.sensor = sensorResult.source;
        dashboardState.sources.deviceStatus = deviceStatusResult.source;
        dashboardState.metrics = buildMetrics(sensor, deviceStatus);

        const snapshot = buildSensorSnapshotText(sensorResult.data, sensor, deviceStatus);
        renderMetricCards();
        renderMainChart();
        renderAlertSummary();
        renderStatusHeader();
        renderSourceDebug();
        renderActiveLogModal();

        showDashboardToast(snapshot, "success");
    } catch (error) {
        const message = `获取当前数据失败：${error.message}`;
        showDashboardToast(message, "failed");
    } finally {
        setCommandButtonLoading(button, false);
    }
}

function handleUnavailableOperation(type, content) {
    showDashboardToast(FEATURE_IN_PROGRESS_MESSAGE, "unavailable");
}

async function handleCustomCommandSubmit(event) {
    event.preventDefault();

    const input = document.querySelector("[data-custom-command-input]");
    const error = document.querySelector("[data-custom-command-error]");
    const submit = document.querySelector("[data-submit-custom-command]");
    if (!input || !submit) return;

    const content = input.value.trim();
    if (!content) {
        if (error) error.textContent = "请输入请求内容";
        return;
    }

    if (content.length > CUSTOM_COMMAND_MAX_LENGTH) {
        if (error) error.textContent = `最多 ${CUSTOM_COMMAND_MAX_LENGTH} 个字符`;
        return;
    }

    if (error) error.textContent = "";
    submit.disabled = true;
    submit.textContent = "提交中...";

    showDashboardToast(FEATURE_IN_PROGRESS_MESSAGE, "unavailable");
    submit.disabled = false;
    submit.textContent = "提交";
}

function handleConfirmedUnavailableAction(action) {
    const config = {
        calibrate: {
            type: "校准传感器",
            content: "尝试发送传感器校准请求。"
        },
        reinitialize: {
            type: "重新初始化设备",
            content: "尝试发送设备重新初始化请求，设备可能短暂离线。"
        }
    }[action];

    if (!config) return;

    handleUnavailableOperation(config.type, config.content);
}

function handleClearLogs() {
    showDashboardToast(FEATURE_IN_PROGRESS_MESSAGE, "unavailable");
}

function handleCommandAction(action, button) {
    if (action === "custom") {
        openCustomCommandModal();
        return;
    }

    if (action === "fetch-data") {
        handleFetchCurrentData(button);
        return;
    }

    if (action === "calibrate") {
        openCommandConfirmModal({
            action,
            title: "确认校准传感器？",
            message: "校准期间传感器读数可能短暂波动，请确认是否继续。",
            submitText: "开始校准",
            danger: false
        });
        return;
    }

    if (action === "reinitialize") {
        openCommandConfirmModal({
            action,
            title: "确认重新初始化设备？",
            message: "设备可能短暂离线，请确认是否继续。",
            submitText: "确认重新初始化",
            danger: true
        });
        return;
    }

    if (action === "clear-logs") {
        openCommandConfirmModal({
            action,
            title: "确认清理日志？",
            message: "日志清理功能开发中，当前不会删除任何真实日志。",
            submitText: "确认清理",
            danger: true
        });
    }
}

function bindCommandButtons() {
    document.querySelectorAll("[data-command-action]").forEach(button => {
        button.addEventListener("click", () => {
            handleCommandAction(button.dataset.commandAction, button);
        });
    });
}

// 命令控制：绑定自定义请求弹窗、确认弹窗和真实命令历史。
function initCommandControls() {
    const customOverlay = document.querySelector("[data-custom-command-modal]");
    const confirmOverlay = document.querySelector("[data-command-confirm-modal]");
    const customForm = document.querySelector("[data-custom-command-form]");
    const customInput = document.querySelector("[data-custom-command-input]");
    const confirmSubmit = document.querySelector("[data-command-confirm-submit]");

    renderOperationLogs();

    if (customInput) {
        customInput.addEventListener("input", updateCustomCommandCount);
    }

    if (customForm) {
        customForm.addEventListener("submit", handleCustomCommandSubmit);
    }

    document.querySelectorAll("[data-close-custom-command]").forEach(button => {
        button.addEventListener("click", closeCustomCommandModal);
    });

    document.querySelectorAll("[data-command-confirm-cancel]").forEach(button => {
        button.addEventListener("click", closeCommandConfirmModal);
    });

    if (customOverlay) {
        customOverlay.addEventListener("click", event => {
            if (event.target === customOverlay) {
                closeCustomCommandModal();
            }
        });
    }

    if (confirmOverlay) {
        confirmOverlay.addEventListener("click", event => {
            if (event.target === confirmOverlay) {
                closeCommandConfirmModal();
            }
        });
    }

    if (confirmSubmit) {
        confirmSubmit.addEventListener("click", () => {
            const config = pendingConfirmAction;
            if (!config) return;

            confirmSubmit.disabled = true;
            if (config.action === "clear-logs") {
                handleClearLogs();
            } else {
                handleConfirmedUnavailableAction(config.action);
            }
            confirmSubmit.disabled = false;
            closeCommandConfirmModal();
        });
    }

    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;

        if (customOverlay && !customOverlay.hidden) {
            closeCustomCommandModal();
        }
        if (confirmOverlay && !confirmOverlay.hidden) {
            closeCommandConfirmModal();
        }
    });
}

// 响应式侧边栏：仅控制手机端抽屉导航的打开和关闭，不修改菜单链接或业务逻辑。
function bindMobileSidebar() {
    const sidebar = document.getElementById("dashboardSidebar");
    const toggleButton = document.querySelector("[data-sidebar-toggle]");
    const overlay = document.querySelector("[data-sidebar-overlay]");
    if (!sidebar || !toggleButton || !overlay) return;

    const closeSidebar = () => {
        document.body.classList.remove("sidebar-open");
        toggleButton.setAttribute("aria-expanded", "false");
    };

    const openSidebar = () => {
        document.body.classList.add("sidebar-open");
        toggleButton.setAttribute("aria-expanded", "true");
    };

    toggleButton.addEventListener("click", () => {
        if (document.body.classList.contains("sidebar-open")) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });

    overlay.addEventListener("click", closeSidebar);

    sidebar.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", closeSidebar);
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeSidebar();
        }
    });
}

function normalizeDashboardPage(value) {
    return ["s3", "c51", "c52"].includes(value) ? value : "c51";
}

function getDashboardPageFromHash() {
    return normalizeDashboardPage(window.location.hash.replace("#", ""));
}

function renderS3DashboardIfNeeded(force = false) {
    const container = document.querySelector("[data-s3-dashboard]");
    if (!container || !window.S3Dashboard || typeof window.S3Dashboard.render !== "function") {
        return;
    }

    if (!s3DashboardRendered || force) {
        window.S3Dashboard.render(container);
        s3DashboardRendered = true;
    }
}

function updateRouteChrome(page) {
    document.querySelectorAll("[data-dashboard-page]").forEach(item => {
        const isActive = item.dataset.dashboardPage === page;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-current", isActive ? "page" : "false");
    });

    const s3Page = document.querySelector('[data-page="s3"]');
    const cDevicePage = document.querySelector("[data-c-device-page]");
    if (s3Page) {
        s3Page.hidden = page !== "s3";
    }
    if (cDevicePage) {
        cDevicePage.hidden = page === "s3";
        cDevicePage.dataset.activeDevice = page === "c52" ? "c52" : "c51";
    }

    const dataSourcePanel = document.getElementById("dataSourcePanel");
    if (dataSourcePanel) {
        dataSourcePanel.hidden = page === "s3";
    }
}

function setDashboardPage(page, options = {}) {
    const nextPage = normalizeDashboardPage(page);
    activeDashboardPage = nextPage;
    updateRouteChrome(nextPage);

    if (nextPage === "s3") {
        cleanupDashboardTimers();
        renderS3DashboardIfNeeded(true);
        return;
    }

    if (options.refresh !== false) {
        updateDashboard();
    }
    startDashboardTimers();
}

function handleDashboardRoute() {
    setDashboardPage(getDashboardPageFromHash());
}

window.addEventListener("resize", () => {
    if (activeDashboardPage === "s3") {
        renderS3DashboardIfNeeded(true);
        return;
    }

    renderMainChart();
});

// 主题功能：切换黑白模式后只重绘现有 Canvas 图表颜色，不改变图表数据来源。
window.updateChartTheme = () => {
    if (activeDashboardPage === "s3") {
        renderS3DashboardIfNeeded(true);
        return;
    }

    renderMainChart();
};

// 前端定时器：集中启动和清理 Dashboard 轮询，避免重复 setInterval。
function startDashboardTimers() {
    if (dashboardRefreshTimer) {
        clearInterval(dashboardRefreshTimer);
    }
    if (espDelayRefreshTimer) {
        clearInterval(espDelayRefreshTimer);
    }

    dashboardRefreshTimer = setInterval(updateDashboard, DASHBOARD_REFRESH_INTERVAL_MS);
    espDelayRefreshTimer = setInterval(refreshEspDelayDisplay, ESP_DELAY_REFRESH_INTERVAL_MS);
}

// 前端定时器：页面关闭或刷新时清理定时器，防止内存泄漏。
function cleanupDashboardTimers() {
    if (dashboardRefreshTimer) {
        clearInterval(dashboardRefreshTimer);
        dashboardRefreshTimer = null;
    }
    if (espDelayRefreshTimer) {
        clearInterval(espDelayRefreshTimer);
        espDelayRefreshTimer = null;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initThemeToggle();
    initChartRangeSelector();
    initLogModals();
    bindCommandButtons();
    initCommandControls();
    initSmartHomeControls();
    bindMobileSidebar();
    window.addEventListener("hashchange", handleDashboardRoute);
    handleDashboardRoute();
});

window.addEventListener("beforeunload", cleanupDashboardTimers);
