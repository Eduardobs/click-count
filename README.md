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
