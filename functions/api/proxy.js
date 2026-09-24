/**
 * ============================================================
 *  HLS / DASH Stream Proxy — Cloudflare Pages Function
 *  Sony LIV + Akamai CDN
 *  Auto-extracts hdnea token → Cookie
 *  Supports: ?u=URL|Cookie=xxx|Header=yyy
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

  // ── Sony LIV — Akamai CDN (exact) ────────────────────────────
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

  // ── Sony LIV — Any Akamai subdomain ───────────────────────────
  "akamaized.net": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.sonyliv.com/",
    "Origin": "https://www.sonyliv.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },

  // ── Sony LIV — General ────────────────────────────────────────
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

// ─── AUTO-EXTRACT AKAMAI hdnea TOKEN → COOKIE ────────────────
function extractAkamaiCookie(urlStr) {
  try {
    const u = new URL(urlStr);

    const hdnea = u.searchParams.get("hdnea");
    if (hdnea) return `hdnea=${hdnea}`;

    // Fallback: raw query string match
    const match = u.search.match(/[?&](hdnea)=([^&]+)/);
    if (match) return `${match[1]}=${match[2]}`;

  } catch {}
  return null;
}

// ─── PARSE ?u=URL|Cookie=xxx|Header=yyy ──────────────────────
function parseTarget(raw) {
  const parts = raw.split("|");
  const url = parts[0].trim();

  // Start with domain-matched headers
  let headers;
  try {
    headers = getDomainHeaders(new URL(url).hostname);
  } catch {
    headers = { ...UPSTREAM_HEADERS };
  }

  // Pipe headers override/extend
  const pipeExtras = {};
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf("=");
    if (idx === -1) continue;
    const key = parts[i].substring(0, idx).trim();
    const val = parts[i].substring(idx + 1).trim();
    if (key && val) {
      headers[key] = val;
      pipeExtras[key] = val;
    }
  }

  // ── Auto-inject hdnea as Cookie ───────────────────────────────
  const akamaiCookie = extractAkamaiCookie(url);
  if (akamaiCookie) {
    if (headers["Cookie"]) {
      if (!headers["Cookie"].includes("hdnea")) {
        headers["Cookie"] = `${headers["Cookie"]}; ${akamaiCookie}`;
        pipeExtras["Cookie"] = headers["Cookie"];
      }
    } else {
      headers["Cookie"] = akamaiCookie;
      pipeExtras["Cookie"] = akamaiCookie;
    }
  }

  return { url, headers, pipeExtras };
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
  return /\.m3u8(\?|$)/i.test(url.split("|")[0]);
}

// ─── DETECT DASH ──────────────────────────────────────────────
function isDash(url, contentType) {
  if (contentType?.toLowerCase().includes("dash+xml")) return true;
  return /\.mpd(\?|$)/i.test(url.split("|")[0]);
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

  // ── Read raw ?u= (preserve pipes & special chars) ─────────────
  let rawU = null;
  const search = reqUrl.search.replace(/^\?/, "");
  const uIdx = search.indexOf("u=");
  if (uIdx !== -1) {
    rawU = search.substring(uIdx + 2);
    const stopMatch = rawU.match(/&[^|=]+=/)
    if (stopMatch) rawU = rawU.substring(0, stopMatch.index);
  }

  if (!rawU) {
    return new Response(
      JSON.stringify({ error: "Missing ?u= parameter" }),
      {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }

  // Decode percent-encoding
  try { rawU = decodeURIComponent(rawU); } catch {}

  // ── Parse URL + headers ───────────────────────────────────────
  const { url: targetRaw, headers: upstreamHeaders, pipeExtras } = parseTarget(rawU);

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
    upstreamResp = await fetch(targetUrl.toString(), {
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
      targetUrl.toString(),
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
      targetUrl.toString(),
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

  // ── Binary passthrough (segments, keys, init, audio) ──────────
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
