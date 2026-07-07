(function () {
    const EMPTY_TEXT = "暂无数据";
    const ERROR_TEXT = "接口请求失败";
    const UNAVAILABLE_TEXT = "无法获取数据";
    const OFFLINE_TEXT = "离线";
    const UNKNOWN_TEXT = "未知";
    const DISCONNECTED_TEXT = "未连接";

    const applianceSlots = [
        { key: "air_conditioner", label: "空调", icon: "❄️" },
        { key: "light", label: "灯", icon: "💡" },
        { key: "fan", label: "风扇", icon: "🌀" },
        { key: "humidifier", label: "加湿器", icon: "💧" },
        { key: "air_purifier", label: "空气净化器", icon: "◌" }
    ];

    const commandDisplayMap = {
        "light.turn_on": "打开灯",
        "light.turn_off": "关闭灯",
        "air_conditioner.set_temperature": "设置空调温度",
        "air_conditioner.turn_on": "打开空调",
        "air_conditioner.turn_off": "关闭空调",
        "fan.turn_on": "打开风扇",
        "fan.turn_off": "关闭风扇",
        "tv.turn_on": "打开电视",
        "tv.turn_off": "关闭电视",
        "air_quality.read": "读取空气质量",
        "temperature.read": "读取温度",
        "humidity.read": "读取湿度"
    };

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function isPlainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function formatNumber(value, digits = 1) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return DISCONNECTED_TEXT;
        return Number(numeric.toFixed(digits)).toString();
    }

    function formatInteger(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return DISCONNECTED_TEXT;
        return Math.round(numeric).toLocaleString("zh-CN");
    }

    function formatTime(value) {
        if (value === undefined || value === null || value === "") return EMPTY_TEXT;
        const numeric = Number(value);
        const date = Number.isFinite(numeric)
            ? new Date(numeric < 10000000000 ? numeric * 1000 : numeric)
            : new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString("zh-CN", {
            hour12: false,
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
    }

    function unwrapEnvelope(payload) {
        if (payload && typeof payload === "object" && "data" in payload && "ok" in payload) {
            return payload.data;
        }
        return payload;
    }

    async function fetchOverview() {
        const response = await fetch("/api/dashboard/v1/overview", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.status}`);
        }
        return unwrapEnvelope(await response.json());
    }

    async function fetchModulesStatus() {
        const response = await fetch("/api/dashboard/v1/modules/status", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.status}`);
        }
        const data = unwrapEnvelope(await response.json());
        return Array.isArray(data?.modules) ? data.modules : [];
    }

    async function fetchDeviceStatus() {
        const response = await fetch("/api/dashboard/v1/device/status", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.status}`);
        }
        const data = unwrapEnvelope(await response.json());
        return data || null;
    }

    async function fetchCommandHistory() {
        const response = await fetch("/api/commands/history?limit=20", { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`${response.status}`);
        }
        const data = unwrapEnvelope(await response.json());
        return Array.isArray(data?.commands) ? data.commands : [];
    }

    function getStatusClass(status) {
        if (status === true || status === "running" || status === "completed") return "normal";
        if (status === false || status === "stopped" || status === "failed" || status === "disconnected") return "danger";
        if (status === "pending" || status === "standby") return "warning";
        return "unknown";
    }

    function getStatusText(status) {
        const textMap = {
            running: "运行中",
            standby: "待命",
            stopped: DISCONNECTED_TEXT,
            disconnected: DISCONNECTED_TEXT,
            completed: "已完成",
            pending: "处理中",
            failed: "失败"
        };
        if (status === true) return "在线";
        if (status === false) return OFFLINE_TEXT;
        return textMap[status] || status || UNKNOWN_TEXT;
    }

    function boolText(value, trueText, falseText) {
        if (value === true) return trueText;
        if (value === false) return falseText;
        return DISCONNECTED_TEXT;
    }

    function localizeCommandText(value) {
        const text = String(value ?? "");
        return commandDisplayMap[text] || text || EMPTY_TEXT;
    }

    function normalizeGateway(rawGateway, deviceStatus = null) {
        const gateway = isPlainObject(rawGateway) ? rawGateway : {};
        const online = typeof deviceStatus?.online === "boolean"
            ? deviceStatus.online
            : (typeof gateway.online === "boolean" ? gateway.online : null);
        const cloudConnected = typeof gateway.cloud_connected === "boolean"
            ? gateway.cloud_connected
            : (typeof gateway.server_available === "boolean" ? gateway.server_available : null);
        const latency = Number.isFinite(Number(gateway.latency_ms))
            ? Number(gateway.latency_ms)
            : (Number.isFinite(Number(deviceStatus?.latest_upload_delay_ms)) ? Number(deviceStatus.latest_upload_delay_ms) : null);
        const localDegraded = typeof gateway.local_degraded === "boolean"
            ? gateway.local_degraded
            : (typeof deviceStatus?.time_synced === "boolean" ? !deviceStatus.time_synced : null);
        return {
            name: gateway.name || gateway.gateway_id || "S3 Gateway",
            online,
            cloud_connected: cloudConnected,
            latency_ms: latency,
            local_degraded: localDegraded,
            softap_ready: gateway.softap_ready,
            sta_connected: gateway.sta_connected,
            voice_busy: gateway.voice_busy,
            last_error: gateway.last_error || "",
            timestamp: gateway.timestamp,
            modules: []
        };
    }

    function normalizeDeviceStatus(rawStatus) {
        const status = isPlainObject(rawStatus) ? rawStatus : {};
        return {
            online: typeof status.online === "boolean"
                ? status.online
                : (typeof status.device_online === "boolean" ? status.device_online : null),
            device_online: typeof status.device_online === "boolean" ? status.device_online : null,
            latest_upload_delay_ms: Number.isFinite(Number(status.latest_upload_delay_ms))
                ? Number(status.latest_upload_delay_ms)
                : null,
            last_seen_ms: Number.isFinite(Number(status.last_seen_ms)) ? Number(status.last_seen_ms) : null,
            last_seen_age_ms: Number.isFinite(Number(status.last_seen_age_ms)) ? Number(status.last_seen_age_ms) : null,
            time_synced: typeof status.time_synced === "boolean" ? status.time_synced : null
        };
    }

    function normalizeDevice(rawDevice) {
        const device = isPlainObject(rawDevice) ? rawDevice : {};
        const sensors = isPlainObject(device.sensors) ? device.sensors : {};
        const airQualityObject = isPlainObject(sensors.air_quality) ? sensors.air_quality : {};
        const airQualityScore = Number(sensors.air_quality_score ?? airQualityObject.air_quality_score);
        const airQualityLevel = sensors.air_quality_level ?? sensors.air_quality_label ?? airQualityObject.air_quality_level ?? airQualityObject.level ?? "";
        return {
            id: device.device_id || device.id || "",
            name: device.name || device.device_id || device.id || UNKNOWN_TEXT,
            room: device.room_name || device.room || "未分配",
            online: typeof device.online === "boolean" ? device.online : null,
            timestamp: device.timestamp,
            sensors: {
                temperature: sensors.temperature,
                humidity: sensors.humidity,
                pressure: sensors.pressure,
                air_quality_score: Number.isFinite(airQualityScore) ? airQualityScore : null,
                air_quality_level: airQualityLevel ? String(airQualityLevel) : ""
            },
            occupancy: isPlainObject(device.occupancy) ? device.occupancy : null,
            appliances: isPlainObject(device.appliances) ? device.appliances : {}
        };
    }

    function normalizeDeviceId(value) {
        return String(value || "").trim().toUpperCase();
    }

    function normalizeOverview(data, modules = [], commands = [], deviceStatus = null, states = {}) {
        const overview = isPlainObject(data) ? data : {};
        const devices = Array.isArray(overview.devices)
            ? overview.devices.map(normalizeDevice)
            : [];
        const normalizedDeviceStatus = normalizeDeviceStatus(deviceStatus);
        return {
            gateway: {
                ...normalizeGateway(overview.gateway, normalizedDeviceStatus),
                modules
            },
            devices,
            home_summary: buildHomeSummary(devices),
            recent_commands: commands,
            device_status_error: Boolean(states.deviceStatusError),
            module_error: Boolean(states.moduleError),
            command_error: Boolean(states.commandError)
        };
    }

    function buildHomeSummary(devices) {
        if (!devices.length) {
            return {
                online_device_count: null,
                offline_device_count: null,
                avg_temperature: DISCONNECTED_TEXT,
                avg_humidity: DISCONNECTED_TEXT,
                avg_air_quality: DISCONNECTED_TEXT
            };
        }
        const onlineDevices = devices.filter(device => device.online === true).length;
        const offlineDevices = devices.filter(device => device.online === false).length;
        const average = (reader, digits = 1) => {
            const values = devices
                .filter(device => device.online === true)
                .map(reader)
                .map(Number)
                .filter(Number.isFinite);
            if (!values.length) return DISCONNECTED_TEXT;
            return formatNumber(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
        };
        return {
            online_device_count: onlineDevices,
            offline_device_count: offlineDevices,
            avg_temperature: average(device => device.sensors.temperature),
            avg_humidity: average(device => device.sensors.humidity),
            avg_air_quality: average(device => device.sensors.air_quality_score, 0)
        };
    }

    function renderStatusTile(label, value, status) {
        return `
            <div class="s3-status-tile">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
                <i class="s3-status-line ${escapeHtml(status)}"></i>
            </div>
        `;
    }

    function formatAirQuality(sensors, online) {
        if (!online) return DISCONNECTED_TEXT;
        const score = Number(sensors?.air_quality_score);
        if (!Number.isFinite(score)) return DISCONNECTED_TEXT;
        const level = sensors.air_quality_level ? ` · ${sensors.air_quality_level}` : "";
        return `${formatNumber(score, 0)} 分${level}`;
    }

    function formatSensorValue(value, unit, online, digits = 1) {
        if (!online) return DISCONNECTED_TEXT;
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return DISCONNECTED_TEXT;
        return `${formatNumber(numeric, digits)}${unit}`;
    }

    function formatTemperatureHumidity(sensors, online) {
        if (!online) return DISCONNECTED_TEXT;
        const temperature = Number(sensors?.temperature);
        const humidity = Number(sensors?.humidity);
        if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) return DISCONNECTED_TEXT;
        return `${formatNumber(temperature)}°C / ${formatNumber(humidity)}%`;
    }

    function getApplianceStatus(appliances, slot, online) {
        if (!online) {
            return {
                label: slot.label,
                icon: slot.icon,
                state: DISCONNECTED_TEXT,
                isActive: false
            };
        }

        const appliance = appliances?.[slot.key];
        if (!isPlainObject(appliance)) {
            return {
                label: slot.label,
                icon: slot.icon,
                state: "未接入",
                isActive: false
            };
        }
        if (appliance.mock === true || appliance.source === "mock") {
            return {
                label: appliance.name || slot.label,
                icon: slot.icon,
                state: "未接入",
                isActive: false
            };
        }
        if (appliance.online === false) {
            return {
                label: appliance.name || slot.label,
                icon: slot.icon,
                state: DISCONNECTED_TEXT,
                isActive: false
            };
        }

        const rawState = String(appliance.state ?? appliance.status ?? "").trim();
        const explicitOn = appliance.on ?? appliance.enabled ?? appliance.power ?? appliance.online;
        const isActive = typeof explicitOn === "boolean" ? explicitOn : false;
        return {
            label: appliance.name || slot.label,
            icon: slot.icon,
            state: rawState || (isActive ? "开启" : "关闭"),
            isActive
        };
    }

    function formatModuleName(moduleType) {
        const text = String(moduleType || "").trim();
        return text || "未命名模块";
    }

    function renderModuleRows(data) {
        const modules = Array.isArray(data.gateway?.modules) ? data.gateway.modules : [];
        if (data.module_error) {
            return `<div class="system-log empty">${ERROR_TEXT}</div>`;
        }
        if (!modules.length) {
            return '<div class="system-log empty">暂无数据</div>';
        }

        return modules.map(module => {
            const online = module.online === true || module.module_online === true;
            const delay = Number(module.latest_upload_delay_ms);
            const age = Number(module.last_seen_age_ms);
            const detailParts = [];
            if (Number.isFinite(delay)) {
                detailParts.push(`延迟 ${formatInteger(delay)} ms`);
            }
            if (Number.isFinite(age)) {
                detailParts.push(`最近 ${formatInteger(age)} ms 前`);
            }
            return `
                <div class="s3-module-row">
                    <span class="status-dot ${online ? "online" : ""}"></span>
                    <div>
                        <strong>${escapeHtml(formatModuleName(module.module_type))}</strong>
                        <small>${escapeHtml(detailParts.join(" · ") || "暂无数据")}</small>
                    </div>
                    <span class="level-badge level-${getStatusClass(online)}">${getStatusText(online)}</span>
                </div>
            `;
        }).join("");
    }

    function renderSystemStatus(data) {
        const gateway = data.gateway || {};
        const gatewayOnline = gateway.online === true;
        const cloudConnected = gateway.cloud_connected === true;
        const latency = Number(gateway.latency_ms);
        const latencyStatus = Number.isFinite(latency)
            ? (latency <= 80 ? "normal" : "warning")
            : "danger";
        const localDegraded = gateway.local_degraded === true;
        const gatewayTiles = [
            {
                label: "S3 在线状态",
                value: gateway.online === null ? UNKNOWN_TEXT : boolText(gateway.online, "在线", "离线"),
                status: getStatusClass(gateway.online)
            },
            {
                label: "云端连接状态",
                value: gateway.cloud_connected === null ? DISCONNECTED_TEXT : boolText(gateway.cloud_connected, "已连接", "未连接"),
                status: getStatusClass(gateway.cloud_connected)
            },
            {
                label: "延迟",
                value: Number.isFinite(latency) ? `${formatInteger(latency)} ms` : DISCONNECTED_TEXT,
                status: latencyStatus
            },
            {
                label: "本地降级状态",
                value: gateway.local_degraded === null ? DISCONNECTED_TEXT : boolText(gateway.local_degraded, "已启用", "未启用"),
                status: localDegraded ? "warning" : (gatewayOnline || cloudConnected ? "normal" : "danger")
            }
        ];
        const rows = renderModuleRows(data);

        return `
            <article class="panel s3-gateway-panel">
                <div class="panel-header">
                    <h2>系统状态</h2>
                </div>
                <div class="s3-status-grid" aria-label="Gateway 状态">
                    ${gatewayTiles.map(tile => renderStatusTile(tile.label, tile.value, tile.status)).join("")}
                </div>
                <div class="s3-module-list" aria-label="系统状态">${rows}</div>
            </article>
        `;
    }

    function renderHomeSummary(summary) {
        const items = [
            { label: "全屋平均温度", value: summary.avg_temperature === DISCONNECTED_TEXT ? DISCONNECTED_TEXT : `${summary.avg_temperature}°C`, accent: "blue" },
            { label: "全屋平均湿度", value: summary.avg_humidity === DISCONNECTED_TEXT ? DISCONNECTED_TEXT : `${summary.avg_humidity}%`, accent: "green" },
            { label: "平均空气质量", value: summary.avg_air_quality === DISCONNECTED_TEXT ? DISCONNECTED_TEXT : `${summary.avg_air_quality} 分`, accent: "purple" },
            {
                label: "在线 / 离线设备",
                value: summary.online_device_count === null ||
                    summary.offline_device_count === null
                    ? EMPTY_TEXT
                    : `${summary.online_device_count} / ${summary.offline_device_count}`,
                accent: "orange"
            }
        ];

        return `
            <article class="panel s3-summary-panel">
                <div class="panel-header">
                    <h2>全屋概览</h2>
                </div>
                <div class="s3-summary-grid">
                    ${items.map(item => `
                        <div class="s3-summary-tile ${item.accent}">
                            <span>${escapeHtml(item.label)}</span>
                            <strong>${escapeHtml(item.value)}</strong>
                        </div>
                    `).join("")}
                </div>
            </article>
        `;
    }

    function renderSensorMetric(label, value) {
        return `
            <div class="s3-sensor-metric">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value)}</strong>
            </div>
        `;
    }

    function renderDeviceCard(device) {
        const sensors = device.sensors;
        const online = device.online === true;
        return `
            <article class="panel s3-device-card">
                <div class="panel-header">
                    <h2>${escapeHtml(device.name)}</h2>
                    <span class="state-badge state-${getStatusClass(device.online)}">${getStatusText(device.online)}</span>
                </div>
                <div class="s3-sensor-grid">
                    ${renderSensorMetric("温湿度", formatTemperatureHumidity(sensors, online))}
                    ${renderSensorMetric("气压", formatSensorValue(sensors.pressure, " hPa", online))}
                    ${renderSensorMetric("空气质量", formatAirQuality(sensors, online))}
                </div>
                <div class="s3-sensor-grid">
                    ${renderSensorMetric("房间", device.room)}
                    ${renderSensorMetric("最近上报", online ? formatTime(device.timestamp) : DISCONNECTED_TEXT)}
                    ${renderSensorMetric("占用状态", online && device.occupancy?.available ? getStatusText(device.occupancy.state) : DISCONNECTED_TEXT)}
                </div>
                <div class="s3-appliance-grid" aria-label="${escapeHtml(device.room)}设备状态">
                    ${applianceSlots.map(slot => {
                        const appliance = getApplianceStatus(device.appliances, slot, online);
                        return `
                            <div class="s3-appliance ${appliance.isActive ? "is-on" : "is-off"}">
                                <span class="s3-appliance-icon" aria-hidden="true">${appliance.icon}</span>
                                <strong>${escapeHtml(appliance.label)}</strong>
                                <small>${escapeHtml(appliance.state)}</small>
                            </div>
                        `;
                    }).join("")}
                </div>
            </article>
        `;
    }

    function renderDeviceOverview(devices) {
        const content = devices.length
            ? devices.map(renderDeviceCard).join("")
            : '<div class="system-log empty">暂无数据</div>';
        return `
            <section class="s3-section">
                <div class="s3-section-heading">
                    <h2>设备总览</h2>
                </div>
                <div class="s3-device-grid">
                    ${content}
                </div>
            </section>
        `;
    }

    function renderRecentCommands(data) {
        const commands = data.recent_commands;
        const rows = commands.length
            ? commands.map(command => `
                <tr>
                    <td>${escapeHtml(localizeCommandText(command.command || command.name || command.command_id))}</td>
                    <td>${escapeHtml(command.target || command.device_id || EMPTY_TEXT)}</td>
                    <td><span class="level-badge level-${getStatusClass(command.status)}">${getStatusText(command.status)}</span></td>
                    <td>${escapeHtml(formatTime(command.created_at || command.timestamp))}</td>
                    <td>${escapeHtml(formatTime(command.completed_at || command.updated_at))}</td>
                </tr>
            `).join("")
            : `<tr><td colspan="5" class="table-empty">${data.command_error ? ERROR_TEXT : "暂无命令记录"}</td></tr>`;
        return `
            <section class="s3-activity-grid">
                <article class="panel">
                    <div class="panel-header">
                        <h2>最近命令</h2>
                    </div>
                    <div class="table-wrap">
                        <table class="s3-table">
                            <thead>
                                <tr>
                                    <th>命令</th>
                                    <th>目标设备</th>
                                    <th>状态</th>
                                    <th>创建时间</th>
                                    <th>完成时间</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </article>
            </section>
        `;
    }

    function renderLoading(container) {
        const data = normalizeOverview(null, [], [], null, {});
        const summary = buildHomeSummary(data.devices || []);
        container.innerHTML = `
            <div class="s3-dashboard">
                <div class="s3-page-header">
                    <div>
                        <h1>S3 系统总览</h1>
                        <p>Loading...</p>
                    </div>
                    <span class="state-badge state-warning">Loading...</span>
                </div>
                <div class="s3-overview-grid">
                    ${renderSystemStatus(data)}
                    ${renderHomeSummary(summary)}
                </div>
                ${renderDeviceOverview(data.devices || [])}
                ${renderRecentCommands(data)}
            </div>
        `;
    }

    function renderError(container) {
        const data = normalizeOverview(null, [], [], null, {
            deviceStatusError: true,
            moduleError: true,
            commandError: true
        });
        const summary = buildHomeSummary(data.devices || []);
        container.innerHTML = `
            <div class="s3-dashboard">
                <div class="s3-page-header">
                    <div>
                        <h1>S3 系统总览</h1>
                        <p>${UNAVAILABLE_TEXT}</p>
                    </div>
                    <span class="state-badge state-danger">网关离线</span>
                </div>
                <div class="s3-overview-grid">
                    ${renderSystemStatus(data)}
                    ${renderHomeSummary(summary)}
                </div>
                ${renderDeviceOverview(data.devices || [])}
                ${renderRecentCommands(data)}
            </div>
        `;
    }

    async function render(container) {
        if (!container) return;
        renderLoading(container);
        try {
            const [overviewRaw, deviceStatusRaw, modulesResult, commandsResult] = await Promise.allSettled([
                fetchOverview(),
                fetchDeviceStatus(),
                fetchModulesStatus(),
                fetchCommandHistory()
            ]);

            if (overviewRaw.status !== "fulfilled") {
                throw overviewRaw.reason;
            }

            const data = normalizeOverview(
                overviewRaw.value,
                modulesResult.status === "fulfilled" ? modulesResult.value : [],
                commandsResult.status === "fulfilled" ? commandsResult.value : [],
                deviceStatusRaw.status === "fulfilled" ? deviceStatusRaw.value : null,
                {
                    deviceStatusError: deviceStatusRaw.status === "rejected",
                    moduleError: modulesResult.status === "rejected",
                    commandError: commandsResult.status === "rejected"
                }
            );
            const summary = data.home_summary || buildHomeSummary(data.devices || []);
            container.innerHTML = `
                <div class="s3-dashboard">
                    <div class="s3-page-header">
                        <div>
                            <h1>S3 系统总览</h1>
                            <p>系统总览与全屋状态面板</p>
                        </div>
                        <span class="state-badge state-${getStatusClass(data.gateway.online)}">${getStatusText(data.gateway.online)}</span>
                    </div>
                    <div class="s3-overview-grid">
                        ${renderSystemStatus(data)}
                        ${renderHomeSummary(summary)}
                    </div>
                    ${renderDeviceOverview(data.devices || [])}
                    ${renderRecentCommands(data)}
                </div>
            `;
        } catch (error) {
            console.warn("[S3Dashboard] overview request failed", error.message);
            renderError(container);
        }
    }

    window.S3Dashboard = {
        render
    };
})();
