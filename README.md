# One More

One More is a simple shared counter. Every click adds one to the total, and
the updated number appears for everyone using the app.

## What is it for?

The project is a small experiment in participation: people can visit the page,
click the button, and help make one shared number grow. It works on phones,
tablets, and computers.

## How it works

- Open the page and click the button.
- The total increases immediately.
- Everyone viewing the page sees the same total.
- The counter keeps working even when many people are using it at once.

## Run it on your computer

If you want to try the project locally:

1. Install the project's dependencies with `npm ci`.
2. Start the development server with `npm run dev`.
3. Open `http://localhost:8080` in your browser.

The development server rebuilds the application bundle when source files change.

To run the project's checks, use `npm run check`.

## Publish the app

The app can be published with GitHub Pages:

1. Open the repository's **Settings → Pages**.
2. Choose **Deploy from a branch**.
3. Select the `master` branch and the `/ (root)` folder.
4. Save the settings and wait for the public page to become available.

Before publishing, make sure the generated `app.bundle.js` file has been
created and committed.

## Notes

The shared total is stored online so that all visitors can see and update the
same number. The public counter does not require an account. Optional sign-in lets participants
save their own clicks and appear in the ranking. This also means that anyone can add clicks automatically or repeatedly.

## Optional accounts and ranking

Anonymous clicks remain public and contribute to the shared total. Only clicks
made while signed in contribute to the user's ranking. Earlier anonymous clicks
are never reassigned. The public ranking exposes only an alias and click count.
Social accounts use the default alias “Participante” to avoid automatically
publishing the real name supplied by a provider.

Before releasing this version:

1. Apply `supabase/migrations/20261029000000_optional_accounts.sql` with
   `supabase db push` against the existing linked project.
2. Deploy `supabase functions deploy increment-counter`. JWT verification at the
   gateway remains disabled for public clicks; the function validates any supplied
   session with Supabase Auth before associating a click with a user.
3. In Supabase Auth, enable email/password and disable **Confirm email** to allow immediate
   sign-in after registration, as requested. The local configuration sets
   `auth.email.enable_confirmations = false`; apply the same setting in the
   hosted project dashboard. Configure SMTP for recovery emails, and enable leaked password protection
   where supported. Set the minimum password length to 12 or higher.
4. Enable Google, Facebook, and X / Twitter (OAuth 2.0) under Auth → Sign In / Providers. Create
   each provider's OAuth app and enter its client ID and secret **only in the
   Supabase dashboard**, never in frontend code. Use the callback URL shown there
   (`https://kmbtkszxonrkozgotqrf.supabase.co/auth/v1/callback`). Instagram is not a
   built-in Supabase login provider and is not offered as a working login option.
5. Set Auth's Site URL to the production app URL, and allow its exact redirect URL
   (including the GitHub Pages repository path). Allow localhost only for development.
6. Run `npm run check` and publish the static files, including `app.bundle.js`.

Authentication uses the official Supabase SDK with PKCE. Passwords are submitted
directly to Supabase Auth and cleared from the form after submission. The app does
not store passwords, OAuth client secrets, or service keys. Session credentials
are retained in the current tab's session storage (a browser may restore this
storage when restoring a previous session), with provider API tokens
removed before storage. Supabase Auth necessarily holds account identity data
and password hashes for email accounts; this is separate from the ranking table.
The database denies direct reads/writes to ranking profiles and permits increments
only through the server role. Logging out revokes the session and removes local
session data. Existing CSP and frame restrictions remain in effect.

Account access opens in a native modal with separate login and signup modes.
With email confirmation disabled, registration also signs the user in immediately.
If the hosted project still requires confirmation, the modal explains that
requirement rather than claiming the user is authenticated. Disabling confirmation
means ownership of an email address is not verified during registration.

## Troubleshooting CORS and missing ranking

If the browser reports `authorization is not allowed by Access-Control-Allow-Headers`
while `click_leaderboard` returns 404, check that the backend changes were deployed,
not just the GitHub Pages frontend. The current Edge Function permits the
Authorization header. An older deployed function permits only `apikey, content-type`.

Against the linked project `kmbtkszxonrkozgotqrf`, run:

```sh
supabase login
supabase db push
supabase functions deploy increment-counter --project-ref kmbtkszxonrkozgotqrf
npm run check:backend
```

Without the CLI, run `supabase/migrations/20261029000000_optional_accounts.sql`
in the project's SQL Editor (once), then replace the `increment-counter` source
with `supabase/functions/increment-counter/index.ts` in Edge Functions and deploy.
Keep gateway JWT verification disabled for this public endpoint; supplied session
tokens are validated inside the function. Never put server credentials in the browser.

`check:backend` performs a preflight and reads the public leaderboard without
incrementing the counter. Run it after backend deployments. A passing local test
or frontend build does not verify the function deployed in Supabase. If the migration
was already applied but the RPC is missing from the API schema cache, execute
`NOTIFY pgrst, 'reload schema';` in SQL Editor and retry the backend check.

## Concurrent clicks and integrity (2026-10-30)

The browser batches up to 50 pending clicks from the same identity, sends one
request at a time, and keeps the same random UUID and amount on every retry.
The queue holds at most 1,000 clicks and pauses the button when full. Retries use
exponential backoff with jitter and respect `Retry-After`. Pending clicks still
live only in the current page: closing/reloading the page loses unsent clicks.

The Edge Function accepts at most 1 KiB of JSON, validates UUIDs and batch sizes,
checks supplied sessions with Auth, and bounds upstream request times. It never
trusts a client-provided user ID. Server credentials stay on the server.

The new migration freezes the existing total as a baseline and spreads new
increments across 64 private rows. Each batch updates its receipt, the participant's
ranking count, and exactly one counter shard in the same transaction. Concurrent
requests from the same participant still serialize on that participant's profile;
other participants no longer all wait on the global counter row. The existing
ranking index supports the top-20 query. Global and personal counts use exact
PostgreSQL numeric arithmetic and travel as strings, without JavaScript precision loss.

A unique receipt prevents duplicate increments, including after a committed
transaction whose HTTP response was lost. Reusing an ID with another identity or
amount is rejected. Receipts are retained permanently; **do not delete receipts**
without first implementing an expiry protocol that also rejects expired requests.
Monitor their storage/index growth. They contain only UUIDs, user IDs and amounts.

Reads sum the 64 shards and the baseline in one database snapshot. Mutation
responses may be overtaken by concurrent commits; the UI never decreases a shown
total and converges on its next read. The authoritative data remains transactional;
separate counter/ranking HTTP reads are not a single shared snapshot.

The old per-click Postgres Changes subscription is replaced by one total read per
visible tab every 2–3 seconds, independent of the global write rate. Ranking reads
run every 20–25 seconds, with manual refresh limited to once per five seconds.
Both stop in hidden tabs, avoid overlapping requests, and have request timeouts.
This avoids the per-subscriber checks for every mutation described in
[Supabase's scaling documentation](https://supabase.com/docs/guides/realtime/postgres-changes#database-instance-and-realtime-performance).
Read load still grows with active clients; very large audiences may require a
shared cached snapshot or scheduled Broadcast layer, sized against measured traffic.

### Deploy this protocol change

This is a coordinated backend/frontend upgrade. Old pages send `{}` and are not
compatible with the new endpoint; arrange a maintenance window and ask users to
finish pending clicks and reload after publication. Never let old and new mutation
functions write to different totals.

1. Apply all pending migrations, including
   `supabase/migrations/20261030000000_scalable_counter.sql`, with `supabase db push`.
   It preserves the existing total/ranking and removes the old mutation signature.
2. Deploy `supabase functions deploy increment-counter`.
3. Run `npm run check`, publish the regenerated `app.bundle.js`, and reload clients.
4. Run `npm run check:backend` to verify the public total, ranking and preflight.
   This is read-only and does not prove mutation correctness or available capacity.

The original `counters` table is now a frozen legacy value; use `counter_total()`
for current totals. Do not roll back just the frontend/function after migration:
that would strand clients on the legacy protocol. No hosted deployment is performed
by the local build or tests.

### Validation and capacity

`npm test` includes the actual SQL migrations in PGlite (embedded PostgreSQL),
permission checks for public roles, exact large totals, replays, conflicting
identities/amounts, and rollback of profile/receipt/total on a simulated failure.
It also verifies queue limits, identity separation, request validation and retries.
PGlite serializes queries, so these are **not multi-connection load tests**.

Before claiming a concurrent-client capacity, use an isolated Supabase staging
project with the deployed migrations and function. Send batches with distinct
UUIDs from many clients, concurrently replay some identical UUIDs, and verify that
the total grows by the sum of unique accepted batches and each profile by its own
unique signed-in batches. Include lost responses, lock timeouts, Auth outages and
account deletion; sample the ranking during writes. Measure p95/p99 latency,
503/429 rates, database CPU/locks, Auth throughput and receipt growth against the
intended traffic and hardware. No numerical capacity is asserted by this change.

Public anonymous clicking remains intentionally available. CORS and batch limits
are not bot protection or a server-side rate quota; callers can create new UUIDs.
For adversarial traffic, configure ingress rate limits/bot challenges before a
public launch at scale. This requires a product-specific quota and infrastructure;
client queue bounds alone cannot protect the service from distributed abuse.
