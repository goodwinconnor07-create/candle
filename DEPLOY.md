# Deploying the candle's backend

The site (`public/index.html`) works with no backend at all — sharing falls
back to a link that encodes the whole candle, which syncs but can't show a
blow-out. Deploying the Worker below upgrades sharing to a live one, where
blowing it out actually shows up on your friend's screen. Everything's
written and tested; this is what's left, and it's about ten minutes.

## Why you, and not me

This needs a Cloudflare account and a login. That's an OAuth flow through
your browser — I have no access to your browser, email, or the ability to
accept Cloudflare's terms on your behalf, so there's no way to script around
this part. Once it's deployed, though, updates are one command and I can
walk you through those too.

## 1. Create a Cloudflare account (skip if you have one)

Go to https://dash.cloudflare.com/sign-up and sign up. Free tier is enough
for this — the whole app fits comfortably inside it.

## 2. Log in from this machine

From the `candle` project folder:

```
npx wrangler login
```

This opens a browser tab and asks you to approve access. Approve it, then
come back to the terminal.

## 3. Create the KV namespace

This is the storage the candles live in:

```
npx wrangler kv namespace create CANDLES
```

It prints something like:

```
🌀 Creating namespace with title "candle-timer-CANDLES"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "CANDLES"
id = "a1b2c3d4e5f6..."
```

Copy that `id` value.

## 4. Put the id in `wrangler.toml`

Open `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with the id
you just copied. That's the only edit this whole process needs.

## 5. Deploy

```
npx wrangler deploy
```

It prints a URL — something like `https://candle-timer.<you>.workers.dev`.
That's the app, live, with the backend wired up. Open it, light a candle,
and the "send to someone" panel will start handing out real links.

## Checking it worked

Light a candle, open the share panel, hit **Copy link**, and check the note
under it says *"They'll see if you stop it early, too."* — that's the
Worker responding. If it instead says it couldn't reach the server, the
deploy didn't go through; rerun `npx wrangler deploy` and check for errors.

## Custom domain (optional)

If you want this on your own domain instead of `*.workers.dev`, Cloudflare's
dashboard → your Worker → Settings → Domains & Routes lets you attach one
you already manage through Cloudflare. Not required for any of the above.

## Making a change later

Edit `worker.js` or anything in `public/`, then run `npx wrangler deploy`
again. Same command every time; there's no separate build step.

## What's actually running

One Worker, one KV namespace. No database to manage, nothing to patch, no
server that can go down from lack of attention — Cloudflare runs it.
Records expire on their own after 7 days, so there's nothing to clean up
either.
