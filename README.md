# Railway Spinner

A small control panel that spins containers up and down on Railway through Railway’s public GraphQL API. You pick a Docker image, it creates a service and deploys it; each container then gets a switch to spin it down or back up, plus a delete action.

## How it works

```
Browser (public/)  ──fetch──▶  Express (server.js)  ──GraphQL──▶  backboard.railway.com/graphql/v2
   UI + polling                 validation, auth,                 (src/railway.js)
                                project ownership checks
```

The browser never sees the Railway token. All GraphQL calls happen server-side in `src/railway.js`, and the Express layer validates input, checks that a service belongs to the configured project before mutating it, and refuses to touch the panel’s own service.

| UI action | Endpoint | Railway operation |
|---|---|---|
| Load project | `GET /api/project` | `project(id)` with environments, services, `latestDeployment` |
| Spin up (new) | `POST /api/services` | `serviceCreate` with `source.image`, then optional `serviceDomainCreate` |
| Spin up (existing) | `POST /api/services/:id/start` | `serviceInstanceDeployV2` |
| Spin down | `POST /api/services/:id/stop` | `deploymentRemove` on the latest deployment |
| Delete | `DELETE /api/services/:id` | `serviceDelete` |

“Spin down” removes the running deployment but keeps the service and its config, so it can be spun up again. “Delete” removes the service entirely.

The UI polls every 3 seconds while anything is building or stopping, and every 15 seconds otherwise. Deployment statuses are collapsed into five states (running, spinning up, spinning down, failed, stopped) in `stateOf()` in `server.js`.

## Run locally

```bash
cp .env.example .env     # fill in RAILWAY_API_TOKEN and TARGET_PROJECT_ID
npm install
npm run dev              # http://localhost:3000
```

Create a token at https://railway.com/account/tokens. An account or workspace token is sent as `Authorization: Bearer`. To use a project token instead, set `RAILWAY_TOKEN_KIND=project` and it’s sent as `Project-Access-Token`.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Under the service’s **Variables**, add `RAILWAY_API_TOKEN` and `APP_PASSWORD`.
4. Under **Settings → Networking**, generate a domain.
5. Open the URL, enter the password, and spin up `nginx:alpine` on port 80.

Or with the CLI: `railway init`, `railway up`, `railway variables --set RAILWAY_API_TOKEN=... --set APP_PASSWORD=...`, `railway domain`.

On Railway, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_SERVICE_ID` are injected automatically, so the app manages containers in its own project and recognises itself in the list. Set `TARGET_PROJECT_ID` to point it at a different project.

`railway.json` sets the start command, a health check on `/api/health`, and restart-on-failure.

## Design decisions

**Token stays on the server.** A Railway token can create billable infrastructure, so the browser talks only to this app’s own API.

**Password gate.** The deployed URL is public. `APP_PASSWORD` is compared with `crypto.timingSafeEqual`, and the UI asks for it once per browser session.

**Ownership check before every mutation.** `serviceDelete` takes any service ID the token can reach. `loadOwnedService()` confirms the ID belongs to the configured project first, so the app can’t be used to delete services elsewhere in the account.

**Self-protection.** The panel’s own service shows in the list but its switch and delete are disabled, both in the UI and on the server.

**Input validation.** Service names, image references, ports and variable names are validated server-side before anything reaches Railway.

**Port handling.** When a public port is given, the app sets `PORT` on the service and creates a domain with `targetPort`, so Railway’s proxy routes to where the container listens.

**No build step.** Vanilla JS and one dependency (Express) keep the code easy to read in review.

## What I’d add next

Replace polling with Railway’s GraphQL subscriptions for live deployment status; show deployment logs per container; add replica scaling through `serviceInstanceUpdate`; tag services created by the app so the list can be filtered to them; and add tests around `server.js` with the Railway client mocked (the logic was verified this way during development).
