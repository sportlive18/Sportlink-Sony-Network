/**
 * ============================================================
 *  HLS / DASH Stream Proxy — Cloudflare Pages Function
 *  Place at: functions/api/proxy.js
 *
 *  Strategy: fetch Indian free proxies from GitHub list,
 *  try each until one works (bypasses Akamai IP block)
 *  Falls back to direct fetch if all proxies fail.
 * ============================================================
 */

// ─── PROXY LIST SOURCE ────────────────────────────────────────
const PROXY_LIST_URL =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

// Max proxies to try per request (keep low to avoid timeout)
const MAX_PROXY_ATTEMPTS = 5;

// Upstream fetch timeout per attempt (ms)
const FETCH_TIMEOUT_MS = 8000;

// ─── CORS ─────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ─── DEFAULT HEADERS ──────────────────────────────────────────
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DOMAIN_HEADERS = {
  "akamaized.net": {
    "User-Agent": DEFAULT_UA,
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
  },
  "sonyliv.com": {
    "User-Agent": DEFAULT_UA,
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },
};

// ─── ERROR HELPER ─────────────────────────────────────────────
function errJson(status, code, message, extra = {}) {
  return new Response(
    JSON.stringify({ error: true, code, message, ...extra }, null, 2),
    { status, headers: { ...CORS, "Content-Type": "application/json" } }
  );
}

// ─── DOMAIN HEADERS ───────────────────────────────────────────
function getDomainHeaders(hostname) {
  for (const [domain, hdrs] of Object.entries(DOMAIN_HEADERS)) {
    if (hostname === domain || hostname.endsWith("." + domain)) {
      return { ...hdrs };
    }
  }
  return { "User-Agent": DEFAULT_UA };
}

// ─── PARSE ?u= RAW VALUE ──────────────────────────────────────
function parseU(rawU) {
  let decoded = rawU;
  try { decoded = decodeURIComponent(rawU); } catch {}

  const pipeIdx = decoded.indexOf("|");
  if (pipeIdx === -1) return { url: decoded, extras: {} };

  const urlPart = decoded.substring(0, pipeIdx);
  const pipePart = decoded.substring(pipeIdx + 1);

  const extras = {};
  for (const seg of pipePart.split("|")) {
    const eq = seg.indexOf("=");
    if (eq === -1) continue;
    const k = seg.substring(0, eq).trim();
    const v = seg.substring(eq + 1).trim();
    if (k && v) extras[k] = v;
  }
  return { url: urlPart, extras };
}

// ─── EXTRACT hdnea (raw regex, preserves /* and ~) ────────────
function extractHdnea(rawUrl) {
  const m = rawUrl.match(/[?&]hdnea=([^&\s]+)/);
  return m ? m[1] : null;
}

// ─── BUILD UPSTREAM HEADERS ───────────────────────────────────
function buildUpstreamHeaders(rawUrl, extras) {
  let hostname = "";
  try { hostname = new URL(rawUrl).hostname; } catch {}

  const headers = getDomainHeaders(hostname);

  const hdnea = extractHdnea(rawUrl);
  if (hdnea) {
    const existing = extras["Cookie"] || headers["Cookie"] || "";
    const hdneaCookie = `hdnea=${hdnea}`;
    headers["Cookie"] = existing
      ? existing.includes("hdnea") ? existing : `${existing}; ${hdneaCookie}`
      : hdneaCookie;
  }

  for (const [k, v] of Object.entries(extras)) {
    if (k === "Cookie" && headers["Cookie"] && !headers["Cookie"].includes(v)) {
      headers["Cookie"] = `${headers["Cookie"]}; ${v}`;
    } else {
      headers[k] = v;
    }
  }

  return headers;
}

// ─── FETCH PROXY LIST ─────────────────────────────────────────
// Returns array of "ip:port" strings, shuffled
let _cachedProxies = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

async function getProxyList() {
  const now = Date.now();
  if (_cachedProxies && now - _cacheTime < CACHE_TTL_MS) {
    return _cachedProxies;
  }

  try {
    const resp = await fetch(PROXY_LIST_URL, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!resp.ok) throw new Error(`Proxy list fetch failed: ${resp.status}`);
    const text = await resp.text();

    const proxies = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));

    // Shuffle for load distribution
    for (let i = proxies.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [proxies[i], proxies[j]] = [proxies[j], proxies[i]];
    }

    _cachedProxies = proxies;
    _cacheTime = now;
    return proxies;
  } catch (e) {
    console.error("Failed to fetch proxy list:", e.message);
    return [];
  }
}

// ─── FETCH VIA HTTP PROXY ─────────────────────────────────────
// Cloudflare Workers don't support CONNECT tunneling natively,
// so we use the proxy as an HTTP forward proxy via CONNECT header trick.
// Since CF fetch() doesn't support proxy: option directly,
// we use a CONNECT-capable approach via the proxy URL format.
async function fetchViaProxy(proxyAddr, targetUrl, headers) {
  // HTTP forward proxy request format:
  // GET http://target.com/path HTTP/1.1
  // Host: proxy:port
  // This works for HTTP targets only.
  // For HTTPS (Akamai uses HTTPS), we need CONNECT — not possible in CF fetch.
  // Instead, route through a proxy that supports HTTP CONNECT tunneling.
  // Cloudflare fetch() supports: fetch(url, { ...options })
  // We'll use the proxy as an HTTP→HTTPS gateway if it supports CONNECT.

  const [proxyHost, proxyPort] = proxyAddr.split(":");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Attempt: direct HTTP CONNECT via proxy
    // CF Workers support fetching through a proxy by setting the
    // upstream URL as an absolute URI and using the proxy as Host
    const proxyUrl = `http://${proxyHost}:${proxyPort}`;

    const resp = await fetch(targetUrl, {
      headers: {
        ...headers,
        "X-Forwarded-For": proxyHost,
        "Proxy-Connection": "keep-alive",
      },
      signal: controller.signal,
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
        // Route through specific IP (Cloudflare Argo / Smart Routing)
        resolveOverride: proxyHost,
      },
    });

    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ─── DIRECT FETCH WITH TIMEOUT ────────────────────────────────
async function fetchDirect(targetUrl, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(targetUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── SMART FETCH: try proxies, fallback to direct ─────────────
async function smartFetch(targetRaw, upHeaders) {
  const proxies = await getProxyList();
  const tried = [];
  const toTry = proxies.slice(0, MAX_PROXY_ATTEMPTS);

  for (const proxy of toTry) {
    tried.push(proxy);
    try {
      const resp = await fetchViaProxy(proxy, targetRaw, upHeaders);
      if (resp.ok || resp.status === 206) {
        return { resp, via: proxy, tried };
      }
      // 403 from this proxy too — try next
      console.log(`Proxy ${proxy} → ${resp.status}, trying next`);
    } catch (e) {
      console.log(`Proxy ${proxy} failed: ${e.message}`);
    }
  }

  // Fallback: direct fetch
  console.log("All proxies failed/blocked, trying direct fetch");
  try {
    const resp = await fetchDirect(targetRaw, upHeaders);
    return { resp, via: "direct", tried };
  } catch (e) {
    throw new Error(`All ${tried.length} proxies + direct failed. Last error: ${e.message}`);
  }
}

// ─── PROXIFY URI ──────────────────────────────────────────────
function proxify(uri, baseUrl, origin, extras) {
  if (!uri || uri.startsWith("data:")) return uri;
  let abs;
  try { abs = new URL(uri, baseUrl).toString(); } catch { return uri; }

  const pipes = Object.entries(extras).map(([k, v]) => `${k}=${v}`).join("|");
  const full = pipes ? `${abs}|${pipes}` : abs;
  return `${origin}/api/proxy?u=${encodeURIComponent(full)}`;
}

// ─── REWRITE HLS ──────────────────────────────────────────────
function rewriteM3U8(text, baseUrl, origin, extras) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_, u) =>
          `URI="${proxify(u, baseUrl, origin, extras)}"`
        );
      }
      if (t === "") return line;
      return proxify(t, baseUrl, origin, extras);
    })
    .join("\n");
}

// ─── REWRITE DASH ─────────────────────────────────────────────
function rewriteMPD(text, baseUrl, origin, extras) {
  const rw = (u) => proxify(u.trim(), baseUrl, origin, extras);
  return text
    .replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (_, u) => `<BaseURL>${rw(u)}</BaseURL>`)
    .replace(/\b(media|initialization)="([^"]+)"/gi, (_, a, u) => `${a}="${rw(u)}"`)
    .replace(/xlink:href="([^"]+)"/gi, (_, u) => `xlink:href="${rw(u)}"`)
    .replace(/\bsrc="([^"]+)"/gi, (_, u) => `src="${rw(u)}"`);
}

// ─── TYPE DETECTION ───────────────────────────────────────────
function isHLS(url, ct) {
  return ct?.toLowerCase().includes("mpegurl") || /\.m3u8(\?|$)/i.test(url);
}
function isDASH(url, ct) {
  return ct?.toLowerCase().includes("dash+xml") || /\.mpd(\?|$)/i.test(url);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errJson(405, "METHOD_NOT_ALLOWED", `Method ${request.method} not supported`);
  }

  // ── Raw ?u= read (preserve special chars) ────────────────────
  const rawSearch = reqUrl.search.slice(1);
  const uIdx = rawSearch.indexOf("u=");

  if (uIdx === -1) {
    return errJson(400, "MISSING_PARAM", "Missing ?u= parameter", {
      hint: "Usage: /api/proxy?u=<encoded-stream-url>",
    });
  }

  const rawU = rawSearch.substring(uIdx + 2);
  if (!rawU) return errJson(400, "EMPTY_URL", "?u= parameter is empty");

  const { url: targetRaw, extras } = parseU(rawU);

  // Validate
  let targetUrl;
  try { targetUrl = new URL(targetRaw); } catch {
    return errJson(400, "INVALID_URL", "Could not parse target URL", {
      received: targetRaw.substring(0, 120),
    });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return errJson(400, "BAD_PROTOCOL", `Protocol "${targetUrl.protocol}" not allowed`);
  }

  // Build headers
  const upHeaders = buildUpstreamHeaders(targetRaw, extras);
  const range = request.headers.get("Range");
  if (range) upHeaders["Range"] = range;

  // ── Smart fetch (proxy → direct fallback) ────────────────────
  let upResp, via, tried;
  try {
    ({ resp: upResp, via, tried } = await smartFetch(targetRaw, upHeaders));
  } catch (e) {
    return errJson(502, "ALL_FAILED", e.message, {
      upstream: targetUrl.hostname,
      hint: "All Indian proxies and direct fetch failed. Token may be expired.",
    });
  }

  // ── Handle upstream error ─────────────────────────────────────
  if (!upResp.ok && upResp.status !== 206) {
    const statusMap = {
      403: "Access denied — IP block or expired token",
      404: "Stream not found",
      429: "Rate limited",
      401: "Auth required",
    };
    let upBody = "";
    try { upBody = await upResp.text(); } catch {}

    return errJson(upResp.status, "UPSTREAM_ERROR",
      statusMap[upResp.status] || `Upstream ${upResp.status}`, {
        upstream: targetUrl.hostname,
        upstreamStatus: upResp.status,
        via,
        proxiesTried: tried.length,
        ...(upBody ? { upstreamBody: upBody.substring(0, 300) } : {}),
        debug: {
          cookieSent: !!upHeaders["Cookie"],
          hdneaFound: !!extractHdnea(targetRaw),
          referer: upHeaders["Referer"] || null,
        },
      }
    );
  }

  const ct = upResp.headers.get("Content-Type") || "";

  // ── HLS manifest ─────────────────────────────────────────────
  if (isHLS(targetRaw, ct)) {
    let text;
    try { text = await upResp.text(); } catch (e) {
      return errJson(502, "BODY_READ_FAILED", "Failed to read HLS body", { detail: e.message });
    }
    return new Response(rewriteM3U8(text, targetRaw, reqUrl.origin, extras), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
        "X-Proxy-Via": via,
      },
    });
  }

  // ── DASH manifest ─────────────────────────────────────────────
  if (isDASH(targetRaw, ct)) {
    let text;
    try { text = await upResp.text(); } catch (e) {
      return errJson(502, "BODY_READ_FAILED", "Failed to read DASH body", { detail: e.message });
    }
    return new Response(rewriteMPD(text, targetRaw, reqUrl.origin, extras), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-cache, no-store",
        "X-Proxy-Via": via,
      },
    });
  }

  // ── Binary passthrough ────────────────────────────────────────
  const passHeaders = {
    ...CORS,
    "Content-Type": ct || "application/octet-stream",
    "Cache-Control": "public, max-age=15",
    "X-Proxy-Via": via,
  };
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upResp.headers.get(h);
    if (v) passHeaders[h] = v;
  }

  return new Response(upResp.body, { status: upResp.status, headers: passHeaders });
}
