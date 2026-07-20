const {
    readHomeLocation
} = require("../services/homeLocationService");

function parseCapabilities(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

async function buildAgentContext(dbAll, toolRegistry) {
    const [homeLocation, capabilityRows] = await Promise.all([
        readHomeLocation(dbAll),
        dbAll("SELECT device_id,protocol_version,capabilities_json,last_seen_at FROM device_capabilities ORDER BY device_id ASC")
    ]);

    return {
        home_location: homeLocation,
        device_capabilities: capabilityRows.map(row => ({
            device_id: row.device_id,
            protocol_version: row.protocol_version || "",
            capabilities: parseCapabilities(row.capabilities_json),
            last_seen_at: row.last_seen_at || ""
        })),
        available_tools: toolRegistry.list().map(tool => ({
            name: tool.name,
            description: tool.description
        }))
    };
}

module.exports = {
    buildAgentContext
};
