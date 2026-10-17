/**
 * 天气代理（看板用）。
 *
 * 为什么不让前端直接调和风天气：API key 一旦进浏览器就是公开的，任何人 F12 就能拿走盗刷。
 * 所以 key 只留在服务端，这里做代理 + 缓存。
 *
 * 另外两点是有意为之：
 *   · **只查配置里的一个城市**，不接受 ?location= 透传，避免本接口被当成免费天气 API 用；
 *   · 结果缓存 10 分钟，看板就算开 20 个也不会打穿免费额度（和风免费版有每日调用上限）。
 *
 * 配置优先级：环境变量 > config.ts
 *   QWEATHER_KEY / QWEATHER_HOST / QWEATHER_LOCATION
 */

import express from "express";
import { log } from "../../util/log";
import { config } from "../../config";

const router = express.Router();

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

let cache: { at: number; payload: any } = { at: 0, payload: null };

function settings() {
  const c: any = config as any;
  return {
    key: String(process.env.QWEATHER_KEY || c.qweather_key || "").trim(),
    host: String(process.env.QWEATHER_HOST || c.qweather_host || "devapi.qweather.com")
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
    location: String(process.env.QWEATHER_LOCATION || c.qweather_location || "").trim(),
  };
}

async function qweather(path: string, key: string, host: string): Promise<any> {
  const url = `https://${host}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`QWeather HTTP ${res.status}`);
  const json: any = await res.json();
  // 和风用自己的 code 字段表示业务状态，"200" 才是成功
  if (String(json?.code) !== "200") throw new Error(`QWeather code ${json?.code}`);
  return json;
}

router.get("/v1/public/weather.json", async (_req, res) => {
  const { key, host, location } = settings();
  if (!key || !location) {
    return res.status(503).json({
      code: 503,
      msg: "未配置和风天气：需要 qweather_key 与 qweather_location（或环境变量 QWEATHER_KEY / QWEATHER_LOCATION）",
    });
  }

  if (cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json({ ...cache.payload, cached: true });
  }

  try {
    const loc = encodeURIComponent(location);
    const [now, forecast] = await Promise.all([
      qweather(`/v7/weather/now?location=${loc}`, key, host),
      qweather(`/v7/weather/3d?location=${loc}`, key, host).catch(() => null),
    ]);

    const today = forecast?.daily?.[0] || null;
    const payload = {
      code: 0,
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
      updatedAt: new Date().toISOString(),
      cached: false,
    };

    cache = { at: Date.now(), payload };
    res.json(payload);
  } catch (e) {
    log(`[public/weather] ${e}`, "error");
    // 有旧缓存就降级返回，看板不至于因为一次网络抖动变空白
    if (cache.payload) return res.json({ ...cache.payload, cached: true, degraded: true });
    res.status(502).json({ code: 502, msg: "天气服务暂时不可用" });
  }
});

export default router;
