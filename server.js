require("dotenv").config();

const express = require("express");
const path = require("path");
const {
    createTimeSyncRouter
} = require("./server-time-sync/timeSync");
const {
    createDatabase,
    createDbHelpers
} = require("./src/db/sqlite");
const {
    ensureRecordTables
} = require("./src/db/records");
const {
    ensureSensorTimingColumns
} = require("./src/db/sensorRecords");
const {
    ensureCommandTables
} = require("./src/db/commands");
const {
    ensureAgentStateTables
} = require("./src/db/agentState");
const {
    ensureMemoryTables
} = require("./src/db/memory");
const {
    ensureVoiceTurnsTable
} = require("./src/db/voiceTurns");
const {
    createCommandRouter
} = require("./src/routes/commandRoutes");
const {
    createAgentStateRouter
} = require("./src/routes/agentStateRoutes");
const {
    createLlmTextRouter
} = require("./src/routes/llmTextRoutes");
const {
    createMemoryRouter
} = require("./src/routes/memoryRoutes");
const {
    createRecordRouter
} = require("./src/routes/recordRoutes");
const {
    createSensorRouter
} = require("./src/routes/sensorRoutes");
const {
    createStructuredLlmRouter
} = require("./src/routes/structuredLlmRoutes");
const {
    createVoiceBodyParserErrorHandler,
    createVoiceRouter
} = require("./src/routes/voiceRoutes");

const app = express();

// 数据库连接
const db = createDatabase(__dirname);
const { dbRun, dbAll } = createDbHelpers(db);

app.use(createVoiceRouter({ dbRun }));
app.use(express.json());
app.use(createVoiceBodyParserErrorHandler({ dbRun }));
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({
            ok: false,
            error: "Invalid JSON body"
        });
    }

    return next(err);
});

// Static frontend routes. Backend work may read these routes but must not edit public/.
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(createLlmTextRouter({ dbRun }));
app.use(createStructuredLlmRouter({ dbRun, dbAll }));
app.use(createCommandRouter({ dbRun, dbAll }));
app.use(createMemoryRouter({ dbRun, dbAll }));
app.use(createAgentStateRouter({ dbRun, dbAll }));
app.use(createRecordRouter({ db }));
app.use(createSensorRouter({ db }));

// Health/debug API
app.use("/api/time", createTimeSyncRouter());

function isMachineApiPath(pathname) {
    return pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/sensor" ||
        pathname.startsWith("/sensor/") ||
        pathname === "/asr" ||
        pathname.startsWith("/asr/") ||
        pathname === "/llm" ||
        pathname.startsWith("/llm/");
}

app.use((req, res, next) => {
    if (!isMachineApiPath(req.path)) {
        return next();
    }

    return res.status(404).json({
        ok: false,
        error: "Not found"
    });
});

app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    console.error("[server] unhandled route error", err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 500;

    return res.status(status).json({
        ok: false,
        error: status >= 500 ? "Internal server error" : (err?.message || "Request failed")
    });
});

const PORT = process.env.PORT || 3000;
let httpServer = null;
let shuttingDown = false;

function closeDatabase() {
    return new Promise(resolve => {
        db.close(error => {
            if (error) {
                console.error("[server] failed to close database", error);
            }

            resolve();
        });
    });
}

function closeHttpServer() {
    return new Promise(resolve => {
        if (!httpServer) {
            resolve();
            return;
        }

        httpServer.close(error => {
            if (error) {
                console.error("[server] failed to close http server", error);
            }

            resolve();
        });
    });
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    console.log(`[server] shutting down signal=${signal}`);
    await closeHttpServer();
    await closeDatabase();
    process.exit(0);
}

async function startServer() {
    await ensureRecordTables(dbRun, dbAll);
    await ensureSensorTimingColumns(dbRun, dbAll);
    await ensureVoiceTurnsTable(dbRun, dbAll);
    await ensureCommandTables(dbRun, dbAll);
    await ensureMemoryTables(dbRun, dbAll);
    await ensureAgentStateTables(dbRun, dbAll);

    httpServer = app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(error => {
        console.error("[server] shutdown failed", error);
        process.exit(1);
    });
});

process.on("SIGINT", () => {
    shutdown("SIGINT").catch(error => {
        console.error("[server] shutdown failed", error);
        process.exit(1);
    });
});

startServer().catch(error => {
    console.error("[server] failed to start", error);
    process.exit(1);
});
