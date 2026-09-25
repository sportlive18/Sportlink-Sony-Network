// ============================================================
//  FANCODE HLS PROXY — Cloudflare Pages Function
//  File : functions/api/proxy.js
//  Route: https://<your-pages-site>/api/proxy?url=<encoded>
//         (also accepts ?u= for backward compat)
//
//  Serves both manifests and segments through the same endpoint.
//  Content type is inspected: an .m3u8 gets its URLs rewritten to
//  point back here, anything else is streamed as-is.
//
//  Locked to a fixed set of front-end origins and a fixed set of
//  upstream hosts.
// ============================================================

const REFERER = "https://www.fancode.com/";
const ORIGIN  = "https://www.fancode.com";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* Front-ends allowed to call this function. The Origin header is set by
   the browser and cannot be forged from JavaScript, so any page on a
   different domain is rejected here.

   Safari's native HLS media element does not send Origin for cross-origin
   <video src> fetches — only Referer — so Referer is checked as a fallback.
   Front-ends must not use a no-referrer policy. */
const ALLOWED_ORIGINS = [
  "https://sportlink-sonyliv10.pages.dev/",
  "https://sportlink-cric.pages.dev",        // ← added
  "https://sportlink10-ajp.pages.dev",       // ← added
];

/* Upstream hosts this function will fetch. Anything else is rejected, so
   the ?url= parameter cannot be abused to relay arbitrary internet traffic. */
const ALLOWED_UPSTREAM = [
  "fancode.com",
  "in-mc-flive.fancode.com",
  "dai-fancode.pages.dev",
];

/* Allow the function's own origin as a caller. Same-origin GETs do not
   send Origin, and if the player sets referrer=no-referrer they do not
   send Referer either. In that case we trust the browser-set
   Sec-Fetch-Site header, which JavaScript cannot forge. */
const ALLOW_SAME_ORIGIN = true;

/* ------------------------------------------------------------------ */

function hostAllowed(host) {
  return ALLOWED_UPSTREAM.some(s => host === s || host.endsWith("." + s));
}

/* Return the matched origin if the request is permitted, else null. */
function matchOrigin(request, selfOrigin) {
  /* 1. Explicit whitelist for cross-origin callers */
  const origin = request.headers.get("Origin");
  if (origin) {
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  }

  /* 2. Same-origin requests: browsers do NOT send Origin for same-origin
        GET fetches, and the player sets referrer=no-referrer, so we must
        rely on Sec-Fetch-Site. Browsers set this themselves and JS
        cannot forge it. */
  const site = request.headers.get("Sec-Fetch-Site");
  if (ALLOW_SAME_ORIGIN && site === "same-origin") {
    return selfOrigin;
  }

  /* 3. Referer fallback (Safari HLS element sometimes sends only this) */
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (ALLOWED_ORIGINS.includes(refOrigin)) return refOrigin;
      if (ALLOW_SAME_ORIGIN && refOrigin === selfOrigin) return refOrigin;
    } catch { /* fall through */ }
  }
  return null;
}

/* CORS headers echo the specific origin rather than `*`. */
function corsHeaders(matchedOrigin) {
  return {
    "Access-Control-Allow-Origin": matchedOrigin || ALLOWED_ORIGINS[0] || "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Vary": "Origin",
  };
}

/* Extract hdntl token from the target URL and return it as a cookie value.
   Some Akamai edges require it as a Cookie even when it's in the URL. */
function hdntlFromUrl(target) {
  const m = target.match(/[?&]hdntl=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ------------------------------------------------------------------ */

export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const selfOrigin = reqUrl.origin;

  const matchedOrigin = matchOrigin(request, selfOrigin);

  /* Preflight: only answer if the origin is allowed. Answering a preflight
     from a disallowed origin would tell the browser the request is
     permitted, defeating the check. */
  if (request.method === "OPTIONS") {
    if (!matchedOrigin) return new Response(null, { status: 403 });
    return new Response(null, { headers: corsHeaders(matchedOrigin) });
  }

  /* Every endpoint requires a matched origin. A direct URL visit or a
     bare curl produces neither Origin nor matching Referer and lands
     here. */
  if (!matchedOrigin) {
    return new Response("Forbidden: origin not allowed", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const CORS = corsHeaders(matchedOrigin);

  /* Accept both ?url= and ?u= */
  const target = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
  if (!target) return new Response("Missing ?url=", { status: 400, headers: CORS });

  let parsed;
  try { parsed = new URL(target); } catch {
    return new Response("Invalid ?url=", { status: 400, headers: CORS });
  }
  if (!hostAllowed(parsed.hostname)) {
    return new Response("Host not allowed", { status: 403, headers: CORS });
  }

  let upstream;
  try {
    upstream = await fetchWithRetry(target);
  } catch (e) {
    return new Response("Upstream failed: " + e.message, { status: 502, headers: CORS });
  }

  /* A refusal is not a playlist, whatever the path says. Rewriting an HTML
     error page as one turns each of its lines into a proxy URL, and the
     player ends up with a 200-looking manifest of nonsense. */
  if (!upstream.ok) {
    const body = await upstream.text();
    const errHeaders = new Headers(CORS);
    errHeaders.set("X-Proxy-Upstream", String(upstream.status));
    errHeaders.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(body.slice(0, 2000), { status: upstream.status, headers: errHeaders });
  }

  const ct = upstream.headers.get("content-type") || "";
  const lower = parsed.pathname.toLowerCase();
  const isPlaylist = lower.endsWith(".m3u8") || ct.includes("mpegurl");

  if (isPlaylist) {
    const text = await upstream.text();
    const base = new URL(target);
    const wrapBase = `${selfOrigin}/api/proxy?url=`;

    const rewritten = text.split("\n").map((rawLine) => {
      const line = rawLine.trim();
      if (line === "") return rawLine;

      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = new URL(uri, base).toString();
          return `URI="${wrapBase}${encodeURIComponent(abs)}"`;
        });
      }

      const abs = new URL(line, base).toString();
      return wrapBase + encodeURIComponent(abs);
    }).join("\n");

    const headers = new Headers(CORS);
    headers.set("Content-Type", "application/vnd.apple.mpegurl");
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    headers.set("CDN-Cache-Control", "no-store");
    return new Response(rewritten, { status: 200, headers });
  }

  /* Segment, key, or anything else: stream the bytes back. Piping the body
     rather than buffering keeps segment size off the runtime's memory
     ceiling. */
  const headers = new Headers(CORS);
  headers.set("Content-Type", ct || "video/mp2t");
  headers.set("Cache-Control", upstream.headers.get("cache-control") || "public, max-age=30");
  return new Response(upstream.body, { status: 200, headers });
}

/* ============================================================
   Fetch with retry — handles transient 403/429/5xx from Fancode
   ============================================================ */
async function fetchWithRetry(url, attempt = 1) {
  const maxAttempts = 4;

  /* Build upstream headers. The hdntl token lives inside the URL query
     string, but some Akamai configurations ALSO require it as a Cookie.
     Sending it both ways costs nothing and unblocks those edges. */
  const upstreamHeaders = {
    "Referer": REFERER,
    "Origin": ORIGIN,
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
  const hdntl = hdntlFromUrl(url);
  if (hdntl) upstreamHeaders["Cookie"] = `hdntl=${hdntl}`;

  try {
    const res = await fetch(url, {
      headers: upstreamHeaders,
      redirect: "follow",
    });

    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    throw e;
  }
}
