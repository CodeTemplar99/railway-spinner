// Thin client for Railway's public GraphQL API.
// Docs: https://docs.railway.com/reference/public-api

const ENDPOINT =
  process.env.RAILWAY_API_URL || 'https://backboard.railway.com/graphql/v2';
const TIMEOUT_MS = 15_000;

class RailwayError extends Error {
  constructor(message, { status = 502, details } = {}) {
    super(message);
    this.name = 'RailwayError';
    this.status = status;
    this.details = details;
  }
}

function authHeaders() {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    throw new RailwayError('RAILWAY_API_TOKEN is not set on the server.', { status: 500 });
  }
  // Account/workspace tokens use a Bearer header; project tokens use their own header.
  return process.env.RAILWAY_TOKEN_KIND === 'project'
    ? { 'Project-Access-Token': token }
    : { Authorization: `Bearer ${token}` };
}

async function gql(query, variables = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    throw new RailwayError(`Could not reach the Railway API (${reason}).`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new RailwayError(`Railway API returned HTTP ${res.status} with a non-JSON body.`);
  }

  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join('; ');
    const status = res.status === 401 || /not authorized/i.test(message) ? 401 : 502;
    throw new RailwayError(message, { status, details: body.errors });
  }
  if (!res.ok) throw new RailwayError(`Railway API returned HTTP ${res.status}.`);
  return body.data;
}

// ---------- Queries ----------

const PROJECT_QUERY = /* GraphQL */ `
  query Project($id: String!) {
    project(id: $id) {
      id
      name
      environments { edges { node { id name } } }
      services {
        edges {
          node {
            id
            name
            createdAt
            serviceInstances {
              edges {
                node {
                  environmentId
                  source { image repo }
                  latestDeployment { id status createdAt staticUrl }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function getProject(projectId) {
  const { project } = await gql(PROJECT_QUERY, { id: projectId });
  if (!project) throw new RailwayError(`Project ${projectId} was not found.`, { status: 404 });
  return {
    id: project.id,
    name: project.name,
    environments: project.environments.edges.map((e) => e.node),
    services: project.services.edges.map(({ node }) => ({
      id: node.id,
      name: node.name,
      createdAt: node.createdAt,
      instances: node.serviceInstances.edges.map((e) => e.node),
    })),
  };
}

// ---------- Mutations ----------

async function createService({ projectId, environmentId, name, image, variables }) {
  const { serviceCreate } = await gql(
    /* GraphQL */ `
      mutation ServiceCreate($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }
    `,
    {
      input: {
        projectId,
        environmentId,
        name,
        source: { image },
        ...(variables && Object.keys(variables).length ? { variables } : {}),
      },
    }
  );
  return serviceCreate;
}

async function createDomain({ serviceId, environmentId, targetPort }) {
  const { serviceDomainCreate } = await gql(
    /* GraphQL */ `
      mutation DomainCreate($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { id domain }
      }
    `,
    { input: { serviceId, environmentId, targetPort } }
  );
  return serviceDomainCreate;
}

// Spin up: trigger a fresh deployment of the service's current source (the image).
async function deployService({ serviceId, environmentId }) {
  const data = await gql(
    /* GraphQL */ `
      mutation Deploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `,
    { serviceId, environmentId }
  );
  return { deploymentId: data.serviceInstanceDeployV2 };
}

// Spin down: remove the active deployment. The service and its config stay,
// so it can be spun up again later.
async function removeDeployment(deploymentId) {
  const data = await gql(
    /* GraphQL */ `
      mutation Remove($id: String!) { deploymentRemove(id: $id) }
    `,
    { id: deploymentId }
  );
  return data.deploymentRemove;
}

// Tear down: delete the service entirely.
async function deleteService(serviceId) {
  const data = await gql(
    /* GraphQL */ `
      mutation Delete($id: String!) { serviceDelete(id: $id) }
    `,
    { id: serviceId }
  );
  return data.serviceDelete;
}

module.exports = {
  RailwayError,
  getProject,
  createService,
  createDomain,
  deployService,
  removeDeployment,
  deleteService,
};
