# Deploying

The app is already live at https://candle-timer.candle-timer.workers.dev.
This is what's involved if you ever need to do it again from scratch, or from
a different machine.

## Making a change

Edit `worker.js` or `public/index.html`, then:

```
npx wrangler deploy
```

The front end is plain HTML with no build step, and the Worker has no
dependencies beyond its own game files. The Durable Object bindings and
migrations are in `wrangler.toml` (`v2` added the `JoinCode` class for
6-digit join codes), and `wrangler deploy` applies them itself. No API keys
or secrets are needed.

## From a fresh machine

You need to be logged in to Cloudflare first:

```
npx wrangler login
```

That opens a browser tab to approve access. If you're somewhere that can't
open a browser (a remote shell, a container), that flow times out — use an API
token instead. Create one at **dash.cloudflare.com → your profile → API
Tokens** with the "Edit Cloudflare Workers" template, then:

```
CLOUDFLARE_API_TOKEN=your-token npx wrangler deploy
```

## Testing before you deploy

```
npx wrangler dev
```

This runs a real Durable Object locally on http://localhost:8787. Open it in
two browser windows — one normal, one private, so they don't share the same
saved seat — and you can play a full match against yourself. Or pick
**Practice** to play solo against a stand-in.

## What's actually running

One Worker and one Durable Object per match, plus a tiny one per join code
that's been handed out. No database, no KV, nothing to
clean up: each room deletes itself a day after its last activity, and the
free tier covers all of this comfortably.

If you want this on your own domain instead of `*.workers.dev`, it's
Cloudflare's dashboard → your Worker → Settings → Domains & Routes.
