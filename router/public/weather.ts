/**
 * 天气代理（看板用）。
 *
 * 为什么不让前端直接调和风天气：API key 一旦进浏览器就是公开的，任何人 F12 就能拿走盗刷。
 * 所以 key 只留在服务端，这里做代理 + 缓存。
 *
 * 关于「位置」：
 *   · 不传 ?location 时用配置里的默认城市（qweather_location）；
 *   · 传的话必须是和风天气的数字 LocationID（^\d{5,10}$），只透传这个字段，
 *     不允许传任意 URL/主机，避免这个接口被当成开放代理；
 *   · 想在班级之间限制范围，就配 qweather_locations 白名单，非白名单的一律拒绝。
 *   · /v1/public/weather/lookup 用和风 GeoAPI 把城市名解析成 LocationID，供看板设置页搜索。
 *
 * 配置优先级：环境变量 > config.ts
 *   QWEATHER_KEY / QWEATHER_HOST / QWEATHER_LOCATION / QWEATHER_GEO_HOST
 */

import express from "express";
import { log } from "../../util/log";
import { config } from "../../config";

const router = express.Router();

const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_CACHE_MAX = 64;
const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX = 200;
const REQUEST_TIMEOUT_MS = 8000;

const weatherCache = new Map<string, { at: number; payload: any }>();
const lookupCache = new Map<string, { at: number; data: any[] }>();

function settings() {
  const c: any = config as any;
  const host = String(process.env.QWEATHER_HOST || c.qweather_host || "devapi.qweather.com")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  // 老 key 的 GeoAPI 在独立主机上；新账号(.re.qweatherapi.com)则是同一个主机的 /geo 路径
  const isNewHost = /\.re\.qweatherapi\.com$/i.test(host);
  const geoHost = String(process.env.QWEATHER_GEO_HOST || c.qweather_geo_host || (isNewHost ? host : "geoapi.qweather.com"))
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return {
    key: String(process.env.QWEATHER_KEY || c.qweather_key || "").trim(),
    host,
    geoHost,
    geoPath: geoHost === host ? "/geo/v2/city/lookup" : "/v2/city/lookup",
    location: String(process.env.QWEATHER_LOCATION || c.qweather_location || "").trim(),
    allowed: Array.isArray(c.qweather_locations) ? c.qweather_locations.map((x: any) => String(x)) : [],
  };
}

function cacheGet<K, V>(map: Map<K, { at: number; payload?: any; data?: any }>, key: K, ttl: number) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    map.delete(key);
    return null;
  }
  return hit;
}

function cacheSet<K, V>(map: Map<K, any>, key: K, value: { at: number; payload?: any; data?: any }, max: number) {
  if (map.size >= max) {
    let oldestKey: any = null;
    let oldestAt = Infinity;
    for (const [k, v] of map) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) map.delete(oldestKey);
  }
  map.set(key, value);
}

async function qweather(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`QWeather HTTP ${res.status}`);
  const json: any = await res.json();
  // 和风用自己的 code 字段表示业务状态，"200" 才是成功
  if (String(json?.code) !== "200") throw new Error(`QWeather code ${json?.code}`);
  return json;
}

/** GET /v1/public/weather.json?location=<LocationID> */
router.get("/v1/public/weather.json", async (req, res) => {
  const { key, host, location: defaultLocation, allowed } = settings();
  if (!key) {
    return res.status(503).json({
      code: 503,
      msg: "未配置和风天气：需要 qweather_key（或环境变量 QWEATHER_KEY）",
    });
  }

  const raw = String(req.query.location ?? "").trim();
  let location = defaultLocation;
  if (raw) {
    if (!/^\d{5,10}$/.test(raw)) {
      return res.status(400).json({ code: 400, msg: "location 必须是和风天气的数字 LocationID" });
    }
    location = raw;
  }
  if (!location) {
    return res.status(503).json({
      code: 503,
      msg: "未指定城市：需要 qweather_location 配置，或在请求里带 ?location=<LocationID>",
    });
  }
  if (location !== defaultLocation && allowed.length && !allowed.includes(location)) {
    return res.status(403).json({ code: 403, msg: "该 LocationID 不在允许列表内" });
  }

  const cached = cacheGet(weatherCache, location, WEATHER_TTL_MS);
  if (cached?.payload) return res.json({ ...cached.payload, cached: true });

  try {
    const loc = encodeURIComponent(location);
    const [now, forecast, warning] = await Promise.all([
      qweather(`https://${host}/v7/weather/now?location=${loc}&key=${encodeURIComponent(key)}`),
      qweather(`https://${host}/v7/weather/3d?location=${loc}&key=${encodeURIComponent(key)}`).catch(() => null),
      // 预警不是每个城市都有，失败也绝不能影响天气本体
      qweather(`https://${host}/v7/warning/now?location=${loc}&key=${encodeURIComponent(key)}`).catch(() => null),
    ]);

    const today = forecast?.daily?.[0] || null;
    const payload = {
      code: 0,
      location,
      now: {
        temp: Number(now?.now?.temp ?? 0),
        feelsLike: now?.now?.feelsLike != null ? Number(now.now.feelsLike) : null,
        text: now?.now?.text ?? "",
        icon: String(now?.now?.icon ?? ""),
        windDir: now?.now?.windDir ?? "",
        windScale: now?.now?.windScale ?? "",
        humidity: now?.now?.humidity != null ? Number(now.now.humidity) : null,
        obsTime: now?.now?.obsTime ?? "",
      },
      today: today
        ? {
            tempMax: Number(today.tempMax ?? 0),
            tempMin: Number(today.tempMin ?? 0),
            textDay: today.textDay ?? "",
            textNight: today.textNight ?? "",
            iconDay: String(today.iconDay ?? ""),
            sunrise: today.sunrise ?? "",
            sunset: today.sunset ?? "",
          }
        : null,
      provider: "QWeather",
      providerUrl: "https://www.qweather.com/",
      warnings: (warning?.warning || []).map((w: any) => ({
        id: String(w?.id ?? ""),
        title: w?.title ?? "",
        typeName: w?.typeName ?? "",
        level: w?.level ?? "",
        severityColor: w?.severityColor ?? "",
        sender: w?.sender ?? "",
        pubTime: w?.pubTime ?? "",
        endTime: w?.endTime ?? "",
        text: w?.text ?? "",
      })),
      updatedAt: new Date().toISOString(),
      cached: false,
    };

    cacheSet(weatherCache, location, { at: Date.now(), payload }, WEATHER_CACHE_MAX);
    res.json(payload);
  } catch (e) {
    log(`[public/weather] ${e}`, "error");
    // 有旧缓存就降级返回，看板不至于因为一次网络抖动变空白
    const stale = weatherCache.get(location);
    if (stale?.payload) return res.json({ ...stale.payload, cached: true, degraded: true });
    res.status(502).json({ code: 502, msg: "天气服务暂时不可用" });
  }
});

/** GET /v1/public/weather/lookup?q=济南 —— 城市名 → LocationID */
router.get("/v1/public/weather/lookup", async (req, res) => {
  const { key, geoHost, geoPath } = settings();
  if (!key) return res.status(503).json({ code: 503, msg: "未配置和风天气 key" });

  const q = String(req.query.q ?? "").trim();
  if (q.length < 2 || q.length > 40) {
    return res.status(400).json({ code: 400, msg: "请至少输入 2 个字符的城市名" });
  }

  const cacheKey = q.toLowerCase();
  const cached = cacheGet(lookupCache, cacheKey, LOOKUP_TTL_MS);
  if (cached?.data) return res.json({ code: 0, query: q, results: cached.data, cached: true });

  try {
    const json = await qweather(
      `https://${geoHost}${geoPath}?location=${encodeURIComponent(q)}&number=8&lang=zh&key=${encodeURIComponent(key)}`,
    );
    const results = (json?.location || []).map((x: any) => ({
      id: String(x.id ?? ""),
      name: x.name ?? "",
      adm1: x.adm1 ?? "",
      adm2: x.adm2 ?? "",
      country: x.country ?? "",
      lat: x.lat ?? "",
      lon: x.lon ?? "",
    }));
    cacheSet(lookupCache, cacheKey, { at: Date.now(), data: results }, LOOKUP_CACHE_MAX);
    res.json({ code: 0, query: q, results, cached: false });
  } catch (e) {
    log(`[public/weather/lookup] ${e}`, "error");
    res.status(502).json({ code: 502, msg: "城市搜索暂时不可用" });
  }
});

export default router;
