const PROJECT_URL = Deno.env.get("SUPABASE_URL");
const DEFAULT_ALLOWED_ORIGINS = [
  "https://eduardobs.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const ALLOWED_ORIGINS = (() => {
  const configured = Deno.env.get("ALLOWED_ORIGINS");
  const origins = configured
    ? configured.split(",").map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return new Set(origins);
})();

function secretKey(): string | null {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (typeof parsed.default === "string") return parsed.default;
    } catch {
      // Fall back to the legacy key below during key migrations.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "apikey, content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(corsHeaders(origin));
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: "origin_not_allowed" }, 403, origin);
    }
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin, { Allow: "POST" });
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403, origin);
  }

  // Read a bounded stream: Content-Length alone is not trustworthy.
  let input;
  try {
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return jsonResponse({ error: "request_too_large" }, 413, origin);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    input = JSON.parse(new TextDecoder().decode(bytes));
    if (!input || typeof input.request_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id) ||
        !Number.isInteger(input.amount) || input.amount < 1 || input.amount > 50) {
      return jsonResponse({ error: "invalid_request" }, 400, origin);
    }
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400, origin);
  }

  const serviceKey = secretKey();
  if (!PROJECT_URL || !serviceKey) {
    console.error("Missing Supabase server configuration.");
    return jsonResponse({ error: "server_not_configured" }, 500, origin);
  }

  try {
    const rpcHeaders: Record<string, string> = {
      apikey: serviceKey,
      "Content-Type": "application/json",
    };
    if (!serviceKey.startsWith("sb_secret_")) {
      rpcHeaders.Authorization = `Bearer ${serviceKey}`;
    }

    let userId: string | null = null;
    const authorization = request.headers.get("Authorization");
    if (authorization) {
      const userResponse = await fetch(`${PROJECT_URL}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: authorization },
        signal: AbortSignal.timeout(5000),
      });
      if (!userResponse.ok) {
        if (userResponse.status === 401 || userResponse.status === 403) {
          return jsonResponse({ error: "invalid_session" }, 401, origin);
        }
        return jsonResponse({ error: "auth_unavailable" }, 503, origin, { "Retry-After": "3" });
      }
      const user = await userResponse.json();
      if (typeof user.id !== "string") return jsonResponse({ error: "invalid_session" }, 401, origin);
      userId = user.id;
    }

    const rpcResponse = await fetch(`${PROJECT_URL}/rest/v1/rpc/increment_counter_backend`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ request_id: input.request_id, click_amount: input.amount, click_user_id: userId }),
      signal: AbortSignal.timeout(8000),
    });
    const rpcBody = await rpcResponse.json().catch(() => null);

    if (!rpcResponse.ok) {
      if (rpcBody?.code === "22023") return jsonResponse({ error: "request_conflict" }, 409, origin);
      console.error("Counter RPC failed:", rpcResponse.status, rpcBody?.code);
      return jsonResponse({ error: "counter_unavailable" }, 503, origin, { "Retry-After": "3" });
    }

    const result = Array.isArray(rpcBody) ? rpcBody[0] : rpcBody;
    if (!result || typeof result.new_value !== "string") {
      console.error("Counter RPC returned an invalid response.");
      return jsonResponse({ error: "invalid_counter_response" }, 502, origin);
    }

    return jsonResponse(
      { new_value: result.new_value, changed_at: result.changed_at, user_clicks: result.user_clicks },
      200,
      origin,
    );
  } catch (error) {
    console.error("Unexpected increment error:", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "counter_unavailable" }, 503, origin, { "Retry-After": "3" });
  }
});
