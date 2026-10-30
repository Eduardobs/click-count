import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../supabase/functions/increment-counter/index.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
let handler;
globalThis.Deno = {
  env: { get: name => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[name] },
  serve: value => { handler = value; },
};
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
after(() => { delete globalThis.Deno; });

const requestId = '11111111-1111-4111-8111-111111111111';
function request(authorization, body = JSON.stringify({ request_id: requestId, amount: 1 })) {
  return new Request('https://test.supabase.co/functions/v1/increment-counter', {
    method: 'POST', headers: { Origin: 'http://localhost:8080', ...(authorization ? { Authorization: authorization } : {}) }, body,
  });
}
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
test('anonymous clicks remain public and ignore a forged user ID', async () => {
  await withFetch(async (url, options) => {
    assert.match(url, /rpc\/increment_counter_backend$/);
    assert.deepEqual(JSON.parse(options.body), { request_id: requestId, click_amount: 1, click_user_id: null });
    return Response.json([{ new_value: '7', user_clicks: null }]);
  }, async () => {
    const response = await handler(request(null, JSON.stringify({ request_id: requestId, amount: 1, click_user_id: 'forged' })));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).new_value, '7');
  });
});
test('authenticated clicks use the identity returned by Auth', async () => {
  let calls = 0;
  await withFetch(async (url, options) => {
    calls += 1;
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.Authorization, 'Bearer valid');
      return Response.json({ id: 'verified-user' });
    }
    assert.deepEqual(JSON.parse(options.body), { request_id: requestId, click_amount: 1, click_user_id: 'verified-user' });
    return Response.json([{ new_value: '8', user_clicks: '3' }]);
  }, async () => {
    const response = await handler(request('Bearer valid', JSON.stringify({ request_id: requestId, amount: 1, click_user_id: 'forged' })));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user_clicks, '3');
    assert.equal(calls, 2);
  });
});
test('invalid sessions cannot increment the counter', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return Response.json({}, { status: 401 }); }, async () => {
    const response = await handler(request('Bearer invalid'));
    assert.equal(response.status, 401);
    assert.equal(calls, 1);
  });
});
test('CORS preflight permits authorization from allowed origins only', async () => {
  const response = await handler(new Request('https://test/', {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' },
  }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /authorization/);
  const denied = await handler(new Request('https://test/', {
    method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' },
  }));
  assert.equal(denied.status, 403);
});

test('GitHub Pages preflight accepts authenticated click headers', async () => {
  const response = await handler(new Request('https://test/', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://eduardobs.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'apikey,content-type,authorization',
    },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://eduardobs.github.io');
  const allowed = response.headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map(value => value.trim());
  for (const header of ['apikey', 'content-type', 'authorization']) assert.ok(allowed.includes(header));
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('malformed and oversized batches are rejected before accessing Auth or the database', async () => {
  await withFetch(() => { throw new Error('Unexpected upstream request'); }, async () => {
    for (const body of ['{}', 'null', '{', ...[0, -1, 51, 1.5, '2'].map(amount => JSON.stringify({ request_id: requestId, amount })), JSON.stringify({ request_id: 'forged', amount: 1 })]) {
      assert.equal((await handler(request(null, body))).status, 400);
    }
    assert.equal((await handler(request(null, 'x'.repeat(1025)))).status, 413);
  });
});
test('valid batches preserve their id and amount on repeated requests', async () => {
  await withFetch(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { request_id: requestId, click_amount: 50, click_user_id: null });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json([{ new_value: '50', user_clicks: null }]);
  }, async () => {
    for (let i = 0; i < 2; i++) {
      assert.equal((await handler(request(null, JSON.stringify({ request_id: requestId, amount: 50 })))).status, 200);
    }
  });
});
test('Auth outages are retryable and do not increment', async () => {
  await withFetch(async url => {
    assert.ok(url.endsWith('/auth/v1/user'));
    return Response.json({}, { status: 503 });
  }, async () => {
    const response = await handler(request('Bearer valid'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '3');
  });
});
test('database conflicts and transient failures have distinct responses', async () => {
  for (const [code, status] of [['22023', 409], ['55P03', 503]]) {
    await withFetch(async () => Response.json({ code }, { status: 400 }), async () => {
      const response = await handler(request());
      assert.equal(response.status, status);
      if (status === 503) assert.equal(response.headers.get('Retry-After'), '3');
    });
  }
});
