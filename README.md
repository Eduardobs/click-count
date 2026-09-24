# One More

An application that counts clicks.

A shared, responsive counter updated in real time. The front end is static and
can be served by GitHub Pages; shared state is stored in Supabase.

## Why is a data service needed?

GitHub Pages only hosts static files. For all visitors to see and change the
same number, an external service is required. In this project:

- the database increments the value atomically, preventing lost clicks;
- the browser can only read the counter and call the `+1` operation;
- updates reach every tab through Realtime;
- the value is stored as text and incremented digit by digit, without the
  64-bit precision limit of JavaScript's `Number`.

## Configuration

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard, open **SQL Editor**, paste the contents of
   `supabase/setup.sql`, and run it once.
3. Under **Project Settings → API**, copy the project URL and public key
   (`anon` / `publishable`).
4. Set both values in `config.js`:

   ```js
   export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   export const SUPABASE_ANON_KEY = "YOUR-PUBLIC-KEY";
   ```

The key used by the browser is public by definition. Security does not depend
on hiding it: the SQL enables RLS, blocks direct writes to the table, and only
exposes the function that adds exactly one to the counter.

## Run locally

ES modules must be served over HTTP. Use any static server, for example:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. To run the display utility tests:

```bash
npm test
```

## Publish on GitHub Pages

In the repository's **Settings → Pages**:

1. choose **Deploy from a branch**;
2. select the `main` branch and the `/ (root)` folder;
3. save and wait for the published address.

There is no build step. `index.html`, CSS, and JavaScript are published
directly.

## Security note

The increment is protected against direct value changes, but the counter is
public: anyone can click or automate calls to the operation. For a campaign at
risk of abuse, enable rate limiting/CAPTCHA in an Edge Function and have the
front end call that function instead of the public RPC.
