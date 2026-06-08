const express = require("express");
const {
    ackCommand,
    enqueueCommand,
    getDeviceCapabilities,
    listCommandHistory,
    listPendingCommands,
    upsertDeviceCapabilities
} = require("../commands/queue");
const {
    COMMAND_DEVICE_ID_MAX_LENGTH,
    listCommandDefinitions
} = require("../commands/schema");

function readRouteDeviceId(value) {
    return typeof value === "string" ? value.trim() : "";
}

function sendDeviceIdError(res, code, error) {
    return res.status(400).json({
        ok: false,
        code,
        error
    });
}

function validateRouteDeviceId(res, value) {
    const deviceId = readRouteDeviceId(value);
    if (!deviceId) {
        sendDeviceIdError(res, "DEVICE_ID_REQUIRED", "device_id is required");
        return "";
    }

    if (deviceId.length > COMMAND_DEVICE_ID_MAX_LENGTH) {
        sendDeviceIdError(res, "DEVICE_ID_INVALID", `device_id must be <= ${COMMAND_DEVICE_ID_MAX_LENGTH} characters`);
        return "";
    }

    return deviceId;
}

function validateOptionalRouteDeviceId(res, value) {
    const deviceId = readRouteDeviceId(value);
    if (!deviceId) {
        return "";
    }

    if (deviceId.length > COMMAND_DEVICE_ID_MAX_LENGTH) {
        sendDeviceIdError(res, "DEVICE_ID_INVALID", `device_id must be <= ${COMMAND_DEVICE_ID_MAX_LENGTH} characters`);
        return null;
    }

    return deviceId;
}

function createCommandRouter(options) {
    const router = express.Router();
    const dbRun = options.dbRun;
    const dbAll = options.dbAll;

    router.get("/api/commands/whitelist", (req, res) => {
        res.json({
            ok: true,
            commands: listCommandDefinitions()
        });
    });

    router.post("/api/devices/capabilities", async (req, res) => {
        const result = await upsertDeviceCapabilities(dbRun, req.body);
        if (!result.ok) {
            return res.status(400).json(result);
        }

        return res.json(result);
    });

    router.get("/api/devices/:device_id/capabilities", async (req, res) => {
        const deviceId = validateRouteDeviceId(res, req.params.device_id);
        if (!deviceId) {
            return;
        }

        const snapshot = await getDeviceCapabilities(dbAll, deviceId);
        if (!snapshot) {
            return res.status(404).json({
                ok: false,
                error: "device capabilities not found"
            });
        }

        return res.json({
            ok: true,
            ...snapshot
        });
    });

    router.post("/api/commands", async (req, res) => {
        const result = await enqueueCommand(dbRun, dbAll, req.body, {
            source: "api",
            requestedBy: "server"
        });
        if (!result.ok) {
            return res.status(400).json(result);
        }

        return res.status(201).json({
            ok: true,
            command: result.command
        });
    });

    router.get("/api/commands/pending", async (req, res) => {
        const deviceId = validateRouteDeviceId(res, req.query.device_id);
        if (!deviceId) {
            return;
        }

        const commands = await listPendingCommands(dbRun, dbAll, deviceId, req.query.limit);
        return res.json({
            ok: true,
            commands,
            server_time_ms: Date.now()
        });
    });

    router.post("/api/commands/:command_id/ack", async (req, res) => {
        const result = await ackCommand(dbRun, req.params.command_id, req.body);
        if (!result.ok) {
            if (result.code === "COMMAND_ACK_STATUS_INVALID") {
                return res.status(400).json(result);
            }

            return res.status(404).json(result);
        }

        return res.json(result);
    });

    router.get("/api/commands/history", async (req, res) => {
        const deviceId = validateOptionalRouteDeviceId(res, req.query.device_id);
        if (deviceId === null) {
            return;
        }

        const history = await listCommandHistory(dbAll, {
            device_id: deviceId,
            limit: req.query.limit
        });

        return res.json({
            ok: true,
            commands: history
        });
    });

    return router;
}

module.exports = {
    createCommandRouter
};
