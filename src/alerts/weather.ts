/**
 * Weather integration via OpenWeatherMap API.
 * Caches responses for 30 minutes. Gracefully returns null
 * when the API key is not configured.
 */

const API_KEY = process.env.OPENWEATHER_API_KEY ?? "";
const STORE_LAT = process.env.STORE_LAT ?? "32.9126";
const STORE_LON = process.env.STORE_LON ?? "-96.6389";
const BASE_URL = "https://api.openweathermap.org/data/2.5";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---- Types ----

export interface CurrentWeather {
  temp: number;
  condition: string;
  description: string;
  humidity: number;
  windSpeed: number;
}

export interface ForecastDay {
  date: string;
  tempHigh: number;
  tempLow: number;
  condition: string;
  rain: number;
}

// ---- Cache ----

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

let currentCache: CacheEntry<CurrentWeather> | null = null;
let forecastCache: CacheEntry<ForecastDay[]> | null = null;

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ---- API calls ----

/**
 * Fetch current weather conditions.
 * Returns null if API key is not set or fetch fails.
 */
export async function getCurrentWeather(): Promise<CurrentWeather | null> {
  if (!API_KEY) return null;
  if (isFresh(currentCache)) return currentCache.data;

  try {
    const url = `${BASE_URL}/weather?lat=${STORE_LAT}&lon=${STORE_LON}&appid=${API_KEY}&units=imperial`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[Weather] Current weather request failed: HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      main?: { temp?: number; humidity?: number };
      weather?: Array<{ main?: string; description?: string }>;
      wind?: { speed?: number };
    };

    const result: CurrentWeather = {
      temp: Math.round(json.main?.temp ?? 0),
      condition: json.weather?.[0]?.main ?? "Unknown",
      description: json.weather?.[0]?.description ?? "unknown",
      humidity: json.main?.humidity ?? 0,
      windSpeed: Math.round(json.wind?.speed ?? 0),
    };

    currentCache = { data: result, timestamp: Date.now() };
    return result;
  } catch (err) {
    console.log("[Weather] Current weather fetch failed:", (err as Error).message);
    return null;
  }
}

/**
 * Fetch 5 day forecast, aggregated by day.
 * Returns null if API key is not set or fetch fails.
 */
export async function getForecast(): Promise<ForecastDay[] | null> {
  if (!API_KEY) return null;
  if (isFresh(forecastCache)) return forecastCache.data;

  try {
    const url = `${BASE_URL}/forecast?lat=${STORE_LAT}&lon=${STORE_LON}&appid=${API_KEY}&units=imperial`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[Weather] Forecast request failed: HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      list?: Array<{
        dt_txt?: string;
        main?: { temp_max?: number; temp_min?: number };
        weather?: Array<{ main?: string }>;
        rain?: { "3h"?: number };
      }>;
    };

    if (!json.list) return null;

    // Aggregate by date
    const byDate = new Map<string, {
      highs: number[];
      lows: number[];
      conditions: string[];
      rain: number;
    }>();

    for (const entry of json.list) {
      const date = (entry.dt_txt ?? "").split(" ")[0];
      if (!date) continue;

      const bucket = byDate.get(date) ?? { highs: [], lows: [], conditions: [], rain: 0 };
      bucket.highs.push(entry.main?.temp_max ?? 0);
      bucket.lows.push(entry.main?.temp_min ?? 0);
      if (entry.weather?.[0]?.main) bucket.conditions.push(entry.weather[0].main);
      bucket.rain += entry.rain?.["3h"] ?? 0;
      byDate.set(date, bucket);
    }

    const result: ForecastDay[] = [];
    for (const [date, bucket] of byDate) {
      // Most common condition
      const conditionCounts = new Map<string, number>();
      for (const c of bucket.conditions) {
        conditionCounts.set(c, (conditionCounts.get(c) ?? 0) + 1);
      }
      let topCondition = "Unknown";
      let topCount = 0;
      for (const [c, count] of conditionCounts) {
        if (count > topCount) {
          topCondition = c;
          topCount = count;
        }
      }

      result.push({
        date,
        tempHigh: Math.round(Math.max(...bucket.highs)),
        tempLow: Math.round(Math.min(...bucket.lows)),
        condition: topCondition,
        rain: Math.round(bucket.rain * 100) / 100,
      });
    }

    forecastCache = { data: result, timestamp: Date.now() };
    return result;
  } catch (err) {
    console.log("[Weather] Forecast fetch failed:", (err as Error).message);
    return null;
  }
}

/**
 * Format a brief weather context string for checkpoint messages.
 * Returns null if weather data is unavailable.
 */
export async function formatWeatherContext(): Promise<string | null> {
  const weather = await getCurrentWeather();
  if (!weather) return null;

  let text = `**Weather**: ${weather.temp}°F, ${weather.description}`;
  if (weather.humidity > 70) {
    text += ` (humidity: ${weather.humidity}%)`;
  }
  if (weather.windSpeed > 15) {
    text += `, wind ${weather.windSpeed} mph`;
  }

  // Check if rain is expected today
  const forecast = await getForecast();
  if (forecast && forecast.length > 0) {
    const today = forecast[0];
    if (today.rain > 0) {
      text += `. Rain expected (${today.rain} mm)`;
    }
  }

  return text;
}

/**
 * Format the morning forecast for the 6 AM briefing.
 * Returns null if weather data is unavailable.
 */
export async function formatMorningForecast(): Promise<string | null> {
  const [current, forecast] = await Promise.all([
    getCurrentWeather(),
    getForecast(),
  ]);

  if (!current && !forecast) return null;

  let text = `**Morning Weather Briefing**\n\n`;

  if (current) {
    text += `**Right now**: ${current.temp}°F, ${current.description}`;
    if (current.humidity > 70) text += `, ${current.humidity}% humidity`;
    if (current.windSpeed > 10) text += `, wind ${current.windSpeed} mph`;
    text += `\n\n`;
  }

  if (forecast && forecast.length > 0) {
    const today = forecast[0];
    text += `**Today**: High ${today.tempHigh}°F, Low ${today.tempLow}°F, ${today.condition}`;
    if (today.rain > 0) {
      text += `. **Rain expected** (${today.rain} mm)`;
      text += `\nRain days can slow drive thru traffic. Plan for fewer but larger orders.`;
    }
    text += `\n`;

    // Tomorrow preview if available
    if (forecast.length > 1) {
      const tomorrow = forecast[1];
      text += `**Tomorrow**: High ${tomorrow.tempHigh}°F, Low ${tomorrow.tempLow}°F, ${tomorrow.condition}`;
      if (tomorrow.rain > 0) text += ` (rain: ${tomorrow.rain} mm)`;
      text += `\n`;
    }
  }

  return text;
}
