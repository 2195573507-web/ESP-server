const API_CONFIG = {
    sensorLatest: "/sensor/latest",
    sensorHistory: "/sensor/history",
    asrLatest: "/asr/latest",
    llmLatest: "/llm/latest",
    timeSyncStatus: "/api/time/status"
};

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
        mockValue: 25.6,
        trend: [21, 22, 23, 20, 20, 22, 24, 25, 23, 22, 25, 24, 26, 25, 28, 26, 24]
    },
    humidity: {
        name: "湿度",
        unit: "%",
        accent: "#10b981",
        icon: "drop",
        mockValue: 58.3,
        trend: [55, 59, 53, 49, 46, 50, 54, 58, 52, 53, 48, 51, 55, 49, 52, 62, 57]
    },
    air: {
        name: "空气质量",
        unit: "",
        accent: "#8a35ea",
        icon: "cloud",
        mockValue: 132,
        trend: [92, 105, 88, 99, 94, 104, 128, 111, 104, 119, 101, 126, 116, 146, 132, 119]
    },
    esp: {
        name: "ESP 状态",
        unit: "",
        accent: "#f97316",
        icon: "chip",
        mockValue: "在线",
        latency: 32,
        trend: [26, 25, 26, 31, 35, 36, 35, 31, 29, 34, 32, 37, 35, 39, 36, 35, 31]
    }
};

const mockSensorData = {
    temperature: 25.6,
    humidity: 58.3,
    aqi: 132,
    timestamp: Date.now(),
    device_id: null,
    esp_time_ms: null,
    esp_uptime_ms: null,
    upload_delay_ms: null
};

const mockASRData = {
    timestamp: Date.now(),
    text: "暂无真实 ASR 数据，等待设备上传"
};

const mockLLMData = {
    timestamp: Date.now(),
    response: "暂无真实 LLM 数据，等待服务返回"
};

// mockHistoryData: 历史接口无数据或不可用时，主图继续使用前端 mock 数据。
const mockHistoryData = [
    { time: "12:00", temperature: 26, humidity: 58, air: 10 },
    { time: "14:00", temperature: 28, humidity: 62, air: 14 },
    { time: "16:00", temperature: 29, humidity: 70, air: 18 },
    { time: "18:00", temperature: 24, humidity: 66, air: 18 },
    { time: "20:00", temperature: 27, humidity: 56, air: 13 },
    { time: "22:00", temperature: 28, humidity: 60, air: 14 },
    { time: "00:00", temperature: 30, humidity: 72, air: 18 },
    { time: "02:00", temperature: 29, humidity: 74, air: 19 },
    { time: "04:00", temperature: 32, humidity: 66, air: 21 },
    { time: "06:00", temperature: 34, humidity: 70, air: 18 },
    { time: "08:00", temperature: 31, humidity: 76, air: 13 },
    { time: "10:00", temperature: 25, humidity: 68, air: 15 },
    { time: "12:00", temperature: 28, humidity: 69, air: 18 }
];

// mockAlertLogs: 当前后端没有报警日志接口，报警日志表格暂时使用前端 mock 数据。
const mockAlertLogs = [
    { time: "13:58:21", type: "空气质量异常", content: "AQI 132，超过阈值 (100)", level: "warning", status: "未处理" },
    { time: "13:55:10", type: "湿度偏高", content: "湿度 78%，超过阈值 (75%)", level: "warning", status: "未处理" },
    { time: "13:50:02", type: "ESP 离线", content: "超过 10 秒未收到心跳", level: "danger", status: "已恢复" },
    { time: "13:45:30", type: "温度偏高", content: "温度 36.2°C，超过阈值 (35°C)", level: "warning", status: "已恢复" }
];

const mockSystemLogs = [
    { time: "13:58:24", text: "系统运行正常，等待最新设备数据", color: "#2874ff", source: "mock" },
    { time: "13:58:20", text: "数据上传通道已就绪", color: "#10b981", source: "mock" },
    { time: "13:58:10", text: "设备连接状态监测中", color: "#7c3aed", source: "mock" }
];

let dashboardState = {
    sensor: mockSensorData,
    asr: mockASRData,
    llm: mockLLMData,
    metrics: {},
    history: mockHistoryData,
    alertLogs: mockAlertLogs,
    systemLogs: mockSystemLogs,
    commandLogs: [],
    timeSync: {
        ok: false,
        server_time_ms: null,
        server_time_iso: null,
        latest_ping: null
    },
    sources: {
        sensor: "mock",
        asr: "mock",
        llm: "mock"
    }
};

let lastSourceSignature = "";

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasData(value) {
    return isPlainObject(value) && Object.keys(value).length > 0;
}

function formatTime(timestamp = Date.now()) {
    const date = parseTimestamp(timestamp) || new Date();
    return date.toLocaleTimeString("zh-CN", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function formatDateTime(value) {
    const date = parseTimestamp(value);
    if (!date) {
        return "--";
    }

    return date.toLocaleString("zh-CN", {
        hour12: false,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
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

function formatNumber(value, digits = 1) {
    const numeric = toNumber(value);
    if (numeric === null) {
        return "--";
    }
    return Number(numeric.toFixed(digits)).toString();
}

function formatMilliseconds(value) {
    const numeric = toNumber(value);
    if (numeric === null) {
        return "--";
    }

    return `${Math.round(numeric)} ms`;
}

function formatTimestampMs(value) {
    const numeric = toNumber(value);
    if (numeric === null) {
        return "--";
    }

    return `${Math.round(numeric)} (${formatDateTime(numeric)})`;
}

function formatUptime(value) {
    const numeric = toNumber(value);
    if (numeric === null) {
        return "--";
    }

    const totalSeconds = Math.floor(numeric / 1000);
    if (totalSeconds < 60) {
        return `${Math.round(numeric)} ms`;
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(" ");
}

function cloneMockData(mockData) {
    return {
        ...mockData,
        timestamp: Date.now()
    };
}

async function readEndpointResponse(response, mockData, label) {
    if (!response.ok) {
        throw new Error(`${response.url} ${response.status}`);
    }

    const data = await response.json();
    if (hasData(data)) {
        return { data, source: "real" };
    }

    console.warn(`[Dashboard] ${label}: mock fallback because API returned empty data`);
    return { data: cloneMockData(mockData), source: "mock" };
}

function readEndpointFallback(error, mockData, label) {
    console.warn(`[Dashboard] ${label}: mock fallback`, error.message);
    return { data: cloneMockData(mockData), source: "mock" };
}

async function fetchLatestSensor() {
    try {
        const response = await fetch(API_CONFIG.sensorLatest, { cache: "no-store" });
        return readEndpointResponse(response, mockSensorData, "Sensor");
    } catch (error) {
        return readEndpointFallback(error, mockSensorData, "Sensor");
    }
}

async function fetchLatestASR() {
    try {
        const response = await fetch(API_CONFIG.asrLatest, { cache: "no-store" });
        return readEndpointResponse(response, mockASRData, "ASR");
    } catch (error) {
        return readEndpointFallback(error, mockASRData, "ASR");
    }
}

async function fetchLatestLLM() {
    try {
        const response = await fetch(API_CONFIG.llmLatest, { cache: "no-store" });
        return readEndpointResponse(response, mockLLMData, "LLM");
    } catch (error) {
        return readEndpointFallback(error, mockLLMData, "LLM");
    }
}

async function fetchTimeSyncStatus() {
    try {
        const response = await fetch(API_CONFIG.timeSyncStatus, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.url} ${response.status}`);
        }

        return { data: await response.json(), source: "real" };
    } catch (error) {
        console.warn("[Dashboard] TimeSync: status fallback", error.message);
        return {
            data: {
                ok: false,
                server_time_ms: null,
                server_time_iso: null,
                latest_ping: null
            },
            source: "mock"
        };
    }
}

async function fetchHistoryData() {
    try {
        const response = await fetch(`${API_CONFIG.sensorHistory}?limit=50`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.url} ${response.status}`);
        }

        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) {
            console.warn("[Dashboard] History: mock fallback because API returned empty data");
            return mockHistoryData;
        }

        return rows.map(row => {
            const timestamp = parseTimestamp(pickFirst(row, ["timestamp", "server_recv_ms", "created_at", "time"]));
            const gasResistance = toNumber(pickFirst(row, ["gas_resistance", "gas"]));
            const aqi = toNumber(pickFirst(row, ["aqi", "air_quality"]));

            return {
                time: timestamp ? formatTime(timestamp) : "--:--",
                temperature: toNumber(row.temperature) ?? 0,
                humidity: toNumber(row.humidity) ?? 0,
                air: aqi ?? gasResistance ?? 0
            };
        });
    } catch (error) {
        console.warn("[Dashboard] History: mock fallback", error.message);
        return mockHistoryData;
    }
}

async function fetchAlertLogs() {
    // 当前后端没有报警日志接口，保留 mockAlertLogs 作为表格占位。
    return mockAlertLogs;
}

async function fetchSystemLogs() {
    return mockSystemLogs;
}

function normalizeSensor(rawSensor, source) {
    const temperature = toNumber(pickFirst(rawSensor, ["temperature", "temp"]));
    const humidity = toNumber(pickFirst(rawSensor, ["humidity"]));
    const pressure = toNumber(pickFirst(rawSensor, ["pressure"]));
    const aqi = toNumber(pickFirst(rawSensor, ["aqi", "air_quality"]));
    const gas = toNumber(pickFirst(rawSensor, ["gas_resistance", "gas"]));
    const timestampValue = pickFirst(rawSensor, ["timestamp", "created_at", "time"]);
    const timestamp = parseTimestamp(timestampValue);
    const deviceId = pickFirst(rawSensor, ["device_id", "deviceId"]);
    const espTimeMs = toNumber(pickFirst(rawSensor, ["esp_time_ms", "espTimeMs"]));
    const espUptimeMs = toNumber(pickFirst(rawSensor, ["esp_uptime_ms", "espUptimeMs"]));
    const serverRecvMs = toNumber(pickFirst(rawSensor, ["server_recv_ms", "serverRecvMs"]));
    const serverTimeIso = pickFirst(rawSensor, ["server_time_iso", "serverTimeIso"]);
    const uploadDelayMs = toNumber(pickFirst(rawSensor, ["upload_delay_ms", "uploadDelayMs"]));

    let airValue = aqi;
    let airMode = "aqi";
    let airLabel = "空气质量 (AQI)";
    let airUnit = "";

    if (airValue === null && gas !== null) {
        airValue = gas;
        airMode = "gas";
        airLabel = "气体阻值";
        airUnit = "Ω";
    }

    if (airValue === null) {
        airValue = metricDefinitions.air.mockValue;
        airMode = "mock-aqi";
    }

    return {
        raw: rawSensor,
        source,
        temperature: temperature ?? metricDefinitions.temperature.mockValue,
        humidity: humidity ?? metricDefinitions.humidity.mockValue,
        pressure,
        airValue,
        airMode,
        airLabel,
        airUnit,
        timestamp,
        deviceId,
        espTimeMs,
        espUptimeMs,
        serverRecvMs,
        serverTimeIso,
        uploadDelayMs,
        hasTimestamp: Boolean(timestamp),
        usedMockFields: {
            temperature: temperature === null,
            humidity: humidity === null,
            air: aqi === null && gas === null
        }
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

function getAirLevel(value, mode) {
    if (mode === "gas") {
        return "normal";
    }
    if (value > 150) return "danger";
    if (value > 100) return "warning";
    return "normal";
}

function getEspStatus(sensor) {
    if (!sensor.hasTimestamp) {
        // 后端 sensor_records 目前有 timestamp 字段；若未来接口没有时间字段，先默认在线。
        return {
            value: "在线",
            latency: metricDefinitions.esp.latency,
            level: "normal",
            note: "无时间字段，默认在线"
        };
    }

    const ageMs = Date.now() - sensor.timestamp.getTime();
    const isOnline = ageMs <= 10000;

    return {
        value: isOnline ? "在线" : "离线",
        latency: isOnline ? Math.max(1, Math.round(ageMs)) : Math.round(ageMs / 1000),
        level: isOnline ? "normal" : "danger",
        note: isOnline ? `延迟 ${Math.max(1, Math.round(ageMs))}ms` : `离线 ${Math.round(ageMs / 1000)}s`
    };
}

function getOverallLevel(metrics) {
    const levels = [metrics.temperature.level, metrics.humidity.level, metrics.air.level, metrics.esp.level];
    if (levels.includes("danger")) return "danger";
    if (levels.includes("warning")) return "warning";
    return "normal";
}

function buildMetrics(sensor) {
    const esp = getEspStatus(sensor);

    return {
        temperature: {
            value: sensor.temperature,
            display: formatNumber(sensor.temperature),
            level: getTemperatureLevel(sensor.temperature),
            source: sensor.usedMockFields.temperature ? "mock" : sensor.source
        },
        humidity: {
            value: sensor.humidity,
            display: formatNumber(sensor.humidity),
            level: getHumidityLevel(sensor.humidity),
            source: sensor.usedMockFields.humidity ? "mock" : sensor.source
        },
        air: {
            value: sensor.airValue,
            display: sensor.airMode === "gas" ? formatNumber(sensor.airValue, 0) : formatNumber(sensor.airValue, 0),
            level: getAirLevel(sensor.airValue, sensor.airMode),
            mode: sensor.airMode,
            label: sensor.airLabel,
            unit: sensor.airUnit,
            source: sensor.usedMockFields.air ? "mock" : sensor.source
        },
        esp,
        overall: getOverallLevel({
            temperature: { level: getTemperatureLevel(sensor.temperature) },
            humidity: { level: getHumidityLevel(sensor.humidity) },
            air: { level: getAirLevel(sensor.airValue, sensor.airMode) },
            esp
        })
    };
}

function iconSvg(name) {
    const icons = {
        thermometer: '<svg viewBox="0 0 24 24"><path d="M10 4a2 2 0 1 1 4 0v8.4a5 5 0 1 1-4 0V4Zm2 1.5a.5.5 0 0 0-.5.5v9.1l-.8.5a3 3 0 1 0 3.2 0l-.9-.5V6a.5.5 0 0 0-.5-.5Z"/></svg>',
        drop: '<svg viewBox="0 0 24 24"><path d="M12 2.5 6.4 10a7 7 0 1 0 11.2 0L12 2.5Zm0 18a5 5 0 0 1-5-5c0-1.5.9-3.1 2-4.7.8-1.2 1.8-2.5 3-4.1 1.2 1.6 2.2 2.9 3 4.1 1.1 1.6 2 3.2 2 4.7a5 5 0 0 1-5 5Z"/></svg>',
        cloud: '<svg viewBox="0 0 24 24"><path d="M8.5 18.5a5.5 5.5 0 0 1-.9-10.9 6 6 0 0 1 11.5 2 4.5 4.5 0 0 1-.6 8.9h-10Z"/></svg>',
        chip: '<svg viewBox="0 0 24 24"><path d="M8 3h8v3h3v3h2v6h-2v3h-3v3H8v-3H5v-3H3V9h2V6h3V3Zm1.5 6.5v5h5v-5h-5Z"/></svg>',
        bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.5-2h-5A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5-6.7V3a2 2 0 1 0-4 0v1.3A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>'
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

    const level = LEVELS[levelKey] || LEVELS.normal;
    element.textContent = level.label;
    element.className = `state-badge state-${level.className}`;
}

function setMetricChange(selector, text, levelKey = "normal") {
    const element = document.querySelector(selector);
    if (!element) return;

    element.textContent = text;
    element.className = `metric-change ${levelKey === "normal" ? "" : levelKey}`;
}

function renderMetricCards() {
    Object.entries(metricDefinitions).forEach(([key, definition]) => {
        const icon = document.querySelector(`[data-metric-icon="${key}"]`);
        const sparkline = document.querySelector(`[data-sparkline="${key}"]`);
        if (icon) icon.innerHTML = iconSvg(definition.icon);
        if (sparkline) sparkline.innerHTML = createSparkline(definition.trend, definition.accent);
    });

    const metrics = dashboardState.metrics;
    setText("#temperatureValue", metrics.temperature.display);
    setText("#humidityValue", metrics.humidity.display);
    setText("#airQualityValue", metrics.air.display);
    setText("#airQualityLabel", metrics.air.label);
    setText("#airQualityUnit", metrics.air.unit);
    setText("#espStatusValue", metrics.esp.value);

    setStateBadge('[data-field="temperatureStatus"]', metrics.temperature.level);
    setStateBadge('[data-field="humidityStatus"]', metrics.humidity.level);
    setStateBadge('[data-field="airStatus"]', metrics.air.level);
    setStateBadge('[data-field="espStatusBadge"]', metrics.esp.level);

    setMetricChange('[data-field="temperatureChange"]', `来源：${metrics.temperature.source}`, metrics.temperature.level);
    setMetricChange('[data-field="humidityChange"]', `来源：${metrics.humidity.source}`, metrics.humidity.level);
    setMetricChange(
        '[data-field="airChange"]',
        metrics.air.mode === "gas" ? "气体阻值/占位 AQI" : `来源：${metrics.air.source}`,
        metrics.air.level
    );
    setMetricChange('[data-field="espLatency"]', metrics.esp.note, metrics.esp.level);
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
    const yMax = 100;
    const data = dashboardState.history;

    context.strokeStyle = "#dfe7f3";
    context.lineWidth = 1;
    context.setLineDash([3, 4]);
    context.font = "13px Avenir Next, PingFang SC, sans-serif";
    context.fillStyle = "#33537f";

    [0, 25, 50, 75, 100].forEach(value => {
        const y = padding.top + height - (value / yMax) * height;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(padding.left + width, y);
        context.stroke();
        context.fillText(String(value), 18, y + 4);
    });

    context.setLineDash([]);
    const xFor = index => padding.left + (index / (data.length - 1)) * width;
    const yFor = value => padding.top + height - (Math.max(0, Math.min(yMax, value)) / yMax) * height;

    const drawLine = (field, color) => {
        context.beginPath();
        data.forEach((point, index) => {
            const x = xFor(index);
            const y = yFor(point[field]);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
        });
        context.strokeStyle = color;
        context.lineWidth = 3;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.stroke();

        data.forEach((point, index) => {
            const x = xFor(index);
            const y = yFor(point[field]);
            context.beginPath();
            context.arc(x, y, 4, 0, Math.PI * 2);
            context.fillStyle = color;
            context.fill();
        });
    };

    drawLine("temperature", "#2266f3");
    drawLine("humidity", "#10b981");
    drawLine("air", "#7c3aed");

    context.fillStyle = "#1f3b68";
    data.forEach((point, index) => {
        if (index % 2 === 0 || rect.width > 760) {
            context.fillText(point.time, xFor(index) - 17, padding.top + height + 30);
        }
    });
}

function buildDynamicAlertLogs(metrics) {
    const alerts = [];
    const now = formatTime();

    if (metrics.temperature.level !== "normal") {
        alerts.push({
            time: now,
            type: "温度异常",
            content: `温度 ${metrics.temperature.display}°C，状态 ${LEVELS[metrics.temperature.level].label}`,
            level: metrics.temperature.level,
            status: "未处理"
        });
    }

    if (metrics.humidity.level !== "normal") {
        alerts.push({
            time: now,
            type: "湿度异常",
            content: `湿度 ${metrics.humidity.display}%，状态 ${LEVELS[metrics.humidity.level].label}`,
            level: metrics.humidity.level,
            status: "未处理"
        });
    }

    if (metrics.air.level !== "normal") {
        alerts.push({
            time: now,
            type: metrics.air.mode === "gas" ? "气体阻值提示" : "空气质量异常",
            content: `${metrics.air.label} ${metrics.air.display}${metrics.air.unit || ""}，状态 ${LEVELS[metrics.air.level].label}`,
            level: metrics.air.level,
            status: "未处理"
        });
    }

    if (metrics.esp.level !== "normal") {
        alerts.push({
            time: now,
            type: "ESP 异常",
            content: `ESP 状态 ${metrics.esp.value}，${metrics.esp.note}`,
            level: metrics.esp.level,
            status: "未处理"
        });
    }

    return alerts;
}

function renderAlertSummary() {
    const container = document.querySelector("[data-alert-summary]");
    if (!container) return;

    const rows = [
        { label: "温度", value: `${dashboardState.metrics.temperature.display}°C`, key: "temperature", icon: "thermometer" },
        { label: "湿度", value: `${dashboardState.metrics.humidity.display}%`, key: "humidity", icon: "drop" },
        {
            label: dashboardState.metrics.air.label,
            value: `${dashboardState.metrics.air.display}${dashboardState.metrics.air.unit ? ` ${dashboardState.metrics.air.unit}` : dashboardState.metrics.air.mode === "aqi" || dashboardState.metrics.air.mode === "mock-aqi" ? " (AQI)" : ""}`,
            key: "air",
            icon: "cloud"
        },
        { label: "ESP 状态", value: `${dashboardState.metrics.esp.value} (${dashboardState.metrics.esp.note})`, key: "esp", icon: "chip" }
    ];

    container.innerHTML = rows.map(row => {
        const metric = dashboardState.metrics[row.key];
        const level = LEVELS[metric.level];
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

    body.innerHTML = dashboardState.alertLogs.map(log => {
        const level = LEVELS[log.level] || LEVELS.normal;
        const accent = log.level === "danger" ? "#ef3340" : log.level === "warning" ? "#f97316" : "#10b981";
        const statusClass = log.status === "已恢复" ? "recovered" : "pending";

        return `
            <tr>
                <td>${log.time}</td>
                <td><span class="type-cell"><i class="type-icon" style="--accent:${accent}">${iconSvg(log.type.includes("湿度") ? "drop" : log.type.includes("温度") ? "thermometer" : log.type.includes("ESP") ? "chip" : "cloud")}</i>${log.type}</span></td>
                <td>${log.content}</td>
                <td><span class="level-badge level-${level.className}">${level.label}</span></td>
                <td><span class="status-text ${statusClass}">${log.status}</span></td>
            </tr>
        `;
    }).join("");
}

function buildSystemLogs(sensor, asr, llm, sources) {
    const logs = [];
    const sensorTime = sensor.timestamp ? formatTime(sensor.timestamp) : formatTime();

    logs.push({
        time: sensorTime,
        text: `传感器数据更新：温度 ${dashboardState.metrics.temperature.display}°C，湿度 ${dashboardState.metrics.humidity.display}%，${dashboardState.metrics.air.label} ${dashboardState.metrics.air.display}${dashboardState.metrics.air.unit}`,
        color: "#10b981",
        source: sources.sensor
    });

    if (sources.asr === "real" && asr.text) {
        logs.push({
            time: formatTime(asr.timestamp || asr.created_at || asr.time || Date.now()),
            text: `ASR 最新识别：${asr.text}`,
            color: "#2874ff",
            source: "real"
        });
    }

    const llmText = llm.response || llm.answer || llm.text || llm.prompt;
    if (sources.llm === "real" && llmText) {
        logs.push({
            time: formatTime(llm.timestamp || llm.created_at || llm.time || Date.now()),
            text: `LLM 最新回复：${llmText}`,
            color: "#7c3aed",
            source: "real"
        });
    }

    if (logs.length === 1 && sources.asr === "mock" && sources.llm === "mock") {
        logs.push(...mockSystemLogs);
    }

    return [...dashboardState.commandLogs, ...logs].slice(0, 8);
}

function renderSystemLogs() {
    const container = document.getElementById("latestLogList");
    if (!container) return;

    container.innerHTML = dashboardState.systemLogs.map(log => `
        <div class="system-log">
            <i style="--accent:${log.color}"></i>
            <time>${log.time}</time>
            <span>${log.text}</span>
        </div>
    `).join("");
}

function renderStatusHeader() {
    const now = formatTime();
    const dynamicAlerts = buildDynamicAlertLogs(dashboardState.metrics);
    const activeAlerts = dynamicAlerts.filter(log => log.level !== "normal" && log.status !== "已恢复");
    const newestAlert = activeAlerts[0] || dashboardState.alertLogs.find(log => log.level !== "normal");
    const overallLevel = dashboardState.metrics.overall;
    const level = LEVELS[overallLevel];

    document.querySelectorAll("[data-last-updated]").forEach(element => {
        element.textContent = now;
    });

    setText("[data-alert-badge]", activeAlerts.length);
    setText("[data-alert-count]", activeAlerts.length);
    setText("[data-alert-log-count]", dashboardState.alertLogs.length);
    setText("[data-current-state]", level.label);

    const stateElement = document.querySelector("[data-current-state]");
    if (stateElement) {
        stateElement.style.color = overallLevel === "danger" ? "#ef3340" : overallLevel === "warning" ? "#f97316" : "#10b981";
    }

    const alertPanel = document.getElementById("alertPanel");
    if (alertPanel) {
        alertPanel.dataset.level = overallLevel;
    }

    if (newestAlert) {
        setText("[data-latest-alert] span", `最近报警：${newestAlert.time.slice(0, 5)} ${newestAlert.content}`);
    } else {
        setText("[data-latest-alert] span", "最近报警：暂无异常");
    }
}

function renderTimeSyncPanel() {
    const sensor = dashboardState.sensor || {};
    const timeSync = dashboardState.timeSync || {};
    const latestPing = timeSync.latest_ping || sensor.raw?.time_sync?.latest_ping || null;
    const serverTime = timeSync.server_time_iso || timeSync.server_time_ms || sensor.raw?.time_sync?.server_time_iso || sensor.serverTimeIso;
    const deviceId = sensor.deviceId || latestPing?.device_id;
    const status = document.querySelector('[data-time-sync="status"]');

    if (status) {
        status.textContent = timeSync.ok ? "实时" : "等待数据";
        status.className = `sync-pill ${timeSync.ok ? "" : "offline"}`;
    }

    setText('[data-time-sync="serverTime"]', formatDateTime(serverTime));
    setText('[data-time-sync="deviceId"]', deviceId || "--");
    setText('[data-time-sync="espTime"]', formatTimestampMs(sensor.espTimeMs));
    setText('[data-time-sync="espUptime"]', formatUptime(sensor.espUptimeMs));
    setText('[data-time-sync="uploadDelay"]', formatMilliseconds(sensor.uploadDelayMs));
    setText('[data-time-sync="pingDelay"]', formatMilliseconds(latestPing?.estimated_one_way_delay_ms));
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

async function updateDashboard() {
    const [sensorResult, asrResult, llmResult, timeSyncResult, history, mockLogs] = await Promise.all([
        fetchLatestSensor(),
        fetchLatestASR(),
        fetchLatestLLM(),
        fetchTimeSyncStatus(),
        fetchHistoryData(),
        fetchAlertLogs()
    ]);

    const sensor = normalizeSensor(sensorResult.data, sensorResult.source);

    dashboardState.sensor = sensor;
    dashboardState.asr = asrResult.data;
    dashboardState.llm = llmResult.data;
    dashboardState.sources = {
        sensor: sensorResult.source,
        asr: asrResult.source,
        llm: llmResult.source
    };
    dashboardState.timeSync = timeSyncResult.data;
    dashboardState.metrics = buildMetrics(sensor);
    dashboardState.history = history;

    const dynamicAlerts = buildDynamicAlertLogs(dashboardState.metrics);
    dashboardState.alertLogs = dynamicAlerts.length > 0 ? [...dynamicAlerts, ...mockLogs].slice(0, 6) : mockLogs;
    dashboardState.systemLogs = buildSystemLogs(sensor, asrResult.data, llmResult.data, dashboardState.sources);

    renderMetricCards();
    renderMainChart();
    renderAlertSummary();
    renderAlertLogs();
    renderSystemLogs();
    renderStatusHeader();
    renderTimeSyncPanel();
    renderSourceDebug();
}

function bindCommandButtons() {
    document.querySelectorAll("[data-command]").forEach(button => {
        button.addEventListener("click", () => {
            const command = button.dataset.command;
            dashboardState.commandLogs.unshift({
                time: formatTime(),
                text: `命令已触发：${command}`,
                color: "#f97316",
                source: "local"
            });
            dashboardState.commandLogs = dashboardState.commandLogs.slice(0, 5);
            dashboardState.systemLogs = [...dashboardState.commandLogs, ...dashboardState.systemLogs].slice(0, 8);
            renderSystemLogs();
            button.animate(
                [
                    { transform: "translateY(0)" },
                    { transform: "translateY(-2px) scale(1.02)" },
                    { transform: "translateY(0)" }
                ],
                { duration: 220, easing: "ease-out" }
            );
        });
    });
}

window.addEventListener("resize", () => {
    renderMainChart();
});

document.addEventListener("DOMContentLoaded", () => {
    bindCommandButtons();
    updateDashboard();
    setInterval(updateDashboard, 3000);
});
