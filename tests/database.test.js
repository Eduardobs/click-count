import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const accountMigration = await readFile(new URL('../supabase/migrations/20261029000000_optional_accounts.sql', import.meta.url), 'utf8');
const scaleMigration = await readFile(new URL('../supabase/migrations/20261030000000_scalable_counter.sql', import.meta.url), 'utf8');
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const baseline = '999999999999999999999999999999999999999999';

async function database() {
  const db = new PGlite();
  // The original provisioned schema predates the repository migrations.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table public.counters (id text primary key, value text, updated_at timestamptz);
    insert into public.counters values ('main', '${baseline}', now());
    create function public.increment_counter_backend() returns void language sql as 'select';
    insert into auth.users values ('${user}', '{"display_name":"Alice"}');
  `);
  await db.exec(accountMigration);
  await db.exec(scaleMigration);
  return db;
}
async function total(db) { return (await db.query('select public.counter_total() as value')).rows[0].value; }
async function increment(db, id, amount = 1, userId = null) {
  return (await db.query('select * from public.increment_counter_backend($1::uuid, $2::integer, $3::uuid)', [id, amount, userId])).rows[0];
}

test('migration preserves large totals; batches and retries keep ranking consistent', async () => {
  const db = await database();
  try {
    assert.equal(await total(db), baseline);
    const id = crypto.randomUUID();
    const result = await increment(db, id, 50, user);
    assert.equal(result.new_value, (BigInt(baseline) + 50n).toString());
    assert.equal(result.user_clicks, '50');
    await increment(db, id, 50, user); // Simulates a committed response lost in transit.
    assert.equal(await total(db), result.new_value);
    assert.deepEqual((await db.query('select * from public.click_leaderboard()')).rows, [{ display_name: 'Alice', clicks: '50' }]);
    await assert.rejects(increment(db, id, 1, user), /Request ID already used/);
    await assert.rejects(increment(db, id, 50, null), /Request ID already used/);
    await increment(db, crypto.randomUUID(), 3);
    assert.equal(await total(db), (BigInt(baseline) + 53n).toString());
    assert.equal((await db.query('select clicks::text from public.click_profiles')).rows[0].clicks, '50');
    assert.equal((await db.query('select sum(value)::text as value from private.counter_shards')).rows[0].value, '53');
  } finally { await db.close(); }
});

test('invalid inputs and failed transactions leave no partial counter, profile or receipt', async () => {
  const db = await database();
  try {
    for (const amount of [0, -1, 51, null]) await assert.rejects(increment(db, crypto.randomUUID(), amount));
    await assert.rejects(increment(db, crypto.randomUUID(), 1, crypto.randomUUID()), /Unknown user/);
    await db.exec(`
      create function private.fail_update() returns trigger language plpgsql as $$ begin raise exception 'Simulated failure'; end; $$;
      create trigger fail_update before update on private.counter_shards for each row execute function private.fail_update();
    `);
    const id = crypto.randomUUID();
    await assert.rejects(increment(db, id, 5, user), /Simulated failure/);
    assert.equal(await total(db), baseline);
    assert.equal((await db.query('select count(*)::int as n from public.click_profiles')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from private.click_requests')).rows[0].n, 0);
    await db.exec('drop trigger fail_update on private.counter_shards');
    assert.equal((await increment(db, id, 5, user)).user_clicks, '5');
  } finally { await db.close(); }
});

test('public roles can read totals and aliases but cannot mutate or inspect private data', async () => {
  const db = await database();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      assert.equal(await total(db), baseline);
      await db.query('select * from public.click_leaderboard()');
      await assert.rejects(increment(db, crypto.randomUUID()), /permission denied/);
      await assert.rejects(db.query('select * from private.click_requests'), /permission denied/);
      await assert.rejects(db.query('select * from public.click_profiles'), /permission denied/);
      await assert.rejects(db.query("update public.counters set value = '0'"), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await increment(db, crypto.randomUUID())).new_value, (BigInt(baseline) + 1n).toString());
  } finally { await db.close(); }
});

test('many distinct batches and replays preserve exact sums across shards', async () => {
  const db = await database();
  try {
    // PGlite serializes connections: this is an integrity regression, not a load benchmark.
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
    await Promise.all(ids.map(id => increment(db, id, 7, user)));
    await Promise.all(ids.map(id => increment(db, id, 7, user)));
    assert.equal(await total(db), (BigInt(baseline) + 1400n).toString());
    assert.equal((await db.query('select clicks::text from public.click_profiles')).rows[0].clicks, '1400');
    assert.equal((await db.query('select count(*)::int as n from private.click_requests')).rows[0].n, 200);
  } finally { await db.close(); }
});
