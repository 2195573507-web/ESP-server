const fs = require("fs");
const path = require("path");
const {
    buildAgentContext
} = require("./contextBuilder");
const {
    requestLlmChat
} = require("../llm/textClient");

const MAX_TOOL_ROUNDS = 3;
let cachedSystemPrompt = null;

function loadSystemPrompt() {
    if (cachedSystemPrompt !== null) {
        return cachedSystemPrompt;
    }
    const promptPath = path.join(__dirname, "..", "prompts", "esp-home-agent-system-prompt.txt");
    cachedSystemPrompt = fs.readFileSync(promptPath, "utf8").trim();
    if (!cachedSystemPrompt) {
        throw new Error("ESP Home Agent system prompt is empty");
    }
    return cachedSystemPrompt;
}

function toolMessage(toolCall, result) {
    return {
        role: "tool",
        tool_call_id: toolCall.id || toolCall.tool_call_id || toolCall.function?.name || "tool",
        content: JSON.stringify(result)
    };
}

async function runAgentConversation(options) {
    const systemPrompt = options.systemPrompt || loadSystemPrompt();
    const context = await buildAgentContext(options.dbAll, options.toolRegistry);
    const messages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: `Dynamic context (not real-time sensor data):\n${JSON.stringify(context)}` }
    ];
    if (options.additionalSystemPrompt) {
        messages.push({ role: "system", content: options.additionalSystemPrompt });
    }
    messages.push({ role: "user", content: options.userText });

    let lastModel = options.config.model;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const response = await requestLlmChat(messages, options.toolRegistry.openAiTools(), options.config);
        lastModel = response.model || lastModel;
        const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        if (toolCalls.length === 0) {
            return { text: response.text, model: lastModel, context, tool_rounds: round };
        }

        messages.push({
            role: "assistant",
            content: response.text || null,
            tool_calls: toolCalls
        });
        for (const toolCall of toolCalls) {
            const result = await options.toolRegistry.invoke(toolCall?.function?.name, toolCall?.function?.arguments, {
                dbAll: options.dbAll,
                deviceId: options.deviceId || "",
                logger: options.logger,
                weatherConfig: options.weatherConfig,
                fetcher: options.fetcher
            });
            messages.push(toolMessage(toolCall, result));
        }
    }

    return {
        text: "实时查询未在允许的工具调用次数内完成，无法提供可靠结果。",
        model: lastModel,
        context,
        tool_rounds: MAX_TOOL_ROUNDS
    };
}

module.exports = {
    MAX_TOOL_ROUNDS,
    loadSystemPrompt,
    runAgentConversation
};
