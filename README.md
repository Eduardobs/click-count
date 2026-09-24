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
same number. The app does not require accounts or sign-in, which keeps it easy
to use. This also means that anyone can add clicks automatically or repeatedly.
