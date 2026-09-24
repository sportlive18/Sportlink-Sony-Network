/**
 * ============================================================
 *  HLS / DASH Stream Proxy — Cloudflare Pages Function
 *  Sony LIV + Akamai CDN
 *  Fix: hdnea token with /*~  special chars preserved correctly
 * ============================================================
 */

// ─── DEFAULT UPSTREAM HEADERS ─────────────────────────────────
const UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.sonyliv.com/",
  "Origin": "https://www.sonyliv.com",
};

// ─── PER-DOMAIN HEADER RULES ──────────────────────────────────
const DOMAIN_HEADERS = {

  "sonydaimenew.akamaized.net": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  },

  "akamaized.net": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },

  "sonyliv.com": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },

};

// ─── CORS HEADERS ─────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ─── GET DOMAIN BASE HEADERS ──────────────────────────────────
function getDomainHeaders(hostname) {
  if (DOMAIN_HEADERS[hostname]) return { ...DOMAIN_HEADERS[hostname] };
  for (const [domain, headers] of Object.entries(DOMAIN_HEADERS)) {
    if (hostname.endsWith("." + domain) || hostname === domain) {
      return { ...headers };
    }
  }
  return { ...UPSTREAM_HEADERS };
}

// ─── EXTRACT hdnea FROM RAW URL STRING (not parsed URL) ───────
// Uses regex on the raw string to avoid /* and ~ being mangled
function extractHdnea(rawUrl) {
  // Match hdnea=... until end of string or & (but & rarely appears in Akamai tokens)
  const match = rawUrl.match(/[?&]hdnea=([^&\s]+)/);
  if (match) return `hdnea=${match[1]}`;
  return null;
}

// ─── SPLIT URL FROM PIPE HEADERS SAFELY ──────────────────────
// ?u=https://...?hdnea=exp~acl=/*~hmac=...|Cookie=xxx
// Problem: pipe | inside the URL must be separated from header pipes
// Solution: first pipe AFTER a non-query-string segment is the separator
function splitRawU(rawU) {
  // Find first | that is NOT inside the query string value
  // Strategy: find the base URL end (before first |) 
  // but keep query string (which has = signs too)
  const pipeIdx = rawU.indexOf("|");
  if (pipeIdx === -1) {
    return { urlPart: rawU, pipePart: "" };
  }
  return {
    urlPart: rawU.substring(0, pipeIdx),
    pipePart: rawU.substring(pipeIdx + 1),
  };
}

// ─── PARSE PIPE HEADERS ───────────────────────────────────────
function parsePipeHeaders(pipePart) {
  const extras = {};
  if (!pipePart) return extras;
  const parts = pipePart.split("|");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.substring(0, idx).trim();
    const val = part.substring(idx + 1).trim();
    if (key && val) extras[key] = val;
  }
  return extras;
}

// ─── BUILD UPSTREAM HEADERS ───────────────────────────────────
function buildHeaders(urlStr, pipeExtras) {
  let hostname = "";
  try { hostname = new URL(urlStr).hostname; } catch {}

  const base = getDomainHeaders(hostname);

  // Auto-extract hdnea from raw URL string (preserves /* and ~)
  const hdnea = extractHdnea(urlStr);
  if (hdnea) {
    if (base["Cookie"]) {
      if (!base["Cookie"].includes("hdnea")) {
        base["Cookie"] = `${base["Cookie"]}; ${hdnea}`;
      }
    } else {
      base["Cookie"] = hdnea;
    }
    // Also store in pipeExtras so segments carry the cookie
    if (!pipeExtras["Cookie"]) {
      pipeExtras["Cookie"] = base["Cookie"];
    }
  }

  // Pipe extras override
  return { ...base, ...pipeExtras };
}

// ─── PROXIFY A URI ────────────────────────────────────────────
function proxifyUri(uri, baseUrl, proxyOrigin, pipeExtras) {
  if (!uri || uri.startsWith("data:")) return uri;

  let absolute;
  try {
    absolute = new URL(uri, baseUrl).toString();
  } catch {
    return uri;
  }

  const pipes = Object.entries(pipeExtras)
    .map(([k, v]) => `${k}=${v}`)
    .join("|");

  const full = pipes ? `${absolute}|${pipes}` : absolute;
  return `${proxyOrigin}/api/proxy?u=${encodeURIComponent(full)}`;
}

// ─── REWRITE HLS MANIFEST ─────────────────────────────────────
function rewriteM3U8(text, baseUrl, proxyOrigin, pipeExtras) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) =>
          `URI="${proxifyUri(uri, baseUrl, proxyOrigin, pipeExtras)}"`
        );
      }

      if (trimmed === "") return line;

      return proxifyUri(trimmed, baseUrl, proxyOrigin, pipeExtras);
    })
    .join("\n");
}

// ─── REWRITE DASH MANIFEST ────────────────────────────────────
function rewriteMPD(text, baseUrl, proxyOrigin, pipeExtras) {
  const rw = (url) => proxifyUri(url.trim(), baseUrl, proxyOrigin, pipeExtras);

  return text
    .replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (_, u) =>
      `<BaseURL>${rw(u)}</BaseURL>`
    )
    .replace(/\b(media|initialization)="([^"]+)"/gi, (_, a, u) =>
      `${a}="${rw(u)}"`
    )
    .replace(/xlink:href="([^"]+)"/gi, (_, u) =>
      `xlink:href="${rw(u)}"`
    )
    .replace(/\bsrc="([^"]+)"/gi, (_, u) =>
      `src="${rw(u)}"`
    );
}

// ─── DETECT HLS ───────────────────────────────────────────────
function isManifest(url, contentType) {
  if (contentType?.toLowerCase().includes("mpegurl")) return true;
  return /\.m3u8(\?|$)/i.test(url.split("?")[0]);
}

// ─── DETECT DASH ──────────────────────────────────────────────
function isDash(url, contentType) {
  if (contentType?.toLowerCase().includes("dash+xml")) return true;
  return /\.mpd(\?|$)/i.test(url.split("?")[0]);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  // ── Read raw ?u= value ────────────────────────────────────────
  // CRITICAL: read raw search string, NOT searchParams
  // because searchParams will mangle /*~ chars in hdnea token
  const rawSearch = reqUrl.search.replace(/^\?/, "");
  const uIdx = rawSearch.indexOf("u=");

  if (uIdx === -1) {
    return new Response(
      JSON.stringify({ error: "Missing ?u= parameter" }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Everything after u=
  let rawU = rawSearch.substring(uIdx + 2);

  // Decode percent-encoding if present
  try { rawU = decodeURIComponent(rawU); } catch {}

  // ── Split URL from pipe headers ───────────────────────────────
  const { urlPart: targetRaw, pipePart } = splitRawU(rawU);
  const pipeExtras = parsePipeHeaders(pipePart);

  // ── Build final upstream headers ──────────────────────────────
  const upstreamHeaders = buildHeaders(targetRaw, pipeExtras);

  // ── Validate URL ──────────────────────────────────────────────
  let targetUrl;
  try {
    targetUrl = new URL(targetRaw);
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid target URL" }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return new Response(
      JSON.stringify({ error: "Only http/https allowed" }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // ── Forward Range header ──────────────────────────────────────
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  // ── Fetch upstream ────────────────────────────────────────────
  let upstreamResp;
  try {
    upstreamResp = await fetch(targetRaw, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Fetch failed: ${e.message}` }),
      {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  if (!upstreamResp.ok && upstreamResp.status !== 206) {
    return new Response(
      JSON.stringify({ error: `Upstream returned ${upstreamResp.status}` }),
      {
        status: upstreamResp.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  const contentType = upstreamResp.headers.get("Content-Type") || "";

  // ── HLS manifest ──────────────────────────────────────────────
  if (isManifest(targetRaw, contentType)) {
    const text = await upstreamResp.text();
    const rewritten = rewriteM3U8(
      text,
      targetRaw,
      reqUrl.origin,
      pipeExtras
    );
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  // ── DASH manifest ─────────────────────────────────────────────
  if (isDash(targetRaw, contentType)) {
    const text = await upstreamResp.text();
    const rewritten = rewriteMPD(
      text,
      targetRaw,
      reqUrl.origin,
      pipeExtras
    );
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  // ── Binary passthrough ────────────────────────────────────────
  const passHeaders = {
    ...CORS_HEADERS,
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=15",
  };

  const cl = upstreamResp.headers.get("Content-Length");
  const cr = upstreamResp.headers.get("Content-Range");
  const ar = upstreamResp.headers.get("Accept-Ranges");
  if (cl) passHeaders["Content-Length"] = cl;
  if (cr) passHeaders["Content-Range"] = cr;
  if (ar) passHeaders["Accept-Ranges"] = ar;

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: passHeaders,
  });
}
