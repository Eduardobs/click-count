const PROJECT_URL = Deno.env.get("SUPABASE_URL");
const DEFAULT_ALLOWED_ORIGINS = [
  "https://eduardobs.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

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

function allowedOrigins(): Set<string> {
  const configured = Deno.env.get("ALLOWED_ORIGINS");
  const origins = configured
    ? configured.split(",").map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;
  return new Set(origins);
}

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && allowedOrigins().has(origin)) {
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
    if (!origin || !allowedOrigins().has(origin)) {
      return jsonResponse({ error: "origin_not_allowed" }, 403, origin);
    }
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin, { Allow: "POST" });
  }

  if (origin && !allowedOrigins().has(origin)) {
    return jsonResponse({ error: "origin_not_allowed" }, 403, origin);
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

    const rpcResponse = await fetch(`${PROJECT_URL}/rest/v1/rpc/increment_counter_backend`, {
      method: "POST",
      headers: rpcHeaders,
      body: "{}",
    });
    const rpcBody = await rpcResponse.json().catch(() => null);

    if (!rpcResponse.ok) {
      console.error("Counter RPC failed:", rpcResponse.status, rpcBody?.code);
      return jsonResponse({ error: "counter_unavailable" }, 503, origin);
    }

    const result = Array.isArray(rpcBody) ? rpcBody[0] : rpcBody;
    if (!result || typeof result.new_value !== "string") {
      console.error("Counter RPC returned an invalid response.");
      return jsonResponse({ error: "invalid_counter_response" }, 502, origin);
    }

    return jsonResponse(
      { new_value: result.new_value, changed_at: result.changed_at },
      200,
      origin,
    );
  } catch (error) {
    console.error("Unexpected increment error:", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "counter_unavailable" }, 503, origin);
  }
});
