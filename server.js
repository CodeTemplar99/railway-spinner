const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const railway = require('./src/railway');

const PORT = Number(process.env.PORT) || 3000;
// Railway injects RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID / RAILWAY_SERVICE_ID
// into every deployment, so by default the app manages containers in its own project.
const PROJECT_ID = process.env.TARGET_PROJECT_ID || process.env.RAILWAY_PROJECT_ID;
const DEFAULT_ENV_ID = process.env.TARGET_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT_ID;
const SELF_SERVICE_ID = process.env.RAILWAY_SERVICE_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-\/:@]{0,254}$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const STATE = {
  running: ['SUCCESS', 'SLEEPING'],
  pending: ['QUEUED', 'WAITING', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'NEEDS_APPROVAL'],
  stopping: ['REMOVING'],
  failed: ['FAILED', 'CRASHED'],
};
function stateOf(status) {
  for (const [state, statuses] of Object.entries(STATE)) {
    if (statuses.includes(status)) return state;
  }
  return 'stopped'; // REMOVED, SKIPPED or no deployment yet
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Optional shared password. The deployed URL is public and holds a token that can
// create billable containers, so anything that touches the API sits behind it.
function requirePassword(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (safeEqual(req.get('x-app-password') || '', APP_PASSWORD)) return next();
  res.status(401).json({ error: 'Enter the app password to continue.', code: 'PASSWORD_REQUIRED' });
}

function requireProject(req, res, next) {
  if (PROJECT_ID) return next();
  res.status(500).json({
    error: 'No target project. Set TARGET_PROJECT_ID, or deploy on Railway so RAILWAY_PROJECT_ID is injected.',
  });
}

function resolveEnvironment(project, requested) {
  const envs = project.environments;
  if (requested) {
    const env = envs.find((e) => e.id === requested);
    if (!env) throw badRequest('That environment does not belong to this project.');
    return env;
  }
  return (
    envs.find((e) => e.id === DEFAULT_ENV_ID) ||
    envs.find((e) => e.name === 'production') ||
    envs[0]
  );
}

function shapeService(service, environmentId) {
  const instance = service.instances.find((i) => i.environmentId === environmentId);
  const deployment = instance?.latestDeployment || null;
  return {
    id: service.id,
    name: service.name,
    createdAt: service.createdAt,
    image: instance?.source?.image || null,
    repo: instance?.source?.repo || null,
    inEnvironment: Boolean(instance),
    isSelf: service.id === SELF_SERVICE_ID,
    deployment: deployment && {
      id: deployment.id,
      status: deployment.status,
      createdAt: deployment.createdAt,
      url: deployment.staticUrl ? `https://${deployment.staticUrl}` : null,
    },
    state: stateOf(deployment?.status),
  };
}

// Load the project and confirm the service belongs to it before any mutation.
// Without this check, anyone with the app password could pass an arbitrary
// service ID and act on any service the token can reach.
async function loadOwnedService(req) {
  const project = await railway.getProject(PROJECT_ID);
  const env = resolveEnvironment(project, req.body?.environmentId || req.query.environmentId);
  const service = project.services.find((s) => s.id === req.params.id);
  if (!service) throw Object.assign(new Error('Service not found in this project.'), { status: 404 });
  if (service.id === SELF_SERVICE_ID) {
    throw Object.assign(new Error('This is the control panel itself, so it cannot be changed from here.'), { status: 403 });
  }
  return { project, env, service: shapeService(service, env.id) };
}

// ---------- routes ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/session', (req, res) => {
  res.json({ passwordRequired: Boolean(APP_PASSWORD) });
});

const api = express.Router();
api.use(requirePassword, requireProject);

api.get('/project', asyncRoute(async (req, res) => {
  const project = await railway.getProject(PROJECT_ID);
  const env = resolveEnvironment(project, req.query.environmentId);
  res.json({
    project: { id: project.id, name: project.name },
    environments: project.environments,
    environmentId: env.id,
    services: project.services
      .map((s) => shapeService(s, env.id))
      .filter((s) => s.inEnvironment)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
}));

// Spin up a new container from a Docker image.
api.post('/services', asyncRoute(async (req, res) => {
  const { name, image, variables = {}, publicPort } = req.body || {};

  if (!NAME_RE.test(name || '')) {
    throw badRequest('Name must be 1–32 lowercase letters, numbers or hyphens, and cannot start or end with a hyphen.');
  }
  if (!IMAGE_RE.test(image || '')) throw badRequest('Enter a valid image reference, like nginx:alpine.');
  if (typeof variables !== 'object' || Array.isArray(variables)) throw badRequest('Variables must be key/value pairs.');
  for (const [k, v] of Object.entries(variables)) {
    if (!ENV_KEY_RE.test(k)) throw badRequest(`"${k}" is not a valid variable name.`);
    if (typeof v !== 'string' || v.length > 4096) throw badRequest(`The value of ${k} must be text under 4 KB.`);
  }
  let port = null;
  if (publicPort !== undefined && publicPort !== null && publicPort !== '') {
    port = Number(publicPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Port must be between 1 and 65535.');
  }

  const project = await railway.getProject(PROJECT_ID);
  const env = resolveEnvironment(project, req.body.environmentId);
  if (project.services.some((s) => s.name === name)) throw badRequest(`A service named ${name} already exists.`);

  // Railway reads PORT to know where the container listens; set it when exposing a port.
  const vars = port ? { PORT: String(port), ...variables } : variables;
  const service = await railway.createService({
    projectId: PROJECT_ID,
    environmentId: env.id,
    name,
    image,
    variables: vars,
  });

  let domain = null;
  if (port) {
    try {
      domain = await railway.createDomain({ serviceId: service.id, environmentId: env.id, targetPort: port });
    } catch (err) {
      // The container still exists; report the domain failure rather than failing the request.
      domain = { error: err.message };
    }
  }

  res.status(201).json({ service, domain });
}));

// Spin up an existing (stopped) service again.
api.post('/services/:id/start', asyncRoute(async (req, res) => {
  const { env, service } = await loadOwnedService(req);
  if (service.state === 'running' || service.state === 'pending') {
    return res.status(409).json({ error: `${service.name} is already ${service.state === 'pending' ? 'spinning up' : 'running'}.` });
  }
  const result = await railway.deployService({ serviceId: service.id, environmentId: env.id });
  res.json(result);
}));

// Spin down: remove the active deployment, keep the service.
api.post('/services/:id/stop', asyncRoute(async (req, res) => {
  const { service } = await loadOwnedService(req);
  if (!service.deployment || ['stopped', 'stopping'].includes(service.state)) {
    return res.status(409).json({ error: `${service.name} is not running.` });
  }
  await railway.removeDeployment(service.deployment.id);
  res.json({ ok: true });
}));

// Delete the service and everything in it.
api.delete('/services/:id', asyncRoute(async (req, res) => {
  const { service } = await loadOwnedService(req);
  await railway.deleteService(service.id);
  res.json({ ok: true });
}));

app.use('/api', api);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err.message, err.details || '');
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Railway Spinner listening on :${PORT}`);
  if (!process.env.RAILWAY_API_TOKEN) console.warn('RAILWAY_API_TOKEN is not set; API calls will fail.');
  if (!PROJECT_ID) console.warn('No target project ID; set TARGET_PROJECT_ID.');
  if (!APP_PASSWORD) console.warn('APP_PASSWORD is not set; anyone with the URL can create containers.');
});
