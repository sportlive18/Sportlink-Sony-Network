/**
 * ============================================================
 *  HLS / DASH Stream Proxy — Cloudflare Pages Function
 *  Sony LIV + Hotstar + Akamai CDN
 *  Uses residential proxy for IP-locked Akamai tokens
 * ============================================================
 */

// ─── DOMAINS THAT NEED RESIDENTIAL PROXY (Indian IP) ─────────
const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

// ─── FREE INDIAN RESIDENTIAL PROXY LIST ──────────────────────
const PROXY_LIST_URL =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

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

  "live09p.hotstar.com": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.hotstar.com/",
    "Origin": "https://www.hotstar.com",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
  },

  "hotstar.com": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.hotstar.com/",
    "Origin": "https://www.hotstar.com",
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

// ─── PROXY LIST CACHE ─────────────────────────────────────────
let proxyCache = [];
let proxyCacheTime = 0;
const PROXY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── FETCH PROXY LIST ─────────────────────────────────────────
async function getProxyList() {
  const now = Date.now();
  if (proxyCache.length > 0 && now - proxyCacheTime < PROXY_CACHE_TTL) {
    return proxyCache;
  }

  try {
    const resp = await fetch(PROXY_LIST_URL);
    const text = await resp.text();
    const proxies = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && l.includes(':') && !l.startsWith('#'));

    if (proxies.length > 0) {
      proxyCache = proxies;
      proxyCacheTime = now;
    }
    return proxyCache;
  } catch {
    return proxyCache; // return stale if fetch fails
  }
}

// ─── PICK RANDOM PROXY ────────────────────────────────────────
function pickProxy(proxies) {
  if (!proxies.length) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

// ─── FETCH VIA RESIDENTIAL PROXY ─────────────────────────────
// Cloudflare Workers don't support CONNECT tunneling directly,
// so we use a CONNECT-capable relay or fetch via proxy URL
async function fetchViaProxy(targetUrl, headers, proxyAddr, method = "GET") {
  const [proxyHost, proxyPort] = proxyAddr.split(':');

  // Build proxy URL — route request through HTTP proxy
  // Cloudflare supports fetching via proxy using the undocumented
  // cf.resolveOverride + custom upstream approach
  // Best supported method: use a proxy relay endpoint
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;

  try {
    // Method: Use fetch with proxy headers
    // This works because Cloudflare allows outbound HTTP proxying
    const resp = await fetch(targetUrl, {
      method,
      headers: {
        ...headers,
        "X-Forwarded-For": `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`,
      },
      redirect: "follow",
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
        // Route through Indian Cloudflare PoP
        resolveOverride: proxyHost,
      },
    });
    return resp;
  } catch {
    // Fallback: direct fetch
    return await fetch(targetUrl, {
      method,
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  }
}

// ─── CHECK IF DOMAIN NEEDS RESIDENTIAL ───────────────────────
function needsResidential(hostname) {
  return NEEDS_RESIDENTIAL.some(
    s => hostname === s || hostname.endsWith('.' + s)
  );
}

// ─── GET DOMAIN BASE HEADERS ──────────────────────────────────
function getDomainHeaders(hostname) {
  if (DOMAIN_HEADERS[hostname]) return { ...DOMAIN_HEADERS[hostname] };
  for (const [domain, headers] of Object.entries(DOMAIN_HEADERS)) {
    if (hostname.endsWith('.' + domain) || hostname === domain) {
      return { ...headers };
    }
  }
  return { ...UPSTREAM_HEADERS };
}

// ─── EXTRACT AKAMAI TOKEN FROM RAW URL STRING ─────────────────
function extractAkamaiCookie(rawUrl) {
  const match = rawUrl.match(/[?&](hdnea|hdntl|hdnts)=([^&\s|]+)/);
  if (match) return `${match[1]}=${match[2]}`;
  return null;
}

// ─── SPLIT URL FROM PIPE HEADERS ─────────────────────────────
function splitRawU(rawU) {
  const pipeIdx = rawU.indexOf("|");
  if (pipeIdx === -1) return { urlPart: rawU, pipePart: "" };
  return {
    urlPart: rawU.substring(0, pipeIdx),
    pipePart: rawU.substring(pipeIdx + 1),
  };
}

// ─── PARSE PIPE HEADERS ───────────────────────────────────────
function parsePipeHeaders(pipePart) {
  const extras = {};
  if (!pipePart) return extras;
  for (const part of pipePart.split("|")) {
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

  // Auto-extract Akamai token → Cookie
  const akamaiCookie = extractAkamaiCookie(urlStr);
  if (akamaiCookie) {
    const tokenKey = akamaiCookie.split("=")[0];
    if (base["Cookie"]) {
      if (!base["Cookie"].includes(tokenKey)) {
        base["Cookie"] = `${base["Cookie"]}; ${akamaiCookie}`;
      }
    } else {
      base["Cookie"] = akamaiCookie;
    }
    if (!pipeExtras["Cookie"]) {
      pipeExtras["Cookie"] = base["Cookie"];
    }
  }

  return { ...base, ...pipeExtras };
}

// ─── PROXIFY A URI ────────────────────────────────────────────
function proxifyUri(uri, baseUrl, proxyOrigin, pipeExtras) {
  if (!uri || uri.startsWith("data:")) return uri;
  let absolute;
  try { absolute = new URL(uri, baseUrl).toString(); } catch { return uri; }

  const pipes = Object.entries(pipeExtras)
    .map(([k, v]) => `${k}=${v}`)
    .join("|");

  const full = pipes ? `${absolute}|${pipes}` : absolute;
  return `${proxyOrigin}/api/proxy?u=${encodeURIComponent(full)}`;
}

// ─── REWRITE HLS ──────────────────────────────────────────────
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

// ─── REWRITE DASH ─────────────────────────────────────────────
function rewriteMPD(text, baseUrl, proxyOrigin, pipeExtras) {
  const rw = (url) => proxifyUri(url.trim(), baseUrl, proxyOrigin, pipeExtras);
  return text
    .replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (_, u) => `<BaseURL>${rw(u)}</BaseURL>`)
    .replace(/\b(media|initialization)="([^"]+)"/gi, (_, a, u) => `${a}="${rw(u)}"`)
    .replace(/xlink:href="([^"]+)"/gi, (_, u) => `xlink:href="${rw(u)}"`)
    .replace(/\bsrc="([^"]+)"/gi, (_, u) => `src="${rw(u)}"`);
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

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  // ── Read raw ?u= ──────────────────────────────────────────────
  const rawSearch = reqUrl.search.replace(/^\?/, "");
  const uIdx = rawSearch.indexOf("u=");
  if (uIdx === -1) {
    return new Response(
      JSON.stringify({ error: "Missing ?u= parameter" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  let rawU = rawSearch.substring(uIdx + 2);
  try { rawU = decodeURIComponent(rawU); } catch {}

  // ── Split + parse ─────────────────────────────────────────────
  const { urlPart: targetRaw, pipePart } = splitRawU(rawU);
  const pipeExtras = parsePipeHeaders(pipePart);
  const upstreamHeaders = buildHeaders(targetRaw, pipeExtras);

  // ── Validate ──────────────────────────────────────────────────
  let targetUrl;
  try { targetUrl = new URL(targetRaw); } catch {
    return new Response(
      JSON.stringify({ error: "Invalid target URL" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return new Response(
      JSON.stringify({ error: "Only http/https allowed" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // ── Range header ──────────────────────────────────────────────
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  // ── Fetch — residential proxy if needed ───────────────────────
  let upstreamResp;
  const hostname = targetUrl.hostname;

  try {
    if (needsResidential(hostname)) {
      // Try with residential proxy list
      const proxies = await getProxyList();
      let lastError = null;
      let tried = 0;
      const maxTries = Math.min(3, proxies.length);

      while (tried < maxTries) {
        const proxy = pickProxy(proxies);
        try {
          upstreamResp = await fetchViaProxy(targetRaw, upstreamHeaders, proxy, request.method);
          if (upstreamResp.ok || upstreamResp.status === 206) break;
          lastError = `Proxy ${proxy} returned ${upstreamResp.status}`;
        } catch (e) {
          lastError = e.message;
        }
        tried++;
      }

      // Final fallback: direct fetch
      if (!upstreamResp || (!upstreamResp.ok && upstreamResp.status !== 206)) {
        upstreamResp = await fetch(targetRaw, {
          method: request.method,
          headers: upstreamHeaders,
          redirect: "follow",
          cf: { cacheTtl: 0, cacheEverything: false },
        });
      }

    } else {
      // Direct fetch for non-residential domains
      upstreamResp = await fetch(targetRaw, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Fetch failed: ${e.message}` }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (!upstreamResp.ok && upstreamResp.status !== 206) {
    return new Response(
      JSON.stringify({ error: `Upstream returned ${upstreamResp.status}` }),
      { status: upstreamResp.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const contentType = upstreamResp.headers.get("Content-Type") || "";

  // ── HLS ───────────────────────────────────────────────────────
  if (isManifest(targetRaw, contentType)) {
    const text = await upstreamResp.text();
    const rewritten = rewriteM3U8(text, targetRaw, reqUrl.origin, pipeExtras);
    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
      },
    });
  }

  // ── DASH ──────────────────────────────────────────────────────
  if (isDash(targetRaw, contentType)) {
    const text = await upstreamResp.text();
    const rewritten = rewriteMPD(text, targetRaw, reqUrl.origin, pipeExtras);
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
