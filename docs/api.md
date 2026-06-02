# API Reference

本文件记录当前前后端和 ESP 设备之间已经使用的 HTTP 接口。接口字段变更必须先更新本文档，再修改 `server.js` 和 `public/app.js`。

## ESP 上传数据接口

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
