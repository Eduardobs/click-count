# One More

An application that counts clicks.

A shared, responsive counter updated in real time. The front end is static and
can be served by GitHub Pages; shared state is stored in Supabase.

## Why is a data service needed?

GitHub Pages only hosts static files. For all visitors to see and change the
same number, an external service is required. In this project:

- the database increments the value atomically, preventing lost clicks;
- the browser can read the counter and call a public Edge Function;
- only the Edge Function can execute the privileged database increment;
- updates reach every tab through Realtime;
- the value is stored as text and incremented digit by digit, without the
  64-bit precision limit of JavaScript's `Number`.

## Configuration

The original database setup has already been applied to this project and is no
longer stored in the repository. Apply the security migration and deploy the
public Edge Function with:

```bash
npx supabase login
npx supabase link --project-ref kmbtkszxonrkozgotqrf
npx supabase db push
npx supabase functions deploy increment-counter
```

The hosted Edge Function receives server credentials from Supabase itself. Do
not put a secret or `service_role` key in this repository.

For a different project, set its URL and publishable key in `config.js`:

```js
export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "YOUR-PUBLIC-KEY";
```

Also update the Supabase origin in `index.html` and `_headers`. If the site uses
a different public origin, set the Edge Function secret `ALLOWED_ORIGINS` to a
comma-separated list of allowed origins.

The browser key is public by definition. Security depends on RLS and database
permissions, not on hiding this key.

## Run locally

Install the locked dependencies and build the self-hosted browser bundle:

```bash
npm ci
npm run build
```

The files must be served over HTTP. Use any static server, for example:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. To run all local checks:

```bash
npm run check
```

## Publish on GitHub Pages

In the repository's **Settings → Pages**:

1. choose **Deploy from a branch**;
2. select the `master` branch and the `/ (root)` folder;
3. save and wait for the published address.

Commit the generated `app.bundle.js` before publishing. GitHub Pages serves
`index.html`, CSS, and the bundle directly from the branch.

The `_headers` file provides CSP, anti-framing, MIME-sniffing, referrer, and
permissions policies on hosts that support this convention, such as Cloudflare
Pages. GitHub Pages ignores custom response headers, so the application also
contains a JavaScript anti-framing fallback. For header-level clickjacking
protection, publish through a host or proxy that applies `_headers`.

## Security note

Direct table writes and direct browser execution of the privileged RPC are
blocked. The Edge Function remains intentionally public and unrestricted: no
account, per-IP limit, or CAPTCHA is required. Consequently, anyone can still
automate increments and consume project quota. This is an explicit product
tradeoff rather than an authentication boundary.
