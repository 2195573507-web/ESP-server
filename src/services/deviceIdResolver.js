const DEVICE_ID_MAX_LENGTH = 128;

const DEVICE_ID_ALIASES = Object.freeze({
    c51: "sensair_shuttle_01",
    c52: "sensair_shuttle_02",
    s3: "sensair_s3_gateway_01"
});

function normalizeDeviceId(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim().slice(0, DEVICE_ID_MAX_LENGTH);
}

function resolveDeviceId(value) {
    const normalized = normalizeDeviceId(value);
    if (!normalized) {
        return "";
    }

    return DEVICE_ID_ALIASES[normalized.toLowerCase()] || normalized;
}

module.exports = {
    DEVICE_ID_ALIASES,
    DEVICE_ID_MAX_LENGTH,
    normalizeDeviceId,
    resolveDeviceId
};
