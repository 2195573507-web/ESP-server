"use strict";

const DEFAULT_MOCK_PCM_MS = 320;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BYTES_PER_SAMPLE = 2;
const DEFAULT_CHUNK_BYTES = 640;

function readPositiveInteger(value, fallback) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }

    return numeric;
}

function createMockPcm(options = {}) {
    const sampleRate = readPositiveInteger(options.sampleRate, DEFAULT_SAMPLE_RATE);
    const channels = readPositiveInteger(options.channels, DEFAULT_CHANNELS);
    const bytesPerSample = readPositiveInteger(
        options.bytesPerSample,
        DEFAULT_BYTES_PER_SAMPLE
    );
    const durationMs = readPositiveInteger(options.durationMs, DEFAULT_MOCK_PCM_MS);
    const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
    const buffer = Buffer.alloc(sampleCount * channels * bytesPerSample);

    for (let i = 0; i < sampleCount; i += 1) {
        const envelope = Math.sin((Math.PI * i) / Math.max(sampleCount - 1, 1));
        const tone = Math.sin((2 * Math.PI * 660 * i) / sampleRate);
        const sample = Math.round(tone * envelope * 6000);

        for (let channel = 0; channel < channels; channel += 1) {
            const offset = (i * channels + channel) * bytesPerSample;
            buffer.writeInt16LE(sample, offset);
        }
    }

    return buffer;
}

function waitImmediate() {
    return new Promise(resolve => setImmediate(resolve));
}

async function writeBufferInChunks(res, buffer, callbacks = {}) {
    const chunkBytes = readPositiveInteger(callbacks.chunkBytes, DEFAULT_CHUNK_BYTES);
    let offset = 0;

    while (offset < buffer.length) {
        const end = Math.min(offset + chunkBytes, buffer.length);
        const chunk = buffer.subarray(offset, end);
        const canContinue = res.write(chunk);

        if (typeof callbacks.onChunk === "function") {
            callbacks.onChunk(chunk.length);
        }

        if (!canContinue) {
            await new Promise(resolve => res.once("drain", resolve));
        } else {
            await waitImmediate();
        }

        offset = end;
    }
}

async function runMockVoiceTurn({ res, pcmBuffer, session, store, logger = console }) {
    const inputBytes = Buffer.isBuffer(pcmBuffer) ? pcmBuffer.length : 0;
    store.markProcessing(session.turnId, inputBytes);

    logger.log(
        `[voice] mock pipeline turn_id=${session.turnId} pcm_in_bytes=${inputBytes}`
    );

    const mockPcm = createMockPcm();
    store.markStreaming(session.turnId);
    await writeBufferInChunks(res, mockPcm, {
        onChunk: bytes => store.addOutputBytes(session.turnId, bytes)
    });

    return {
        pcmOutBytes: mockPcm.length
    };
}

module.exports = {
    createMockPcm,
    runMockVoiceTurn,
    writeBufferInChunks
};
