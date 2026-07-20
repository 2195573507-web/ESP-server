const {
    buildLocationLabel,
    readHomeLocation
} = require("../services/homeLocationService");
const {
    readPositiveInteger,
    readTrimmedEnv
} = require("../utils/env");

const DEFAULT_WEATHER_TIMEOUT_MS = 8000;
const DEFAULT_OPENWEATHER_BASE_URL = "https://api.openweathermap.org";

function readWeatherConfig(logger = console) {
    const apiKey = readTrimmedEnv("OPENWEATHER_API_KEY");
    const baseUrl = readTrimmedEnv("OPENWEATHER_BASE_URL", DEFAULT_OPENWEATHER_BASE_URL).replace(/\/+$/, "");
    const timeoutMs = readPositiveInteger(process.env.OPENWEATHER_TIMEOUT_MS, DEFAULT_WEATHER_TIMEOUT_MS);
    if (!apiKey) {
        logger.warn("[weather] OPENWEATHER_API_KEY is not configured; weather_query will fail closed");
    }

    return { apiKey, baseUrl, timeoutMs };
}

function parseWeatherLocation(location) {
    if (typeof location !== "string") {
        return "";
    }
    return location.trim().slice(0, 256);
}

function weatherError(error) {
    return { success: false, error };
}

async function fetchOpenWeather(url, config, fetcher = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetcher(url, { signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            return {
                ok: false,
                error: body?.message || `OpenWeather request failed (${response.status})`
            };
        }
        return { ok: true, body };
    } catch (error) {
        return {
            ok: false,
            error: error?.name === "AbortError" ? "OpenWeather request timed out" : "OpenWeather network request failed"
        };
    } finally {
        clearTimeout(timer);
    }
}

function buildOpenWeatherUrl(baseUrl, pathname, query) {
    const url = new URL(pathname, `${baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

function mapForecast(list) {
    return Array.isArray(list) ? list.slice(0, 8).map(item => ({
        time: item?.dt_txt || "",
        temperature: Number.isFinite(Number(item?.main?.temp)) ? Number(item.main.temp) : null,
        humidity: Number.isFinite(Number(item?.main?.humidity)) ? Number(item.main.humidity) : null,
        weather: item?.weather?.[0]?.description || "",
        wind_speed: Number.isFinite(Number(item?.wind?.speed)) ? Number(item.wind.speed) : null
    })) : [];
}

async function weatherQuery(args, context = {}) {
    const config = context.weatherConfig || readWeatherConfig(context.logger || console);
    if (!config.apiKey) {
        return weatherError("OpenWeather is not configured");
    }

    const requestedLocation = parseWeatherLocation(args?.location);
    if (args?.location !== undefined && !requestedLocation) {
        return weatherError("location must be a non-empty string when provided");
    }

    let homeLocation = null;
    let query;
    if (requestedLocation) {
        query = { q: requestedLocation, units: "metric", appid: config.apiKey };
    } else {
        homeLocation = await readHomeLocation(context.dbAll);
        if (homeLocation.latitude === null || homeLocation.longitude === null) {
            return weatherError("home location is not configured with latitude and longitude");
        }
        query = {
            lat: homeLocation.latitude,
            lon: homeLocation.longitude,
            units: "metric",
            appid: config.apiKey
        };
    }

    const currentResult = await fetchOpenWeather(
        buildOpenWeatherUrl(config.baseUrl, "/data/2.5/weather", query),
        config,
        context.fetcher
    );
    if (!currentResult.ok) {
        return weatherError(currentResult.error);
    }

    const current = currentResult.body;
    const forecastResult = await fetchOpenWeather(
        buildOpenWeatherUrl(config.baseUrl, "/data/2.5/forecast", {
            lat: current?.coord?.lat,
            lon: current?.coord?.lon,
            units: "metric",
            appid: config.apiKey
        }),
        config,
        context.fetcher
    );
    if (!forecastResult.ok) {
        return weatherError(forecastResult.error);
    }

    return {
        success: true,
        location: current?.name || requestedLocation || buildLocationLabel(homeLocation),
        temperature: Number.isFinite(Number(current?.main?.temp)) ? Number(current.main.temp) : null,
        humidity: Number.isFinite(Number(current?.main?.humidity)) ? Number(current.main.humidity) : null,
        weather: current?.weather?.[0]?.description || "",
        wind_speed: Number.isFinite(Number(current?.wind?.speed)) ? Number(current.wind.speed) : null,
        forecast: mapForecast(forecastResult.body?.list)
    };
}

module.exports = {
    DEFAULT_WEATHER_TIMEOUT_MS,
    readWeatherConfig,
    weatherQuery
};
