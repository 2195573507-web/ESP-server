"use strict";

const express = require("express");
const { createVoiceSessionStore } = require("../services/voiceSessionStore");
const { runMockVoiceTurn } = require("../services/voicePipeline");
const {
    DEFAULT_PCM_CONTENT_TYPE,
    maskLogValue,
    readPrepareRequest,
    readTurnHeaders,
    toPublicSession,
    writePcmHeaders
} = require("../helpers/voiceHttp");

const DEFAULT_RAW_LIMIT = "2mb";

function readPositiveInteger(value, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }

    return numeric;
}

function createVoiceRouter(options = {}) {
    const router = express.Router();
    const logger = options.logger || console;
    const store = options.store || createVoiceSessionStore({
        maxConcurrent: readPositiveInteger(process.env.VOICE_MAX_CONCURRENT, 2),
        turnTtlMs: readPositiveInteger(process.env.VOICE_TURN_TTL_MS, 120000),
        retainDoneMs: readPositiveInteger(process.env.VOICE_RETAIN_DONE_MS, 300000)
    });

    router.post("/prepare", (req, res) => {
        const prepareRequest = readPrepareRequest(req.body);
        if (prepareRequest.error) {
            return res.status(400).json({
                ok: false,
                error: prepareRequest.error
            });
        }

        const result = store.prepare(prepareRequest);
        if (!result.ok) {
            logger.warn(
                `[voice] prepare rejected code=${result.code} device_id=${maskLogValue(prepareRequest.deviceId)}`
            );

            return res.status(result.status).json({
                ok: false,
                error: result.code,
                status: result.session?.status || "busy",
                turn_id: result.session?.turnId || ""
            });
        }

        logger.log(
            `[voice] prepare ok turn_id=${result.session.turnId} device_id=${maskLogValue(result.session.deviceId)}`
        );

        return res.json({
            ok: true,
            turn_id: result.session.turnId,
            status: result.session.status,
            expires_at_ms: result.session.expiresAtMs
        });
    });

    router.get("/status/:turn_id", (req, res) => {
        const session = store.get(req.params.turn_id);
        if (!session) {
            return res.status(404).json({
                ok: false,
                error: "VOICE_TURN_NOT_FOUND"
            });
        }

        return res.json(toPublicSession(session));
    });

    router.post(
        "/turn",
        express.raw({
            type: ["audio/*", "application/octet-stream"],
            limit: process.env.VOICE_PCM_UPLOAD_LIMIT || DEFAULT_RAW_LIMIT
        }),
        async (req, res) => {
            const turnHeaders = readTurnHeaders(req);
            if (turnHeaders.error) {
                return res.status(400).json({
                    ok: false,
                    error: turnHeaders.error
                });
            }

            const beginResult = store.beginTurn(turnHeaders);
            if (!beginResult.ok) {
                logger.warn(
                    `[voice] turn rejected code=${beginResult.code} device_id=${maskLogValue(turnHeaders.deviceId)} turn_id=${turnHeaders.turnId || "-"}`
                );

                return res.status(beginResult.status).json({
                    ok: false,
                    error: beginResult.code,
                    status: beginResult.session?.status || "busy",
                    turn_id: beginResult.session?.turnId || turnHeaders.turnId || ""
                });
            }

            const session = beginResult.session;
            const pcmBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            let closedByClient = false;

            res.on("close", () => {
                if (!res.writableEnded) {
                    closedByClient = true;
                    store.finish(session.turnId, "aborted", "client disconnected");
                    logger.warn(`[voice] turn aborted turn_id=${session.turnId}`);
                }
            });

            logger.log(
                `[voice] turn begin turn_id=${session.turnId} device_id=${maskLogValue(session.deviceId)} content_type=${turnHeaders.contentType || "-"} pcm_in_bytes=${pcmBuffer.length}`
            );

            try {
                writePcmHeaders(res, DEFAULT_PCM_CONTENT_TYPE);
                await runMockVoiceTurn({
                    res,
                    pcmBuffer,
                    session,
                    store,
                    logger
                });

                if (!closedByClient) {
                    store.finish(session.turnId, "completed");
                    res.end();
                    const latestSession = store.get(session.turnId);
                    logger.log(
                        `[voice] turn end turn_id=${session.turnId} pcm_in_bytes=${latestSession?.pcmInBytes ?? pcmBuffer.length} pcm_out_bytes=${latestSession?.pcmOutBytes ?? 0}`
                    );
                }
            } catch (error) {
                store.finish(session.turnId, "failed", error.message || "voice turn failed");
                logger.error(
                    `[voice] turn failed turn_id=${session.turnId} name=${error.name || "Error"} message=${error.message || "-"}`
                );

                if (!res.headersSent) {
                    return res.status(500).json({
                        ok: false,
                        error: "VOICE_TURN_FAILED"
                    });
                }

                res.destroy(error);
            }
        }
    );

    return router;
}

module.exports = {
    createVoiceRouter
};
