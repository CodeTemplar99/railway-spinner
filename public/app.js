(() => {
  const $ = (sel) => document.querySelector(sel);

  const STATUS_LABEL = {
    running: 'Running',
    pending: 'Spinning up',
    stopping: 'Spinning down',
    failed: 'Failed',
    stopped: 'Stopped',
  };
  const FAST_POLL = 3000;
  const SLOW_POLL = 15000;

  const state = {
    environmentId: null,
    services: [],
    busy: new Set(), // service IDs with an action in flight
    pollTimer: null,
  };

  // ---------- API ----------

  function password() {
    try { return sessionStorage.getItem('app-password') || ''; } catch { return ''; }
  }

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-app-password': password(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.code === 'PASSWORD_REQUIRED') {
      await askForPassword(Boolean(password()));
      return api(method, path, body);
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  // ---------- password gate ----------

  let gatePromise = null;
  function askForPassword(wasWrong) {
    if (gatePromise) return gatePromise;
    const dialog = $('#gate');
    $('#gate-error').hidden = !wasWrong;
    $('#gate-input').value = '';
    gatePromise = new Promise((resolve) => {
      $('#gate-form').onsubmit = () => {
        try { sessionStorage.setItem('app-password', $('#gate-input').value); } catch {}
        gatePromise = null;
        resolve();
      };
    });
    dialog.addEventListener('cancel', (e) => e.preventDefault(), { once: true });
    dialog.showModal();
    return gatePromise;
  }

  // ---------- activity log ----------

  function log(message, isError = false) {
    const list = $('#log');
    list.querySelector('.empty-log')?.remove();
    const li = document.createElement('li');
    if (isError) li.className = 'error';
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span');
    text.textContent = message;
    li.append(time, text);
    list.prepend(li);
    while (list.children.length > 50) list.lastChild.remove();
  }

  // ---------- rendering ----------

  function render() {
    const rows = $('#rows');
    const tpl = $('#row-tpl');
    rows.replaceChildren();

    for (const svc of state.services) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const busy = state.busy.has(svc.id);
      node.dataset.state = svc.state;
      node.dataset.self = String(svc.isSelf);

      node.querySelector('.name').textContent = svc.name;
      node.querySelector('.status').textContent =
        svc.isSelf ? `${STATUS_LABEL[svc.state]}, this app` : STATUS_LABEL[svc.state];
      node.querySelector('.image').textContent = svc.image || svc.repo || 'No image source';

      const url = node.querySelector('.url');
      if (svc.deployment?.url && svc.state === 'running') {
        url.href = svc.deployment.url;
        url.textContent = svc.deployment.url.replace('https://', '');
      } else {
        url.remove();
      }

      const sw = node.querySelector('.switch');
      const on = svc.state === 'running' || svc.state === 'pending';
      sw.setAttribute('aria-checked', String(on));
      sw.setAttribute('aria-label', `${on ? 'Spin down' : 'Spin up'} ${svc.name}`);
      sw.title = on ? 'Spin down' : 'Spin up';
      sw.disabled = svc.isSelf || busy || svc.state === 'stopping';
      sw.addEventListener('click', () => toggle(svc));

      const del = node.querySelector('.delete');
      del.disabled = svc.isSelf || busy;
      del.addEventListener('click', () => remove(svc));

      rows.append(node);
    }

    $('#empty').hidden = state.services.length > 0;
    const n = state.services.length;
    $('#count').textContent = n ? `${n} ${n === 1 ? 'service' : 'services'}` : '';
  }

  function renderEnvironments(envs, selectedId) {
    const sel = $('#env-select');
    sel.replaceChildren(...envs.map((e) => new Option(e.name, e.id, false, e.id === selectedId)));
    sel.disabled = envs.length < 2;
  }

  // ---------- data ----------

  async function refresh({ quiet = false } = {}) {
    try {
      const q = state.environmentId ? `?environmentId=${encodeURIComponent(state.environmentId)}` : '';
      const data = await api('GET', `/project${q}`);
      state.environmentId = data.environmentId;
      state.services = data.services;
      $('#project-name').textContent = data.project.name;
      renderEnvironments(data.environments, data.environmentId);
      render();
    } catch (err) {
      if (!quiet) log(err.message, true);
      $('#project-name').textContent = 'Project unavailable';
    } finally {
      schedulePoll();
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const moving = state.services.some((s) => s.state === 'pending' || s.state === 'stopping');
    state.pollTimer = setTimeout(() => refresh({ quiet: true }), moving ? FAST_POLL : SLOW_POLL);
  }

  // ---------- actions ----------

  async function act(svc, fn, optimisticState) {
    state.busy.add(svc.id);
    const previous = svc.state;
    if (optimisticState) svc.state = optimisticState;
    render();
    try {
      await fn();
      return true;
    } catch (err) {
      svc.state = previous;
      log(`${svc.name}: ${err.message}`, true);
      return false;
    } finally {
      state.busy.delete(svc.id);
      await refresh({ quiet: true });
    }
  }

  async function toggle(svc) {
    const body = { environmentId: state.environmentId };
    if (svc.state === 'running' || svc.state === 'pending') {
      log(`Spinning down ${svc.name}…`);
      if (await act(svc, () => api('POST', `/services/${svc.id}/stop`, body), 'stopping')) {
        log(`Removed the active deployment of ${svc.name}.`);
      }
    } else {
      log(`Spinning up ${svc.name}…`);
      if (await act(svc, () => api('POST', `/services/${svc.id}/start`, body), 'pending')) {
        log(`Deployment started for ${svc.name}.`);
      }
    }
  }

  async function remove(svc) {
    if (!confirm(`Delete ${svc.name}? This removes the service and its deployments from Railway.`)) return;
    log(`Deleting ${svc.name}…`);
    const q = `?environmentId=${encodeURIComponent(state.environmentId)}`;
    if (await act(svc, () => api('DELETE', `/services/${svc.id}${q}`), 'stopping')) {
      log(`Deleted ${svc.name}.`);
    }
  }

  // ---------- launch form ----------

  function addVarRow(key = '', value = '') {
    const row = document.createElement('div');
    row.className = 'var-row';
    row.innerHTML = `
      <input aria-label="Variable name" placeholder="KEY" spellcheck="false" autocomplete="off">
      <input aria-label="Variable value" placeholder="value" spellcheck="false" autocomplete="off">
      <button type="button" aria-label="Remove variable">×</button>`;
    const [k, v] = row.querySelectorAll('input');
    k.value = key;
    v.value = value;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('#var-rows').append(row);
    k.focus();
  }

  function readVariables() {
    const vars = {};
    for (const row of document.querySelectorAll('.var-row')) {
      const [k, v] = row.querySelectorAll('input');
      if (k.value.trim()) vars[k.value.trim()] = v.value;
    }
    return vars;
  }

  async function launch(e) {
    e.preventDefault();
    const err = $('#form-error');
    err.hidden = true;

    const name = $('#name').value.trim().toLowerCase();
    const image = $('#image').value.trim();
    const port = $('#port').value.trim();

    if (!name || !image) {
      err.textContent = 'Enter a name and an image.';
      err.hidden = false;
      return;
    }

    const btn = $('#launch-btn');
    btn.disabled = true;
    btn.textContent = 'Spinning up…';
    log(`Creating ${name} from ${image}…`);

    try {
      const result = await api('POST', '/services', {
        name,
        image,
        publicPort: port || undefined,
        variables: readVariables(),
        environmentId: state.environmentId,
      });
      log(`Created ${result.service.name}. Railway is pulling the image and deploying it.`);
      if (result.domain?.domain) log(`Public URL: https://${result.domain.domain}`);
      if (result.domain?.error) log(`Couldn’t create a public URL: ${result.domain.error}`, true);
      $('#launch-form').reset();
      $('#var-rows').replaceChildren();
      await refresh();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      log(ex.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Spin up';
    }
  }

  // ---------- wiring ----------

  $('#launch-form').addEventListener('submit', launch);
  $('#add-var').addEventListener('click', () => addVarRow());
  $('#refresh').addEventListener('click', () => refresh());
  $('#env-select').addEventListener('change', (e) => {
    state.environmentId = e.target.value;
    refresh();
  });

  document.querySelectorAll('.presets button').forEach((b) => {
    b.addEventListener('click', () => {
      $('#image').value = b.dataset.image;
      $('#port').value = b.dataset.port;
      if (!$('#name').value) {
        $('#name').value = `${b.textContent}-${Math.random().toString(36).slice(2, 6)}`;
      }
    });
  });

  const empty = document.createElement('li');
  empty.className = 'empty-log';
  empty.textContent = 'Actions you take here show up in this list.';
  $('#log').append(empty);

  refresh();
})();
