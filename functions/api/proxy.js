const ALLOWED_ORIGINS = [
  "https://cric10.pages.dev",
  "https://sl10.pages.dev",
  "https://sportlink10-ajp.pages.dev",
  "https://sportlink-sonyliv10.pages.dev",
  "https://sportlink-sonyliv.pages.dev",
];

const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://fancode.com/",
  "Origin": "https://fancode.com",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function isManifest(url, contentType) {
  if (contentType && contentType.toLowerCase().includes("mpegurl")) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

function proxifyUri(uri, baseUrl, proxyOrigin) {
  if (!uri) return uri;
  const absolute = new URL(uri, baseUrl).toString();
  return `${proxyOrigin}/api/proxy?u=${encodeURIComponent(absolute)}`;
}

function rewriteManifest(text, baseUrl, proxyOrigin) {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) {
      return line.replace(/URI="([^"]+)"/, (_, uri) => {
        return `URI="${proxifyUri(uri, baseUrl, proxyOrigin)}"`;
      });
    }
    if (trimmed.startsWith("#") || trimmed === "") {
      return line;
    }
    return proxifyUri(trimmed, baseUrl, proxyOrigin);
  });
  return out.join("\n");
}

export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);

  // ── Preflight ─────────────────────────────────────────────────
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── ORIGIN / REFERER PROTECTION ───────────────────────────────
  const origin  = request.headers.get("Origin")  || "";
  const referer = request.headers.get("Referer") || "";
  const site    = request.headers.get("Sec-Fetch-Site") || "";

  const isAllowed =
    ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o)) ||
    site === "same-origin";

  if (!isAllowed) {
    return new Response("Forbidden: origin not allowed", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // ── Target URL ────────────────────────────────────────────────
  const target = reqUrl.searchParams.get("u");
  if (!target) {
    return new Response("Missing ?u= target URL", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return new Response("Invalid target URL", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(targetUrl.toString(), {
      headers: UPSTREAM_HEADERS,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (e) {
    return new Response(`Upstream fetch failed: ${e.message}`, {
      status: 502,
      headers: CORS_HEADERS,
    });
  }

  if (!upstreamResp.ok) {
    return new Response(`Upstream returned ${upstreamResp.status}`, {
      status: upstreamResp.status,
      headers: CORS_HEADERS,
    });
  }

  const contentType = upstreamResp.headers.get("content-type") || "";

  if (isManifest(targetUrl.toString(), contentType)) {
    const text = await upstreamResp.text();
    const proxyOrigin = reqUrl.origin;
    const rewritten = rewriteManifest(text, targetUrl.toString(), proxyOrigin);

    return new Response(rewritten, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      },
    });
  }

  const passthroughHeaders = {
    ...CORS_HEADERS,
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=15",
  };
  const contentLength = upstreamResp.headers.get("content-length");
  if (contentLength) passthroughHeaders["Content-Length"] = contentLength;

  return new Response(upstreamResp.body, {
    status: 200,
    headers: passthroughHeaders,
  });
}
