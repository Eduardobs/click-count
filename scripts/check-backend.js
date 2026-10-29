import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';

const origin = 'https://eduardobs.github.io';
let failed = false;
async function check(label, run) {
  try {
    await run();
    console.log(`OK: ${label}`);
  } catch (error) {
    failed = true;
    console.error(`ERRO: ${label}: ${error.message}`);
  }
}
await check('CORS dos cliques autenticados', async () => {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/increment-counter`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'apikey,content-type,authorization',
    },
  });
  if (!response.ok) throw new Error(`preflight retornou HTTP ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== origin) {
    throw new Error('a origem do GitHub Pages não está autorizada');
  }
  const headers = (response.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map(value => value.trim());
  for (const header of ['apikey', 'content-type', 'authorization']) {
    if (!headers.includes(header)) throw new Error(`cabeçalho ${header} não permitido; publique a versão atual de increment-counter`);
  }
  const methods = (response.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim().toUpperCase());
  if (!methods.includes('POST')) throw new Error('método POST não permitido');
});
await check('Ranking público', async () => {
  // This RPC only reads the leaderboard; no clicks or user data are modified.
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/click_leaderboard`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}; aplique a migração de contas e ranking no projeto correto`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('resposta inválida');
});
process.exitCode = failed ? 1 : 0;
