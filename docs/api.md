# API Reference

本文件记录当前后端、Dashboard 和 ESP 设备之间已经使用的 HTTP 接口。接口字段变更必须先更新本文档，再修改相关后端或调用方代码。当前统一设备协议 v1 实施不修改任何前端文件。

## 通用机器接口错误格式

`/api/*`、`/sensor`、`/sensor/*`、`/asr`、`/asr/*`、`/llm` 和 `/llm/*` 这类 ESP、Dashboard 或脚本消费的机器接口，在路由不存在时返回 JSON，而不是 Express 默认 HTML/文本：

```json
{
  "ok": false,
  "error": "Not found"
}
```

未预期的后端 route 异常会返回通用 JSON 500：

```json
{
  "ok": false,
  "error": "Internal server error"
}
```

这些兜底错误响应不改变已存在成功接口的响应结构，也不改变 `/dashboard` 或静态前端资源路由。

## ESP 上传数据接口

### `POST /api/llm/text`

Mic-getaway 将 ASR final 文本发送到服务器，服务器只代理文本到火山引擎 LLM Chat Completions 网关，并把模型回复文本返回给 ESP。服务器不接收、不转发、不处理任何 ASR/TTS 音频。
服务器在调用 LLM 前会统一通过 `llmPromptContextService` 注入 `deviceContextService` 读取到的设备、模块、环境、空气状态和数据新鲜度上下文；route 不直接散查 `sensor_records`。

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
- `device_id`: 设备 ID，可为空，仅用于服务器日志脱敏定位；服务器会 trim，最多保留 `128` 个字符。
- `session_id`: 会话 ID，可为空，仅用于服务器日志脱敏定位；服务器会 trim，最多保留 `128` 个字符。

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

### `POST /api/llm/structured`

将用户文本发送到 LLM，并要求模型返回稳定 JSON。服务器解析 `chat` 与 `commands` 分段：`chat.text` 用于自然语言回复，`commands` 进入命令白名单、设备能力校验和命令队列。该接口是新增能力，不改变 `POST /api/llm/text` 的旧响应字段。
该接口同样统一使用 `llmPromptContextService` 注入设备上下文，并在结构化命令提示中保留 JSON-only 指令。

请求体：

```json
{
  "text": "把音量调到 35",
  "device_id": "mic-getaway-001",
  "target_device_id": "esp32-c5-001",
  "session_id": "可选"
}
```

字段说明：

- `text`: 用户文本，必填，最大 `4000` 字符。
- `device_id`: 发起请求的设备 ID，可为空，仅用于日志和命令来源记录；服务器会 trim，最多保留 `128` 个字符。
- `target_device_id`: 命令目标设备 ID；如果为空，服务器使用 `device_id`。结构化 LLM 输出中的命令目标由 Server 使用该字段统一附加或覆盖，避免模型自由选择设备。
- `session_id`: 会话 ID，可为空，仅用于日志定位；服务器会 trim，最多保留 `128` 个字符。

成功响应：

```json
{
  "ok": true,
  "text": "好的，我会把音量调到 35。",
  "chat": {
    "text": "好的，我会把音量调到 35。"
  },
  "commands": [
    {
      "command_id": "uuid",
      "device_id": "esp32-c5-001",
      "name": "voice.set_volume",
      "payload": {
        "volume": 35
      },
      "status": "queued",
      "created_at": "2026-06-07T00:00:00.000Z"
    }
  ],
  "rejected_commands": [],
  "structured": {
    "parsed": true,
    "version": "agent-command-v1",
    "error": ""
  },
  "id": 123,
  "model": "Doubao-Seed-1.6-flash",
  "server_time_ms": 1780000000000
}
```

兼容降级：

- 如果 LLM 返回的内容不是合法 JSON，服务器不会让请求失败；会把原始文本作为纯聊天回复返回，并给出 `structured.parsed=false`。
- 如果 LLM 返回合法 JSON 但缺少 `chat.text`，`text` 和 `chat.text` 会保持为空字符串，不会把整段 JSON 当作自然语言回复。
- 如果命令不在白名单、目标设备未注册能力，或 payload 不合法，对应命令进入 `rejected_commands`，不会进入队列。
- `rejected_commands[]` 中每项包含 `name`、`target_device_id`、`code` 和 `error`，常见 `code` 包括 `COMMAND_NOT_WHITELISTED`、`COMMAND_TARGET_INVALID`、`DEVICE_CAPABILITIES_REQUIRED`、`DEVICE_COMMAND_UNSUPPORTED`、`COMMAND_PAYLOAD_INVALID`。
- 该接口只建立 Server 侧结构化协议和命令队列，不代表 ESP 固件已经实现命令执行。

### `POST /api/voice/turn`

ESP 设备上传一轮 PCM 音频，服务器校验格式后返回一轮语音音频。该接口默认不调用任何火山引擎语音地址，也不会把请求发到不存在的 `/v1/voice`。
该接口支持统一设备协议 v1 header metadata，并会刷新 `device_status` 与 `device_module_status(module_type="voice.turn")`。真实链路中的 ASR final 文本进入 LLM 前也统一通过 `llmPromptContextService` 注入设备上下文。

请求头：

```http
Content-Type: audio/L16; rate=16000; channels=1
X-Audio-Format: pcm_s16le_mono_16k
X-Device-Id: esp32-c5-001
X-Voice-Turn-Id: 可选请求追踪ID
X-Schema-Version: 1
X-Device-Type: esp32c5_env_voice_node
X-Firmware-Version: 0.1.0
X-Request-Seq: 123
X-Esp-Uptime-Ms: 12345678
X-Esp-Time-Ms: 1780732142207
X-Time-Synced: true
X-Payload-Type: voice.turn
```

字段说明：

- `Content-Type`: 必须声明 `audio/L16; rate=16000; channels=1`。
- `X-Audio-Format`: 必须声明 `pcm_s16le_mono_16k`，用于和服务端 PCM 校验契约对齐。
- `X-Device-Id`: 可选，用于并发控制和脱敏日志定位。
- `X-Voice-Turn-Id`: 可选，用于将 ESP 侧日志和 Server 侧 `voice_turns` 持久化记录关联；未传时 Server 自动生成。
- `X-Schema-Version`、`X-Device-Type`、`X-Firmware-Version`、`X-Request-Seq`、`X-Esp-Uptime-Ms`、`X-Esp-Time-Ms`、`X-Time-Synced`、`X-Payload-Type`: 统一设备协议 v1 metadata，raw PCM body 不改成 JSON。

服务器 `.env` 配置示例：

```dotenv
VOICE_TURN_MOCK=1
VOICE_TURN_TIMEOUT_MS=45000
VOICE_TURN_MAX_CONCURRENT=1
VOICE_TURN_MAX_BYTES=4194304
VOLC_GATEWAY_API_KEY=<火山网关API Key，仅 VOICE_TURN_MOCK=0 时需要>
VOLC_GATEWAY_WS_BASE_URL=wss://ai-gateway.vei.volces.com
VOLC_GATEWAY_HTTP_BASE_URL=https://ai-gateway.vei.volces.com
VOLC_GATEWAY_REALTIME_PATH=/v1/realtime
VOLC_GATEWAY_CHAT_PATH=/v1/chat/completions
VOLC_GATEWAY_ASR_MODEL=bigmodel
VOLC_GATEWAY_CHAT_MODEL=Doubao-Seed-1.6-flash
VOLC_GATEWAY_TTS_MODEL=<TTS 模型>
VOLC_GATEWAY_TTS_VOICE=<TTS 音色>
VOLC_GATEWAY_TTS_PATH=/v1/realtime
VOLC_GATEWAY_TTS_SAMPLE_RATE=16000
VOLC_GATEWAY_TTS_FORMAT=pcm_s16le_mono_16k
```

配置说明：

- 当前项目没有内置真实 ASR+LLM+TTS voice turn 上游时，请设置 `VOICE_TURN_MOCK=1`。服务器会稳定返回 `audio/L16; rate=16000; channels=1` 的 mock PCM 音频，用于验证 ESP32 和 Node 后端的 HTTP 音频链路。
- `VOICE_TURN_MOCK=1` 也会让 `GET /api/voice/prompt` 返回 1 秒非静音 mock PCM，用于验证 wake prompt cache 下载、保存和播放链路；该 mock PCM 只是测试音，不代表真实“我在，你说”TTS 音色。
- 只有接入真实火山网关 ASR -> LLM -> TTS 链路时，才设置 `VOICE_TURN_MOCK=0` 并填写 `VOLC_GATEWAY_*` 配置。
- 火山网关当前已知可用的是文本 Chat Completions：`https://ai-gateway.vei.volces.com/v1/chat/completions`，以及 Realtime WebSocket：`wss://ai-gateway.vei.volces.com/v1/realtime?model=bigmodel`。这些都不是 `/v1/voice` HTTP turn 上游。
- 当前后端实现使用 `VOLC_GATEWAY_*` 配置完成 ASR -> LLM -> TTS 链式处理；`VOICE_TURN_MOCK=1` 时不调用外部 ASR/LLM/TTS。
- HTTP TTS 上游响应允许 raw PCM、WAV PCM s16le mono 16kHz，或 JSON 中的 base64 PCM 字段（如 `pcm_base64`、`audio_base64`、`pcm`、`audio`、`data`）。
- `VOICE_TURN_TIMEOUT_MS` 是 Server 侧单轮语音总超时。ESP 侧上传超时应大于该值加网络余量，避免 Server 还在处理时设备提前断开。
- Server 会在 SQLite 中创建并维护 `voice_turns` 表，用于记录每轮 `/api/voice/turn` 的请求 ID、设备 ID、模式、状态、错误码、输入/响应字节、ASR/LLM/TTS 耗时和总耗时。该表是后端诊断日志，不改变当前 HTTP 响应格式。

失败响应会返回结构化错误码。缺少 `X-Audio-Format` 时返回 HTTP `415`：

```json
{
  "ok": false,
  "code": "VOICE_UNSUPPORTED_AUDIO_FORMAT",
  "error": "X-Audio-Format must be pcm_s16le_mono_16k"
}
```

`Content-Type` 不是 `audio/L16; rate=16000; channels=1` 时返回 HTTP `415`：

```json
{
  "ok": false,
  "code": "VOICE_UNSUPPORTED_CONTENT_TYPE",
  "error": "Content-Type must be audio/L16; rate=16000; channels=1"
}
```

PCM 请求体为空时返回 HTTP `400`：

```json
{
  "ok": false,
  "code": "VOICE_BODY_EMPTY",
  "error": "PCM request body must not be empty"
}
```

PCM 请求体不是 16-bit little-endian 对齐的偶数字节长度时返回 HTTP `400`：

```json
{
  "ok": false,
  "code": "VOICE_PCM_ALIGNMENT_INVALID",
  "error": "PCM s16le body length must be an even number of bytes"
}
```

PCM 请求体超过 `VOICE_TURN_MAX_BYTES` 时返回 HTTP `413`：

```json
{
  "ok": false,
  "code": "VOICE_BODY_TOO_LARGE",
  "error": "request entity too large"
}
```

未启用 mock 且未配置 ASR 网关参数时返回 HTTP `503`：

```json
{
  "ok": false,
  "code": "VOICE_ASR_NOT_CONFIGURED",
  "error": "VOLC_GATEWAY_API_KEY and VOLC_GATEWAY_ASR_MODEL must be configured when VOICE_TURN_MOCK is not 1"
}
```

未启用 mock 且未配置 TTS 参数时返回 HTTP `503`：

```json
{
  "ok": false,
  "code": "VOICE_TTS_NOT_CONFIGURED",
  "error": "VOLC_GATEWAY_TTS_MODEL, VOLC_GATEWAY_TTS_VOICE, and VOLC_GATEWAY_TTS_PATH must be configured when VOICE_TURN_MOCK is not 1"
}
```

如果 ASR、LLM 或 TTS 上游返回错误，服务器会保留上游状态码信息：

```json
{
  "ok": false,
  "code": "VOICE_LLM_FAILED",
  "error": "上游错误信息",
  "upstream_status": 415
}
```

### `GET /api/voice/prompt-cache`

ESP 唤醒提示音服务器缓存接口。当前 `Whole-project` wake prompt 主路径请求：

```http
GET /api/voice/prompt-cache?prompt_key=wake_ack_zh&device_id=esp32-c5-whole-001
```

请求可携带统一设备协议 v1 header metadata，`X-Payload-Type` 使用 `voice.prompt`。服务器会刷新 `device_status` 与 `device_module_status(module_type="voice.prompt")`。

成功响应为 raw PCM，不是 JSON：

```http
Content-Type: audio/L16; rate=16000; channels=1
X-Prompt-Key: wake_ack_zh
X-Prompt-Cache: hit
X-Audio-Format: pcm_s16le_mono_16k
X-Sample-Rate: 16000
X-Channels: 1
X-Server-Time-Ms: 1780732144669
Cache-Control: public, max-age=86400
```

`X-Prompt-Cache` 取值：

- `hit`: 命中服务器缓存，直接返回文件，不请求 TTS、LLM 或网关。
- `miss`: 缓存缺失，本次调用 TTS 生成并写入缓存后返回。
- `stale`: 本次刷新失败，但存在旧缓存，返回旧缓存。

缓存文件默认位于 `cache/voice_prompts/`；测试可通过 `VOICE_PROMPT_CACHE_DIR` 指向临时目录，避免污染仓库。

### `GET /api/voice/prompt`

兼容唤醒提示音接口。旧请求 `GET /api/voice/prompt?wake=1&prompt_key=wake_ack_zh` 保留，并复用服务器 prompt cache 行为。缓存命中时同样不会请求 TTS、LLM 或网关。`POST /api/voice/turn` 主语音链路不受该缓存影响。

## 命令系统接口

### `GET /api/commands/whitelist`

读取服务器当前允许的命令白名单。LLM 或外部调用只能创建白名单内的命令。

```json
{
  "ok": true,
  "commands": [
    {
      "name": "voice.set_volume",
      "description": "Request a bounded playback volume change.",
      "payload": {
        "volume": {
          "type": "integer",
          "min": 0,
          "max": 100,
          "required": true
        }
      }
    }
  ]
}
```

当前白名单：

- `device.noop`
- `voice.set_volume`
- `sensor.set_upload_interval`
- `display.show_text`
- `alert.play_tone`

### `POST /api/devices/capabilities`

ESP 设备注册自己支持的命令能力。服务器只会向目标设备排队该设备已注册支持的白名单命令。`device_id` 会 trim 首尾空白，最大长度为 `128` 个字符。`protocol_version` 会 trim 首尾空白，最大长度为 `40` 个字符。`capabilities.commands` 中的命令名会 trim、去重，并且只保存当前白名单中的命令；未知或超长命令名会被忽略，不会进入设备能力快照。
该接口支持统一设备协议 v1 header metadata，并会刷新 `device_status` 与 `device_module_status(module_type="command.capabilities")`。

请求体：

```json
{
  "device_id": "esp32-c5-whole-001",
  "protocol_version": "agent-command-v1",
  "capabilities": {
    "commands": [
      "device.noop",
      "display.show_text"
    ]
  }
}
```

当前 `Whole-project` 固件会注册 `device.noop` 和 `display.show_text`。其中 `display.show_text` 只调用固件上层 `screen_service` / `ai_screen_bridge` 占位接口，不代表 LCD 底层驱动已经接入。

成功响应：

```json
{
  "ok": true,
  "device_id": "esp32-c5-whole-001",
  "protocol_version": "agent-command-v1",
  "capabilities": {
    "commands": [
      "device.noop",
      "display.show_text"
    ]
  },
  "server_time_ms": 1780000000000
}
```

错误响应：

- `400 DEVICE_ID_REQUIRED`: 缺少 `device_id`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 PROTOCOL_VERSION_INVALID`: `protocol_version` 超过 `40` 个字符。

### `GET /api/devices/:device_id/capabilities`

读取某个设备最近注册的能力。路径中的 `device_id` 会 trim 首尾空白，最大长度为 `128` 个字符。未注册时返回 HTTP `404`。

错误响应：

- `400 DEVICE_ID_REQUIRED`: 缺少 `device_id`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。

### `POST /api/commands`

手动创建一条命令。服务器会先检查命令白名单，再检查目标设备是否注册支持该命令。`target_device_id` 会 trim 首尾空白，最大长度为 `128` 个字符；结构化 LLM 入口的 `target_device_id` 也遵循同一限制。`reason` 可选，最大 `240` 个字符。

请求体：

```json
{
  "name": "voice.set_volume",
  "target_device_id": "esp32-c5-001",
  "payload": {
    "volume": 35
  },
  "reason": "用户要求调低音量"
}
```

成功响应返回 HTTP `201`：

```json
{
  "ok": true,
  "command": {
    "command_id": "uuid",
    "device_id": "esp32-c5-001",
    "name": "voice.set_volume",
    "payload": {
      "volume": 35
    },
    "status": "queued",
    "created_at": "2026-06-07T00:00:00.000Z"
  }
}
```

失败示例：

```json
{
  "ok": false,
  "code": "COMMAND_NOT_WHITELISTED",
  "error": "command is not whitelisted",
  "name": "unknown.command"
}
```

目标设备 ID 过长时返回：

```json
{
  "ok": false,
  "code": "COMMAND_TARGET_INVALID",
  "error": "target_device_id must be <= 128 characters",
  "name": "display.show_text",
  "target_device_id": "被截断到128字符的预览"
}
```

`reason` 过长时返回：

```json
{
  "ok": false,
  "code": "COMMAND_REASON_INVALID",
  "error": "reason must be <= 240 characters"
}
```

### `GET /api/commands/pending`

ESP 设备轮询待执行命令。服务器会把返回的命令从 `queued` 标记为 `dispatched`。如果设备领取后没有成功回执，`COMMAND_DISPATCH_TIMEOUT_MS` 之后该命令会再次出现在轮询结果中，避免 ack 丢失后命令永久卡在 `dispatched`。
该接口支持统一设备协议 v1 header metadata，并会刷新 `device_status` 与 `device_module_status(module_type="command.poll")`。

查询参数：

- `device_id`: 必填，目标设备 ID。ESP 或其他客户端放入 URL query 前必须做 percent-encoding；例如 `esp 32+c5&测试` 应发送为 `esp%2032%2Bc5%26%E6%B5%8B%E8%AF%95`。
- `limit`: 可选，默认 `10`，最大 `50`。

错误响应：

- `400 DEVICE_ID_REQUIRED`: 缺少 `device_id`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。

配置：

```dotenv
COMMAND_DISPATCH_TIMEOUT_MS=60000
```

响应：

```json
{
  "ok": true,
  "commands": [
    {
      "command_id": "uuid",
      "device_id": "esp32-c5-001",
      "name": "voice.set_volume",
      "payload": {
        "volume": 35
      },
      "status": "dispatched",
      "created_at": "2026-06-07T00:00:00.000Z",
      "dispatched_at": "2026-06-07T00:00:01.000Z"
    }
  ],
  "server_time_ms": 1780000000000
}
```

### `POST /api/commands/:command_id/ack`

ESP 执行命令后回传结果。该接口只记录回执，不由 Server 判断风险或代替 ESP 执行动作。
`status` 只接受 `completed` 或 `failed`；其他值返回 HTTP `400`，不会把命令误标为完成。
该接口支持统一设备协议 v1 header metadata，并会刷新 `device_status` 与 `device_module_status(module_type="command.ack")`。

成功回执：

```json
{
  "status": "completed",
  "result": {
    "applied": true
  }
}
```

失败回执：

```json
{
  "status": "failed",
  "error_code": "DEVICE_REJECTED",
  "error_message": "volume output is disabled",
  "result": {
    "applied": false
  }
}
```

非法状态响应返回 HTTP `400`：

```json
{
  "ok": false,
  "code": "COMMAND_ACK_STATUS_INVALID",
  "error": "status must be completed or failed"
}
```

命令不存在或已经完成后再次回执会返回 HTTP `404`：

```json
{
  "ok": false,
  "code": "COMMAND_ACK_NOT_ACCEPTED",
  "error": "command not found or already completed",
  "command_id": "uuid"
}
```

### `GET /api/commands/history`

读取命令历史。该接口面向后端调试和未来 Dashboard API，当前不修改 Dashboard 前端。

查询参数：

- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。

## 长期记忆接口

### `POST /api/conversation/turns`

保存一条对话 turn。该接口是长期记忆的原始输入记录，不代表该 turn 已经进入长期画像。

请求体：

```json
{
  "turn_id": "可选，客户端自带去重ID",
  "session_id": "session-001",
  "device_id": "esp32-c5-001",
  "role": "assistant",
  "input_text": "用户输入",
  "response_text": "助手回复",
  "structured": {
    "parsed": true
  },
  "command_ids": [
    "uuid"
  ],
  "memory_level": "episodic",
  "importance": 2,
  "source": "voice_turn"
}
```

字段说明：

- `turn_id`: 可选；如果不传，Server 自动生成。客户端指定的 `turn_id` 必须唯一，最大 `80` 个字符。
- `session_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `role`: 可选，默认 `user`，最大 `40` 个字符。
- `source`: 可选，默认 `api`，最大 `80` 个字符。
- `input_text` 和 `response_text` 至少一个不能为空。
- `memory_level`: 可为 `volatile`、`episodic`、`important`、`profile_candidate`、`archived`。
- `importance`: `0` 到 `5` 的整数。

错误响应：

- `400`: `input_text` 和 `response_text` 均为空。
- `400 CONVERSATION_TURN_ID_INVALID`: `turn_id` 超过 `80` 个字符。
- `400 CONVERSATION_ROLE_INVALID`: `role` 超过 `40` 个字符。
- `400 CONVERSATION_SOURCE_INVALID`: `source` 超过 `80` 个字符。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 SESSION_ID_INVALID`: `session_id` 超过 `128` 个字符。
- `409 CONVERSATION_TURN_ID_DUPLICATE`: 请求体指定的 `turn_id` 已存在。

### `GET /api/conversation/turns`

读取对话 turn。

查询参数：

- `session_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 SESSION_ID_INVALID`: `session_id` 超过 `128` 个字符。

### `POST /api/memory/daily`

写入每日摘要候选。摘要内容必须来自 LLM 输出、明确用户输入或人工确认；Server 不自行推理总结。

请求体：

```json
{
  "memory_date": "2026-06-07",
  "summary": "今天的交互摘要候选",
  "status": "candidate",
  "confidence": 0.6,
  "source": "llm_summary"
}
```

字段说明：

- `memory_date` 或 `date`: 必填，格式 `YYYY-MM-DD`。
- `status`: 可为 `candidate`、`active`、`rejected`、`archived`；非法值会按 `candidate` 写入。
- `confidence`: `0` 到 `1`；超出范围会被夹到边界。

错误响应：

- `400 DAILY_MEMORY_DATE_INVALID`: `memory_date` 或 `date` 不是 `YYYY-MM-DD` 格式。

### `GET /api/memory/daily`

读取每日摘要候选。

查询参数：

- `memory_date` 或 `date`: 可选，格式 `YYYY-MM-DD`。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DAILY_MEMORY_DATE_INVALID`: `memory_date` 或 `date` 不是 `YYYY-MM-DD` 格式。

### `POST /api/memory/profile`

写入或更新长期画像候选。该接口只保存候选或已审核画像，不由 Server 自行生成画像结论。

请求体：

```json
{
  "profile_key": "user.prefers_quiet_volume",
  "profile_value": "用户偏好较低音量",
  "category": "user",
  "status": "candidate",
  "confidence": 0.5,
  "evidence": [
    {
      "turn_id": "turn_uuid"
    }
  ],
  "source": "weekly_profile"
}
```

字段说明：

- `profile_key`: 画像键，必填，最大 `120` 个字符。
- `category`: 可选，默认 `user`，最大 `80` 个字符。
- `status`: 可为 `candidate`、`active`、`rejected`、`archived`。
- `confidence`: `0` 到 `1`。

错误响应：

- `400 PROFILE_KEY_INVALID`: `profile_key` 超过 `120` 个字符。
- `400 PROFILE_CATEGORY_INVALID`: `category` 超过 `80` 个字符。

### `GET /api/memory/profile`

读取长期画像候选或有效画像。

查询参数：

- `status`: 可选。
- `category`: 可选，会 trim 首尾空白，最大 `80` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 PROFILE_STATUS_INVALID`: `status` 不是 `candidate`、`active`、`rejected` 或 `archived`。
- `400 PROFILE_CATEGORY_INVALID`: `category` 超过 `80` 个字符。

### `POST /api/memory/corrections`

用户纠错入口。纠错会写入 `memory_corrections`；当 `target_type=profile` 时，会把目标画像重新标记为 `candidate` 并增加纠错次数。

请求体：

```json
{
  "target_type": "profile",
  "target_id": "user.prefers_quiet_volume",
  "correction_text": "我不是一直喜欢低音量，只是晚上需要低音量。",
  "corrected_value": "用户晚上偏好较低音量",
  "device_id": "esp32-c5-001",
  "session_id": "session-001"
}
```

字段说明：

- `target_type`: 目标类型，必填，最大 `40` 个字符；当前 `profile` 会触发画像候选回写。
- `target_id`: 目标记录 ID 或画像键，最大 `120` 个字符。
- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `session_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `status`: 可为 `applied`、`pending`、`rejected`、`archived`；非法值会按 `applied` 写入。

错误响应：

- `400 MEMORY_CORRECTION_TARGET_TYPE_INVALID`: `target_type` 超过 `40` 个字符。
- `400 MEMORY_CORRECTION_TARGET_ID_INVALID`: `target_id` 超过 `120` 个字符。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 SESSION_ID_INVALID`: `session_id` 超过 `128` 个字符。

### `POST /api/jobs/daily-summary/run`

创建每日总结任务记录。该接口是任务入口；如果请求体提供 `summary`，服务器会把它作为候选摘要保存。否则只记录待处理 job，等待后续 LLM/人工摘要写入。

请求体：

```json
{
  "date": "2026-06-07",
  "summary": "可选摘要候选",
  "confidence": 0.6
}
```

字段说明：

- `date` 或 `target_date`: 可选；不传时使用服务器当天日期。传入时必须是 `YYYY-MM-DD`。
- 该 `run` 入口总是创建 `queued` 任务记录；请求体里的 `status` 不会控制任务状态。
- 如果提供 `summary`，服务器只把它作为 `daily_memory` 候选摘要保存，状态为 `candidate`。
- 底层 `memory_job_runs.status` 支持 `queued`、`running`、`completed`、`failed`、`skipped`；当前公开 `run` 接口只暴露创建入口，不暴露任务终态更新入口。

错误响应：

- `400 DAILY_SUMMARY_DATE_INVALID`: `date` 或 `target_date` 不是 `YYYY-MM-DD` 格式。

### `POST /api/jobs/weekly-profile/run`

创建每周画像学习任务记录。Server 只记录任务入口，不自行生成画像结论。

请求体：

```json
{
  "week_start": "2026-06-01"
}
```

字段说明：

- `week_start` 或 `target_date`: 可选；不传时使用服务器当天日期。传入时必须是 `YYYY-MM-DD`。

错误响应：

- `400 WEEKLY_PROFILE_DATE_INVALID`: `week_start` 或 `target_date` 不是 `YYYY-MM-DD` 格式。

### `GET /api/jobs/memory`

读取记忆相关任务记录。

查询参数：

- `job_name`: 可选，例如 `daily_summary` 或 `weekly_profile`，会 trim 首尾空白，最大 `80` 个字符。
- `target_date`: 可选，格式 `YYYY-MM-DD`。
- `limit`: 可选，默认 `50`，最大 `200`。

响应中的 `completed_at` 仅当任务状态为 `completed`、`failed` 或 `skipped` 时有值；`queued` 和 `running` 保持为空。

错误响应：

- `400 MEMORY_JOB_NAME_INVALID`: `job_name` 超过 `80` 个字符。
- `400 MEMORY_JOB_TARGET_DATE_INVALID`: `target_date` 不是 `YYYY-MM-DD` 格式。

## Agent 状态与未来接入接口

本节接口属于 P3 Server 侧基础设施。当前实现只做协议、API、数据库记录和命令队列，不修改 Dashboard 前端，不接入 CSI 固件，不实现 LCD 固件驱动，也不让 Server 替代 LLM 或 ESP 做风险决策。

### `POST /api/environment/profile`

写入或更新环境画像候选。环境画像结论必须来自 LLM 输出、明确设备摘要或人工确认；Server 只做保存。

请求体：

```json
{
  "profile_key": "room.night_noise_level",
  "profile_value": "夜间环境通常较安静",
  "device_id": "esp32-c5-001",
  "status": "candidate",
  "confidence": 0.6,
  "evidence": [
    {
      "source": "daily_memory",
      "id": 1
    }
  ],
  "source": "llm_environment_profile"
}
```

字段说明：

- `profile_key`: 环境画像键，必填，最大 `120` 个字符。
- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。

错误响应：

- `400 ENVIRONMENT_PROFILE_KEY_INVALID`: `profile_key` 超过 `120` 个字符。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。

### `GET /api/environment/profile`

读取环境画像候选。

查询参数：

- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `status`: 可选。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 PROFILE_STATUS_INVALID`: `status` 不是 `candidate`、`active`、`rejected` 或 `archived`。

### `POST /api/memory/experience`

写入经验记忆候选，用于记录某类情境下的处理经验。

请求体：

```json
{
  "title": "夜间降低音量",
  "situation": "用户在夜间要求降低音量",
  "action": "排队 voice.set_volume 命令",
  "outcome": "用户确认音量合适",
  "status": "candidate",
  "confidence": 0.5,
  "evidence": [
    {
      "turn_id": "turn_uuid"
    }
  ],
  "source": "llm_experience"
}
```

错误响应：

- `400`: 缺少 `title`。
- `400 EXPERIENCE_TITLE_INVALID`: `title` 超过 `200` 个字符。
- `400 EXPERIENCE_ID_INVALID`: `experience_id` 超过 `120` 个字符。
- `409 EXPERIENCE_ID_DUPLICATE`: 请求体指定的 `experience_id` 已存在。

### `GET /api/memory/experience`

读取经验记忆候选。

查询参数：

- `status`: 可选。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 MEMORY_STATUS_INVALID`: `status` 不是 `candidate`、`active`、`rejected` 或 `archived`。

### `POST /api/memory/relation`

写入关系记忆候选，用于记录用户、地点、设备或其他对象之间的关系。

请求体：

```json
{
  "subject": "用户",
  "predicate": "常使用",
  "object": "书房设备",
  "relation_type": "device",
  "status": "candidate",
  "confidence": 0.5,
  "evidence": [
    {
      "turn_id": "turn_uuid"
    }
  ],
  "source": "llm_relation"
}
```

错误响应：

- `400`: 缺少 `subject`、`predicate` 或 `object`。
- `400 RELATION_SUBJECT_INVALID`: `subject` 超过 `200` 个字符。
- `400 RELATION_PREDICATE_INVALID`: `predicate` 超过 `120` 个字符。
- `400 RELATION_OBJECT_INVALID`: `object` 超过 `200` 个字符。
- `400 RELATION_ID_INVALID`: `relation_id` 超过 `120` 个字符。
- `400 RELATION_TYPE_INVALID`: `relation_type` 超过 `80` 个字符。
- `409 RELATION_ID_DUPLICATE`: 请求体指定的 `relation_id` 已存在。

### `GET /api/memory/relation`

读取关系记忆候选。

查询参数：

- `status`: 可选。
- `relation_type`: 可选，会 trim 首尾空白，最大 `80` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 MEMORY_STATUS_INVALID`: `status` 不是 `candidate`、`active`、`rejected` 或 `archived`。
- `400 RELATION_TYPE_INVALID`: `relation_type` 超过 `80` 个字符。

### `POST /api/reminders/rules`

创建提醒规则记录。该接口只保存规则，不代表提醒调度器或前端 UI 已接入。

请求体：

```json
{
  "title": "开窗提醒",
  "message": "二氧化碳偏高时提醒用户通风",
  "rule": {
    "type": "sensor_threshold",
    "field": "co2",
    "gt": 1200
  },
  "channel": "voice",
  "status": "active",
  "next_run_at": "2026-06-07T21:00:00.000Z",
  "source": "api"
}
```

字段说明：

- `title`: 必填，最大 `200` 个字符。
- `message`: 必填，最大 `1000` 个字符。
- `channel`: 可选，默认 `voice`，最大 `40` 个字符。
- `next_run_at`: 可选，最大 `80` 个字符。
- `suppress_until`: 可选，最大 `80` 个字符。

错误响应：

- `400`: 缺少 `title` 或 `message`。
- `400 REMINDER_ID_INVALID`: `reminder_id` 超过 `120` 个字符。
- `400 REMINDER_TITLE_INVALID`: `title` 超过 `200` 个字符。
- `400 REMINDER_MESSAGE_INVALID`: `message` 超过 `1000` 个字符。
- `400 REMINDER_CHANNEL_INVALID`: `channel` 超过 `40` 个字符。
- `400 REMINDER_NEXT_RUN_AT_INVALID`: `next_run_at` 超过 `80` 个字符。
- `400 REMINDER_SUPPRESS_UNTIL_INVALID`: `suppress_until` 超过 `80` 个字符。
- `409 REMINDER_ID_DUPLICATE`: 请求体指定的 `reminder_id` 已存在。

### `GET /api/reminders/rules`

读取提醒规则。

查询参数：

- `status`: 可选。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 REMINDER_RULE_STATUS_INVALID`: `status` 不是 `active`、`paused` 或 `archived`。

### `POST /api/reminders/events`

创建提醒事件记录，用于后端任务或未来设备端消费。

请求体：

```json
{
  "reminder_id": "reminder_uuid",
  "message": "该通风了",
  "status": "pending",
  "due_at": "2026-06-07T21:00:00.000Z",
  "action": {
    "command": "alert.play_tone"
  }
}
```

字段说明：

- `reminder_id`: 可选，关联的提醒规则 ID，最大 `120` 个字符。
- `message`: 必填，最大 `1000` 个字符。
- `due_at`: 可选，最大 `80` 个字符。
- `status`: 可为 `pending`、`triggered`、`confirmed`、`canceled`、`suppressed`；非法值会按 `pending` 写入。
- `completed_at`: 仅当状态为 `confirmed` 或 `canceled` 时写入；其他状态保持为空。

错误响应：

- `400`: 缺少 `message`。
- `400 REMINDER_ID_INVALID`: `reminder_id` 超过 `120` 个字符。
- `400 REMINDER_EVENT_MESSAGE_INVALID`: `message` 超过 `1000` 个字符。
- `400 REMINDER_DUE_AT_INVALID`: `due_at` 超过 `80` 个字符。
- `400 REMINDER_EVENT_ID_INVALID`: `reminder_event_id` 超过 `120` 个字符。
- `409 REMINDER_EVENT_ID_DUPLICATE`: 请求体指定的 `reminder_event_id` 已存在。

### `GET /api/reminders/events`

读取提醒事件。

查询参数：

- `status`: 可选。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 REMINDER_EVENT_STATUS_INVALID`: `status` 不是 `pending`、`triggered`、`confirmed`、`canceled` 或 `suppressed`。

### `POST /api/emergency/events`

ESP 上报紧急事件。Server 只校验、记录、转发所需数据，不做风险判断，不替代 ESP 本地快速动作，也不替代 LLM 深度决策。

请求体：

```json
{
  "device_id": "esp32-c5-001",
  "event_type": "fall_detected",
  "severity": "critical",
  "local_action": "played_local_alarm",
  "payload": {
    "source": "esp_local_rule"
  },
  "llm_decision": null,
  "status": "received"
}
```

字段说明：

- `event_id`: 可选；如果不传，Server 自动生成。客户端指定的 `event_id` 必须唯一，最大 `120` 个字符。
- `event_type`: 必填，最大 `120` 个字符。
- `local_action`: 可选，ESP 本地动作审计文本，最大 `500` 个字符。
- `severity`: 可为 `info`、`warning`、`critical`；非法值会按 `info` 写入。
- `status`: 可为 `received`、`llm_pending`、`forwarded`、`resolved`、`archived`；非法值会按 `received` 写入。
- `resolved_at`: 仅当状态为 `resolved` 时写入；未解决事件保持为空。

错误响应：

- `400`: 缺少 `event_type`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 EMERGENCY_EVENT_TYPE_INVALID`: `event_type` 超过 `120` 个字符。
- `400 EMERGENCY_LOCAL_ACTION_INVALID`: `local_action` 超过 `500` 个字符。
- `400 EMERGENCY_EVENT_ID_INVALID`: `event_id` 超过 `120` 个字符。
- `409 EMERGENCY_EVENT_ID_DUPLICATE`: 请求体指定的 `event_id` 已存在。

### `GET /api/emergency/events`

读取紧急事件记录。

查询参数：

- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `status`: 可选。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 EMERGENCY_STATUS_INVALID`: `status` 不是 `received`、`llm_pending`、`forwarded`、`resolved` 或 `archived`。

### `POST /api/csi/behavior`

预留 CSI 行为事件上传协议。当前只接收行为特征和摘要，不接收原始 CSI 数据，不修改 CSI 固件。

请求体：

```json
{
  "device_id": "csi-node-001",
  "behavior_type": "presence",
  "confidence": 0.72,
  "features": {
    "motion_score": 0.82
  },
  "summary": "检测到有人在房间内活动",
  "occurred_at": "2026-06-07T21:00:00.000Z"
}
```

字段说明：

- `summary`: 可选，行为摘要，最大 `1000` 个字符。
- `occurred_at`: 可选，最大 `80` 个字符。

错误响应：

- `400`: 缺少 `behavior_type`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 CSI_BEHAVIOR_TYPE_INVALID`: `behavior_type` 超过 `120` 个字符。
- `400 CSI_SUMMARY_INVALID`: `summary` 超过 `1000` 个字符。
- `400 CSI_OCCURRED_AT_INVALID`: `occurred_at` 超过 `80` 个字符。
- `400 CSI_EVENT_ID_INVALID`: `event_id` 超过 `120` 个字符。
- `409 CSI_EVENT_ID_DUPLICATE`: 请求体指定的 `event_id` 已存在。

### `GET /api/csi/behavior`

读取 CSI 行为事件。

查询参数：

- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `behavior_type`: 可选，会 trim 首尾空白，最大 `120` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 CSI_BEHAVIOR_TYPE_INVALID`: `behavior_type` 超过 `120` 个字符。

### `POST /api/lcd/status`

预留 LCD 状态上报协议。当前只保存 Server 侧状态，不修改 LCD 固件，不修改 Dashboard。

请求体：

```json
{
  "device_id": "esp32-c5-001",
  "page": "idle",
  "state": {
    "voice": "idle",
    "sensor": "ok"
  },
  "last_command_id": "可选"
}
```

字段说明：

- `device_id`: 必填，会 trim 首尾空白，最大 `128` 个字符。
- `page`: 可选，默认 `idle`，最大 `80` 个字符。
- `last_command_id`: 可选，最大 `120` 个字符。

错误响应：

- `400`: 缺少 `device_id`。
- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。
- `400 LCD_PAGE_INVALID`: `page` 超过 `80` 个字符。
- `400 LCD_LAST_COMMAND_ID_INVALID`: `last_command_id` 超过 `120` 个字符。

### `GET /api/lcd/status`

读取 LCD 状态记录。

查询参数：

- `device_id`: 可选，会 trim 首尾空白，最大 `128` 个字符。
- `limit`: 可选，默认 `50`，最大 `200`。

错误响应：

- `400 DEVICE_ID_INVALID`: `device_id` 超过 `128` 个字符。

### `POST /api/lcd/display`

创建一条 `display.show_text` 命令并更新 Server 侧 LCD 状态。目标设备必须先通过 `POST /api/devices/capabilities` 注册 `display.show_text` 能力。`ttl_ms` 可选，未提供时 Server 会按固件默认值归一为 `5000`。

请求体：

```json
{
  "device_id": "esp32-c5-001",
  "text": "你好",
  "ttl_ms": 5000
}
```

错误响应复用命令队列错误格式：

- `400 COMMAND_TARGET_REQUIRED`: 缺少 `device_id`。
- `400 DEVICE_CAPABILITIES_REQUIRED`: 目标设备尚未注册能力。
- `400 DEVICE_COMMAND_UNSUPPORTED`: 目标设备未声明支持 `display.show_text`。
- `400 COMMAND_PAYLOAD_INVALID`: 缺少 `text`、`text` 超过 `120` 个字符，或 `ttl_ms` 超出 `1000` 到 `60000`。

## 统一设备协议 v1 接口

### 通用 v1 envelope

新 ESP 主链路使用 JSON envelope v1。`device_id` 表示整机，`sensor_id` 或 `module_id` 放在 `payload` 内。`server_recv_ms`、`server_time_iso`、`upload_delay_ms` 只由服务器生成或计算，客户端上传的同名字段会被忽略。

```json
{
  "schema_version": 1,
  "device_id": "esp32-c5-whole-001",
  "device_type": "esp32c5_env_voice_node",
  "firmware_version": "0.1.0",
  "request_seq": 123,
  "esp_uptime_ms": 12345678,
  "esp_time_ms": 1780732142207,
  "time_synced": true,
  "payload_type": "sensor.bme690",
  "payload": {}
}
```

`time_synced=false` 时，`esp_time_ms` 应省略或为 `null`，不要用 `0` 伪装真实 Unix 时间。只有 `time_synced=true` 且 `esp_time_ms` 有效、延迟在 `0..60000ms` 的样本才进入 `latest_upload_delay_ms`、`avg_upload_delay_ms` 和 `delay_sample_count`。

### `POST /api/device/v1/ingest`

统一设备协议 v1 ingest 入口。当前已接入 `payload_type=sensor.bme690`。

请求体：

```json
{
  "schema_version": 1,
  "device_id": "esp32-c5-whole-001",
  "device_type": "esp32c5_env_voice_node",
  "firmware_version": "0.1.0",
  "request_seq": 123,
  "esp_uptime_ms": 12345678,
  "esp_time_ms": 1780732142207,
  "time_synced": true,
  "payload_type": "sensor.bme690",
  "payload": {
    "sensor_id": "bme690_01",
    "temperature_c": 29.57,
    "humidity_percent": 30.29,
    "pressure_hpa": 986.26,
    "gas_resistance_ohm": 35164,
    "air_quality_score": 72,
    "air_quality_level": "moderate",
    "air_quality_confidence": "low",
    "air_quality_algo_version": "esp-bme690-relative-v1",
    "air_quality_source": "esp",
    "gas_baseline_ohm": 82000,
    "gas_ratio": 0.43,
    "gas_score": 43,
    "humidity_score": 87,
    "baseline_ready": false,
    "warmup_done": false,
    "sample_count": 12
  }
}
```

成功响应：

```json
{
  "ok": true,
  "server_recv_ms": 1780732144669,
  "server_time_iso": "2026-06-09T20:10:44.669Z",
  "request_id": "",
  "error": null,
  "data": {
    "id": 1,
    "device_id": "esp32-c5-whole-001",
    "sensor_id": "bme690_01",
    "payload_type": "sensor.bme690",
    "server_recv_ms": 1780732144669,
    "server_time_iso": "2026-06-09T20:10:44.669Z",
    "upload_delay_ms": 2462,
    "air_quality": {
      "air_quality_score": 72,
      "air_quality_level": "moderate",
      "air_quality_confidence": "low",
      "air_quality_source": "esp"
    }
  }
}
```

失败响应：

```json
{
  "ok": false,
  "server_recv_ms": 1780732144669,
  "server_time_iso": "2026-06-09T20:10:44.669Z",
  "request_id": "",
  "data": null,
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "temperature_c is required"
  }
}
```

错误码：

- `UNSUPPORTED_PAYLOAD_TYPE`: 当前只接受 `sensor.bme690`。
- `INVALID_PAYLOAD`: envelope 或 BME690 必填字段缺失/非法。
- `DEVICE_INGEST_FAILED`: 服务器处理失败。

服务器会把 `payload.temperature_c`、`humidity_percent`、`pressure_hpa`、`gas_resistance_ohm` 映射到旧 `sensor_records.temperature`、`humidity`、`pressure`、`gas_resistance`，同时保存 `metadata_json`、`raw_json`、`air_quality_json` 和空气状态拆分列。

空气状态字段是 ESP 本地基于 BME690 的相对空气状态估算，不是国标 AQI，不代表 PM2.5、PM10 或 CO2。服务器只接收、校验、入库、fallback 和用于 context，不做风险判断或紧急决策。

### `GET /api/device/v1/status`

读取整机状态。`device_id` 可选；为空时返回最近一个设备状态。

```json
{
  "ok": true,
  "status": {
    "device_id": "esp32-c5-whole-001",
    "online": true,
    "device_online": true,
    "last_seen_ms": 1780732144669,
    "last_seen_iso": "2026-06-09T20:10:44.669Z",
    "last_seen_age_ms": 1200,
    "last_payload_type": "sensor.bme690",
    "last_module_type": "sensor.bme690",
    "time_synced": true,
    "latest_upload_delay_ms": 2462,
    "avg_upload_delay_ms": 1800,
    "delay_sample_count": 3,
    "reboot_count": 0
  },
  "server_time_ms": 1780732145869
}
```

### `GET /api/device/v1/modules/status`

读取模块状态。`device_id` 可选；为空时返回已知模块状态。

```json
{
  "ok": true,
  "modules": [
    {
      "device_id": "esp32-c5-whole-001",
      "module_type": "sensor.bme690",
      "online": true,
      "module_online": true,
      "last_seen_age_ms": 1200,
      "latest_upload_delay_ms": 2462,
      "avg_upload_delay_ms": 1800,
      "delay_sample_count": 3
    }
  ],
  "server_time_ms": 1780732145869
}
```

BME 模块离线不等于整机离线；整机在线由 `device_status` 判断，模块在线由 `device_module_status` 判断。

### `GET /api/device/v1/context`

读取 `deviceContextService` 输出，供 LLM prompt、调试和后续前端迁移使用。该接口不调用 LLM。

```json
{
  "ok": true,
  "context": {
    "device": {
      "device_id": "esp32-c5-whole-001",
      "online": true,
      "avg_upload_delay_ms": 1800
    },
    "modules": {
      "sensor.bme690": {
        "available": true,
        "online": true
      },
      "csi.motion": {
        "available": false,
        "online": false
      },
      "lcd.status": {
        "available": false,
        "online": false
      }
    },
    "environment": {
      "available": true,
      "fresh": true,
      "temperature_c": 29.57,
      "humidity_percent": 30.29,
      "pressure_hpa": 986.26,
      "gas_resistance_ohm": 35164
    },
    "air_quality": {
      "available": true,
      "score": 72,
      "level": "moderate",
      "confidence": "low",
      "source": "esp",
      "note": "ESP local BME690 relative estimate, not national AQI, PM2.5, PM10, or CO2."
    }
  },
  "server_time_ms": 1780732145869
}
```

### `GET /api/device/v1/sensors/latest`

读取最新 BME690 传感器记录，返回 v1 字段、legacy 映射字段、metadata、raw_json 和空气状态。

```json
{
  "ok": true,
  "sensor": {
    "id": 1,
    "temperature": 29.57,
    "humidity": 30.29,
    "pressure": 986.26,
    "gas_resistance": 35164,
    "device_id": "esp32-c5-whole-001",
    "payload_type": "sensor.bme690",
    "sensor_id": "bme690_01",
    "upload_delay_ms": 2462,
    "metadata": {},
    "raw_json": {},
    "air_quality": {
      "air_quality_score": 72,
      "air_quality_level": "moderate",
      "air_quality_confidence": "low",
      "air_quality_source": "esp"
    }
  },
  "server_time_ms": 1780732145869
}
```

### v1 数据库迁移概要

启动时会可重复创建或补齐：

- `sensor_records`: legacy 传感器列继续保留，新增 `schema_version`、`device_type`、`firmware_version`、`request_seq`、`time_synced`、`payload_type`、`sensor_id`、`metadata_json`、`raw_json`、`air_quality_json`、`air_quality_score`、`air_quality_level`、`air_quality_confidence`、`air_quality_algo_version`、`air_quality_source`、`gas_baseline_ohm`、`gas_ratio`、`gas_score`、`humidity_score`。
- `device_status`: `device_id` 唯一，保存整机最后通信、最后 payload/module、ESP 时间、时间同步、重启计数、最新/平均延迟和样本数。
- `device_module_status`: `(device_id,module_type)` 唯一，保存模块最后通信、ESP 时间、时间同步、最新/平均延迟和样本数。
- 索引：`idx_sensor_records_device_recv_ms`、`idx_sensor_records_recv_ms`、`idx_sensor_records_payload_type_recv_ms`、`idx_device_status_device_id_unique`、`idx_device_module_status_device_module_unique`、`idx_device_status_last_seen`、`idx_device_module_status_last_seen`。

## Legacy 传感器兼容接口

### `POST /sensor`

ESP 旧设备和旧脚本上传扁平传感器数据的 legacy 写入入口。新 `Whole-project` BME690 主链路已经改为 `POST /api/device/v1/ingest`，不要把新 BME 链路切回该接口。
服务器启动迁移会在干净 SQLite 库中自动创建 `sensor_records` 基础表，再补齐时间同步列；不会要求已有数据库先手工建表。

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
- 传感器数值字段会转为有限数字；无法转换的值会按 `null` 保存。
- `device_id`: 设备 ID，可为空；服务器会 trim，最多保存 `128` 个字符。
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

前端兼容读取最新一条传感器数据。没有数据时返回空对象 `{}`。该接口保留旧字段，并追加 v1 状态、平均延迟和空气状态字段，供旧 Dashboard 不改代码继续运行。

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
  "online": true,
  "device_online": true,
  "sensor_online": true,
  "latest_upload_delay_ms": 100,
  "avg_upload_delay_ms": 96,
  "delay_sample_count": 5,
  "air_quality_score": 72,
  "air_quality_level": "moderate",
  "air_quality_confidence": "low",
  "air_quality_source": "esp",
  "air_quality": {
    "air_quality_score": 72,
    "air_quality_level": "moderate",
    "air_quality_confidence": "low",
    "air_quality_source": "esp"
  },
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
`device_id` 会 trim 首尾空白，最多保留 `128` 个字符；`esp_send_ms` 或 `esp_uptime_ms` 无法转换为有限数字时按 `null` 返回。

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
服务器启动迁移会在干净 SQLite 库中自动创建 `asr_records` 与 `llm_records`，保证旧记录接口在空库环境下也能返回 `{}` 或正常写入。

### `POST /asr`

写入 ASR 文本。
`text` 会 trim 首尾空白，最多保存 `4000` 个字符。

```json
{
  "text": "识别文本"
}
```

成功响应保留旧 `success` 字段，并额外包含 `ok=true` 方便机器客户端统一判断：

```json
{
  "ok": true,
  "success": true,
  "id": 1
}
```

### `POST /llm`

写入 LLM 请求和响应。
`prompt` 和 `response` 会 trim 首尾空白，最多各保存 `4000` 个字符。

```json
{
  "prompt": "用户问题",
  "response": "模型回复"
}
```

成功响应保留旧 `success` 字段，并额外包含 `ok=true`：

```json
{
  "ok": true,
  "success": true,
  "id": 1
}
```
