/**
 * ============================================================
 *  HLS / DASH Stream Proxy — Cloudflare Pages Function
 *  Place at: functions/api/proxy.js
 *  Route:    /api/proxy?u=<encoded-url>[|Header=Value]
 * ============================================================
 */

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
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  },
  "sonyliv.com": {
    "User-Agent": DEFAULT_UA,
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },
};

// ─── ERROR RESPONSE HELPER ────────────────────────────────────
function errJson(status, code, message, extra = {}) {
  return new Response(
    JSON.stringify({ error: true, code, message, ...extra }),
    {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    }
  );
}

// ─── GET DOMAIN HEADERS ───────────────────────────────────────
function getDomainHeaders(hostname) {
  for (const [domain, headers] of Object.entries(DOMAIN_HEADERS)) {
    if (hostname === domain || hostname.endsWith("." + domain)) {
      return { ...headers };
    }
  }
  return { "User-Agent": DEFAULT_UA };
}

// ─── PARSE ?u= RAW VALUE ──────────────────────────────────────
// Splits: https://cdn.example.com/path?token=abc|Cookie=xyz|Referer=...
// Pipe separator — first | splits URL from extra headers
function parseU(rawU) {
  // Decode once if percent-encoded
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

// ─── EXTRACT hdnea TOKEN FROM RAW URL STRING ──────────────────
// Must use regex on raw string — URL parser mangles /* and ~
function extractHdnea(rawUrl) {
  const m = rawUrl.match(/[?&]hdnea=([^&\s]+)/);
  return m ? m[1] : null; // returns VALUE only, no "hdnea=" prefix
}

// ─── BUILD UPSTREAM REQUEST HEADERS ──────────────────────────
function buildUpstreamHeaders(rawUrl, extras) {
  let hostname = "";
  try { hostname = new URL(rawUrl).hostname; } catch {}

  const headers = getDomainHeaders(hostname);

  // Inject hdnea as Cookie (value only, prefix added here)
  const hdnea = extractHdnea(rawUrl);
  if (hdnea) {
    // Merge with any existing Cookie
    const existing = extras["Cookie"] || headers["Cookie"] || "";
    const hdneaCookie = `hdnea=${hdnea}`;
    headers["Cookie"] = existing
      ? existing.includes("hdnea")
        ? existing
        : `${existing}; ${hdneaCookie}`
      : hdneaCookie;
  }

  // Pipe extras override domain defaults (but don't double-add Cookie)
  for (const [k, v] of Object.entries(extras)) {
    if (k === "Cookie" && headers["Cookie"] && !headers["Cookie"].includes(v)) {
      headers["Cookie"] = `${headers["Cookie"]}; ${v}`;
    } else {
      headers[k] = v;
    }
  }

  return headers;
}

// ─── PROXIFY A URI ────────────────────────────────────────────
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
        // Rewrite URI="..." in tag attributes
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

// ─── FETCH WITH RETRY ─────────────────────────────────────────
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(url, options);
      return { resp, attempt: i + 1 };
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return errJson(405, "METHOD_NOT_ALLOWED", `Method ${request.method} not supported`);
  }

  // ── Read raw ?u= (bypass URLSearchParams to preserve special chars) ──
  const rawSearch = reqUrl.search.slice(1); // remove leading ?
  const uIdx = rawSearch.indexOf("u=");

  if (uIdx === -1) {
    return errJson(400, "MISSING_PARAM", "Missing required ?u= parameter", {
      hint: "Usage: /api/proxy?u=<encoded-stream-url>",
    });
  }

  const rawU = rawSearch.substring(uIdx + 2);

  if (!rawU) {
    return errJson(400, "EMPTY_URL", "?u= parameter is empty");
  }

  // ── Parse URL + pipe headers ──────────────────────────────────
  const { url: targetRaw, extras } = parseU(rawU);

  // ── Validate URL ──────────────────────────────────────────────
  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
  } catch {
    return errJson(400, "INVALID_URL", "Could not parse target URL", {
      received: targetRaw.substring(0, 100),
    });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return errJson(400, "BAD_PROTOCOL", `Protocol "${targetUrl.protocol}" not allowed. Use http or https.`);
  }

  // ── Build upstream headers ────────────────────────────────────
  const upHeaders = buildUpstreamHeaders(targetRaw, extras);

  // Forward Range header for byte-range requests
  const range = request.headers.get("Range");
  if (range) upHeaders["Range"] = range;

  // ── Fetch upstream with retry ─────────────────────────────────
  let upResp, attempts;
  try {
    const result = await fetchWithRetry(
      targetRaw,
      {
        method: request.method,
        headers: upHeaders,
        redirect: "follow",
        cf: { cacheTtl: 0, cacheEverything: false },
      },
      2
    );
    upResp = result.resp;
    attempts = result.attempt;
  } catch (e) {
    return errJson(502, "FETCH_FAILED", "Could not connect to upstream", {
      upstream: targetUrl.hostname,
      detail: e.message,
    });
  }

  // ── Handle upstream errors ────────────────────────────────────
  if (!upResp.ok && upResp.status !== 206) {
    const statusMap = {
      400: "Upstream rejected the request (bad token or params)",
      401: "Upstream requires authentication",
      403: "Upstream denied access — token may be expired, IP-locked, or Referer mismatch",
      404: "Stream not found on upstream server",
      429: "Upstream rate-limited this request",
      500: "Upstream server error",
      502: "Upstream gateway error",
      503: "Upstream service unavailable",
    };

    const hint = statusMap[upResp.status] || `Upstream returned HTTP ${upResp.status}`;

    // Try to read upstream error body for extra context
    let upBody = "";
    try { upBody = await upResp.text(); } catch {}

    return errJson(upResp.status, "UPSTREAM_ERROR", hint, {
      upstream: targetUrl.hostname,
      upstreamStatus: upResp.status,
      attempts,
      ...(upBody ? { upstreamBody: upBody.substring(0, 300) } : {}),
      debug: {
        cookieSent: !!upHeaders["Cookie"],
        hdneaFound: !!extractHdnea(targetRaw),
        referer: upHeaders["Referer"] || null,
      },
    });
  }

  const ct = upResp.headers.get("Content-Type") || "";

  // ── HLS Manifest ──────────────────────────────────────────────
  if (isHLS(targetRaw, ct)) {
    let text;
    try { text = await upResp.text(); } catch (e) {
      return errJson(502, "BODY_READ_FAILED", "Failed to read HLS manifest body", { detail: e.message });
    }
    const rewritten = rewriteM3U8(text, targetRaw, reqUrl.origin, extras);
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  // ── DASH Manifest ─────────────────────────────────────────────
  if (isDASH(targetRaw, ct)) {
    let text;
    try { text = await upResp.text(); } catch (e) {
      return errJson(502, "BODY_READ_FAILED", "Failed to read DASH manifest body", { detail: e.message });
    }
    const rewritten = rewriteMPD(text, targetRaw, reqUrl.origin, extras);
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  // ── Binary passthrough (TS segments, keys, etc.) ──────────────
  const passHeaders = {
    ...CORS,
    "Content-Type": ct || "application/octet-stream",
    "Cache-Control": "public, max-age=15",
  };

  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upResp.headers.get(h);
    if (v) passHeaders[h] = v;
  }

  return new Response(upResp.body, {
    status: upResp.status,
    headers: passHeaders,
  });
}
