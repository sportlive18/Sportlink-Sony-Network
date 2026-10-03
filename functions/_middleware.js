const ALLOWED_ORIGINS = [
  "https://sportlink-cric.pages.dev",
  "https://sportlink10-ajp.pages.dev",
  "https://sportlink-sonyliv10.pages.dev",
  "https://sportlink-sonyliv.pages.dev",
];

const SECRET_TOKEN = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

export async function onRequest(context) {
  const { request, next } = context;
  const reqUrl = new URL(request.url);

  // Skip preflight
  if (request.method === "OPTIONS") return next();

  // ── Token check ──────────────────────────────────────────────
  const token = reqUrl.searchParams.get("t");
  if (!token || token !== SECRET_TOKEN) {
    return new Response("Forbidden: invalid token", { status: 403 });
  }

  // ── Origin check ─────────────────────────────────────────────
  const origin  = request.headers.get("Origin")  || "";
  const referer = request.headers.get("Referer") || "";
  const site    = request.headers.get("Sec-Fetch-Site") || "";

  const isAllowed =
    ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o)) ||
    site === "same-origin";

  if (!isAllowed) {
    return new Response("Forbidden: origin not allowed", { status: 403 });
  }

  // ── Rate limit via KV ─────────────────────────────────────────
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const env = context.env;

  if (env?.RATE_KV) {
    const windowKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    let count = parseInt((await env.RATE_KV.get(windowKey)) || "0");
    count++;
    await env.RATE_KV.put(windowKey, String(count), { expirationTtl: 120 });

    if (count > 60) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  // ── Pass to actual route handler ──────────────────────────────
  return next();
}
