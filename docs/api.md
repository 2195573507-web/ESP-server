# API Reference

本文件记录当前前后端和 ESP 设备之间已经使用的 HTTP 接口。接口字段变更必须先更新本文档，再修改 `server.js` 和 `public/app.js`。

## ESP 上传数据接口

### `POST /api/llm/text`

Mic-getaway 将 ASR final 文本发送到服务器，服务器只代理文本到火山引擎 LLM Chat Completions 网关，并把模型回复文本返回给 ESP。服务器不接收、不转发、不处理任何 ASR/TTS 音频。

请求体：

```json
{
  "text": "ASR最终文本",
  "device_id": "mic-getaway-001",
  "session_id": "可选"
}
```

字段说明：

- `text`: ASR final 文本，必填，去除首尾空白后不能为空，最大 `4000` 字符。
- `device_id`: 设备 ID，可为空，仅用于服务器日志脱敏定位。
- `session_id`: 会话 ID，可为空，仅用于服务器日志脱敏定位。

成功响应：

```json
{
  "ok": true,
  "text": "LLM回复文本",
  "id": 123,
  "model": "Doubao-Seed-1.6-flash",
  "server_time_ms": 1780000000000
}
```

失败响应：

```json
{
  "ok": false,
  "error": "LLM request failed"
}
```

非法请求会返回 HTTP `400`：

```json
{
  "ok": false,
  "error": "text is required"
}
```

服务器 `.env` 配置示例：

```dotenv
LLM_API_KEY=<火山网关API Key>
LLM_BASE_URL=https://ai-gateway.vei.volces.com
LLM_CHAT_PATH=/v1/chat/completions
LLM_MODEL=Doubao-Seed-1.6-flash
LLM_TIMEOUT_MS=30000
```

说明：

- `Authorization` 只由服务器使用 `.env` 中的 `LLM_API_KEY` 生成，不会返回给 ESP。
- 默认请求地址为火山引擎边缘大模型网关旧版控制台地址：`https://ai-gateway.vei.volces.com/v1/chat/completions`。
- `LLM_MODEL` 使用网关访问密钥绑定的平台预置模型名，例如 `Doubao-Seed-1.6-flash`。不要把新版方舟 Endpoint ID 或新版方舟地域网关地址填到这里。
- 当前服务器只调用平台预置 Chat Completions 模型，不发送 `X-Api-Resource-Id`。该请求头仅适用于自有三方渠道等需要 Resource ID 的场景。
- 调用成功后会写入现有 `llm_records` 表：`prompt=text`，`response=模型回复`，因此 `GET /llm/latest` 仍可显示最新回复。
- 该接口不新增 WebSocket，不处理 ASR 音频，不处理 TTS 音频，不代理 ASR/TTS。

### `POST /api/voice/turn`

ESP 设备上传一轮 PCM 音频，服务器校验格式后转发到 `VOICE_TURN_UPSTREAM_URL` 指向的语音上游服务。该接口本身不直接调用火山引擎 Realtime API。

请求头：

```http
Content-Type: audio/L16; rate=16000; channels=1
X-Audio-Format: pcm_s16le_mono_16k
X-Device-Id: esp32-c5-001
```

字段说明：

- `Content-Type`: 必须声明 `audio/L16; rate=16000; channels=1`。
- `X-Audio-Format`: 必须声明 `pcm_s16le_mono_16k`，用于和服务端 PCM 校验契约对齐。
- `X-Device-Id`: 可选，用于并发控制和脱敏日志定位。

服务器 `.env` 配置示例：

```dotenv
VOICE_TURN_UPSTREAM_URL=<语音上游HTTP地址>
VOICE_TURN_TIMEOUT_MS=45000
VOICE_TURN_MAX_CONCURRENT=1
VOICE_TURN_MAX_BYTES=4194304
VOICE_TURN_MOCK=0
```

失败响应会返回结构化错误码。缺少 `X-Audio-Format` 时返回 HTTP `415`：

```json
{
  "ok": false,
  "code": "VOICE_UNSUPPORTED_AUDIO_FORMAT",
  "error": "X-Audio-Format must be pcm_s16le_mono_16k"
}
```

如果语音上游返回错误，服务器会保留上游状态码信息：

```json
{
  "ok": false,
  "code": "VOICE_UPSTREAM_STATUS",
  "error": "上游错误信息",
  "upstream_status": 415
}
```

### `POST /sensor`

ESP 设备上传传感器数据。该接口是当前传感器数据的写入入口，不要为了前端展示随意改变字段名。

请求体：

```json
{
  "temperature": 25.6,
  "humidity": 58.3,
  "pressure": 1012.4,
  "gas_resistance": 132,
  "device_id": "esp32-001",
  "esp_time_ms": 1717300000000,
  "esp_uptime_ms": 123456
}
```

字段说明：

- `temperature`: 温度，数字。
- `humidity`: 湿度，数字。
- `pressure`: 气压，数字，可为空。
- `gas_resistance`: 气体阻值，数字，可为空。
- `device_id`: 设备 ID，可为空。
- `esp_time_ms`: ESP 侧时间戳，毫秒，可为空。
- `esp_uptime_ms`: ESP 运行时长，毫秒，可为空。

成功响应：

```json
{
  "ok": true,
  "success": true,
  "id": 1,
  "device_id": "esp32-001",
  "esp_time_ms": 1717300000000,
  "esp_uptime_ms": 123456,
  "server_recv_ms": 1717300000100,
  "server_time_iso": "2026-06-02T00:00:00.100Z",
  "upload_delay_ms": 100
}
```

失败响应：

```json
{
  "ok": false,
  "success": false,
  "error": "错误信息"
}
```

## 前端读取最新数据接口

### `GET /sensor/latest`

前端读取最新一条传感器数据。没有数据时返回空对象 `{}`。

响应字段来自 `sensor_records`，并额外包含 `time_sync` 状态：

```json
{
  "id": 1,
  "timestamp": 1717300000100,
  "temperature": 25.6,
  "humidity": 58.3,
  "pressure": 1012.4,
  "gas_resistance": 132,
  "device_id": "esp32-001",
  "esp_time_ms": 1717300000000,
  "esp_uptime_ms": 123456,
  "server_recv_ms": 1717300000100,
  "server_time_iso": "2026-06-02T00:00:00.100Z",
  "upload_delay_ms": 100,
  "time_sync": {
    "ok": true,
    "server_time_ms": 1717300000100,
    "server_time_iso": "2026-06-02T00:00:00.100Z",
    "latest_ping": null
  }
}
```

### `GET /asr/latest`

读取最新一条 ASR 记录。没有数据时返回空对象 `{}`。

```json
{
  "id": 1,
  "timestamp": 1717300000100,
  "text": "识别文本"
}
```

### `GET /llm/latest`

读取最新一条 LLM 记录。没有数据时返回空对象 `{}`。

```json
{
  "id": 1,
  "timestamp": 1717300000100,
  "prompt": "用户问题",
  "response": "模型回复"
}
```

## 前端读取历史数据接口

### `GET /sensor/history`

前端读取传感器历史数据，按时间从旧到新返回数组。

查询参数：

- `limit`: 返回条数，默认 `50`，最大 `500`。

示例：

```bash
curl "http://localhost:3000/sensor/history?limit=10"
```

响应：

```json
[
  {
    "id": 1,
    "timestamp": 1717300000100,
    "temperature": 25.6,
    "humidity": 58.3,
    "pressure": 1012.4,
    "gas_resistance": 132,
    "device_id": "esp32-001",
    "esp_time_ms": 1717300000000,
    "esp_uptime_ms": 123456,
    "server_recv_ms": 1717300000100,
    "server_time_iso": "2026-06-02T00:00:00.100Z",
    "upload_delay_ms": 100
  }
]
```

## 状态/健康检查接口

### `GET /api/time/now`

返回服务器当前时间。

```json
{
  "ok": true,
  "server_time_ms": 1717300000100,
  "server_time_iso": "2026-06-02T00:00:00.100Z"
}
```

### `GET /api/time/status`

返回服务器当前时间和最近一次时间同步 ping 记录。前端当前使用该接口展示时间同步状态。

```json
{
  "ok": true,
  "server_time_ms": 1717300000100,
  "server_time_iso": "2026-06-02T00:00:00.100Z",
  "latest_ping": null
}
```

### `POST /api/time/ping`

ESP 设备可用该接口上报时间同步 ping。它属于状态/调试能力，不替代 `/sensor` 数据上传。

请求体：

```json
{
  "device_id": "esp32-001",
  "esp_send_ms": 1717300000000,
  "esp_uptime_ms": 123456
}
```

响应：

```json
{
  "ok": true,
  "device_id": "esp32-001",
  "esp_send_ms": 1717300000000,
  "esp_uptime_ms": 123456,
  "server_recv_ms": 1717300000100,
  "server_reply_ms": 1717300000101,
  "server_time_iso": "2026-06-02T00:00:00.101Z",
  "estimated_one_way_delay_ms": 100
}
```

## 其他现有写入接口

这些接口当前存在，但不属于 ESP 传感器上传协议。

### `POST /asr`

写入 ASR 文本。

```json
{
  "text": "识别文本"
}
```

### `POST /llm`

写入 LLM 请求和响应。

```json
{
  "prompt": "用户问题",
  "response": "模型回复"
}
```
