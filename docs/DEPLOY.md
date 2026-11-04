# Deploying Axys for Meta

Goal: a public HTTPS address so (a) merchants and judges can open the Studio and the published campaign sites at `https://<domain>/sites/<id>`,
and (b) Instagram can download the reel and redirect back after sign-in. Everything runs from `compose.yaml`: a Python gateway (holds
`MODEL_API_KEY`), the Node app (Studio, API, FFmpeg, SQLite on a volume) and Caddy (automatic HTTPS). Only Caddy is exposed to the internet.

Not verified here: see "Status" at the bottom.

## What you need (nothing here has been created or paid for on your behalf)

| Item | Notes |
|---|---|
| A Linux server | Any provider (AWS Lightsail/EC2, DigitalOcean, Hetzner, GCP, ...). At least 2 vCPU, 4 GB RAM, 20 GB disk. Renders use FFmpeg and image processing. Ports 80 and 443 open. Check current provider pricing yourself. |
| Docker + Compose on it | `curl -fsSL https://get.docker.com | sh` (read the script first if you prefer) |
| A domain name | An A record pointing at the server's IP. No domain? A wildcard-DNS name such as `<server-ip>.sslip.io` may work with Caddy's automatic certificates (not tested here). |
| Your `MODEL_API_KEY` | Meta Model API key. |
| (Later) Instagram app settings | See `node scripts/publish-readiness.mjs`. Not needed just to open the Studio and publish websites. |

## Steps

```bash
git clone <your public repo url> axys && cd axys

# 1. secrets (prints three env lines and your Studio login key once)
node scripts/make-keys.mjs demo        # or: docker run --rm -v "$PWD":/w -w /w node:22-slim node scripts/make-keys.mjs demo

# 2. production settings
cp .env.production.example .env.production      # paste AXYS_ACCESS_KEYS, AXYS_TOKEN_KEY, AXYS_MEDIA_KEY from step 1
printf 'MODEL_API_KEY=...\nDOMAIN=your.domain.example\n' > .env

# 3. go
docker compose up -d --build
docker compose logs -f axys
```

Open `https://your.domain.example`, choose the Studio, and sign in with the login key printed in step 1 (production disables the `local-demo` key).
`AXYS_STARTER_CREDITS` in `.env.production` sets each workspace's one-time allowance of Axys credits (a Both-mode generation costs 4).

## Easier: a container platform (Render, Railway, Fly.io and similar)

Vercel and other serverless platforms cannot run Axys: renders take 1 to 2 minutes, FFmpeg must be installed, SQLite needs a disk that persists, and there is
a Python service. A platform that runs a normal container with a persistent volume can. The last stage of the `Dockerfile` (`all`) is a single container that runs
the gateway (loopback only) and the app together, listens on the platform's `$PORT` and needs no Caddy, because the platform terminates HTTPS.

1. Push the repository to GitHub (public, as the hackathon requires).
2. On the platform, create a new service from that repository using the Dockerfile (no build target needed: the default last stage is the single-container one).
3. Attach a persistent disk or volume mounted at `/data` (without it, data is lost whenever the service restarts, which is acceptable for a short demo but not for real use).
4. Set these environment variables (generate three of them with `node scripts/make-keys.mjs demo`):
   `MODEL_API_KEY`, `AXYS_ACCESS_KEYS`, `AXYS_TOKEN_KEY`, `AXYS_MEDIA_KEY`, `AXYS_ORIGIN` (the public https address the platform gives you, e.g. `https://yourapp.example.app`),
   `AXYS_TRUST_PROXY=1`, `AXYS_STARTER_CREDITS=50`.
5. Health check path: `/health`. Give it at least 2 GB of memory (4 GB is safer); renders are the heavy part.
6. After the first deploy the platform shows the public address. If you did not know it beforehand, set `AXYS_ORIGIN` to it and redeploy.
   Open it, sign in with the login key from step 4.

Instagram posting, once you set it up, needs the Instagram variables listed below and the sign-in redirect `AXYS_ORIGIN/api/v1/oauth/callback` registered in your Meta app.

## Turning on Instagram posting (only when you are ready)

1. In your Meta app (Instagram API with Instagram Login): add your professional Instagram account as a tester; add
   `https://your.domain.example/api/v1/oauth/callback` as a valid OAuth redirect URI.
2. Fill `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION` (format `vNN.0`), `META_REDIRECT_URI` (the same callback URL),
   `META_INSIGHT_METRICS` (e.g. `reach,likes,saves`) in `.env.production`, then `docker compose up -d`.
3. Check with `node scripts/publish-readiness.mjs .env.production`.
4. In the Studio, Publish stage: connect the Instagram account. Posting stays blocked until you set `AXYS_ALLOW_PUBLIC_POSTING=true`;
   do that only for one test post with throwaway content.

## Operating it

- Data (SQLite, uploaded photos, renders) lives in the `axys-data` Docker volume. Back it up: `docker run --rm -v axys-data:/data -v "$PWD":/b alpine tar czf /b/axys-data.tgz /data`.
- Update: `git pull && docker compose up -d --build`.
- One instance only: storage is a single-node SQLite database.
- The gateway has no published port; nothing outside the Compose network can reach it or your Meta key.

## Status

Verified on a development PC (Windows, Docker Desktop), 4 Nov 2026:
- `docker build` of all targets succeeds (including the single-container `all` image, about 1 minute); run as a platform would (`PORT=8080`, gateway inside),
  the demo key is rejected, a generated key logs in, Muse is reachable, the Studio page loads;
- `docker build` of both compose targets succeeds (gateway image about 40 s, app image about 2 m 17 s, including the Studio build).
- `docker compose up` with `DOMAIN=localhost`: all three services healthy; HTTPS through Caddy (its local certificate); the `local-demo` key is rejected,
  a key from `scripts/make-keys.mjs` logs in; the app container reaches the gateway container and Muse is reported reachable; no errors in the logs.
- A full live campaign through the containers (enrich with SAM, Spark and Muse Image, Wonder planning, FFmpeg film reel with Anton and Liberation fonts,
  preflight, stale-price block) produced the same quality of reel as the local run.

Not verified (needs a real public server):
- Caddy obtaining a real Let's Encrypt certificate for your domain, and DNS.
- Instagram downloading the reel from your address and the OAuth redirect.
- Behaviour with the provider's firewall, RAM limits and disk.
