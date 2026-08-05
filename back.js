const BASE = '/api/proxy';
let allCourses = [], memberListId = null;
let workspaceMembers = [];
let currentUserEmail = '';
let currentUserIsHR = false;

// ── EMAIL salvo no navegador ──────────────────────────────
function loadSavedEmail() {
  const saved = localStorage.getItem('estat_email');
  if (saved) {
    currentUserEmail = saved;
    return saved;
  }
  return null;
}

function saveEmail(email) {
  currentUserEmail = email;
  localStorage.setItem('estat_email', email);
}

// Mostra o botão "RH" só pra quem está atribuído (assignee) em alguma
// tarefa da lista "Equipe RH" no ClickUp — ver checkHrAccess() em
// loadWorkspace(). Some por padrão até essa checagem terminar, pra
// ninguém ver o botão piscar antes de sumir.
function applyHrVisibility() {
  const btn = document.getElementById('nav-tab-rh');
  if (btn) btn.style.display = currentUserIsHR ? '' : 'none';
}

function logout() {
  localStorage.removeItem('estat_email');
  localStorage.removeItem('clickup_api_key');
  location.reload();
}

// ── API KEY opcional (fallback) ───────────────────────────
function getManualKey() {
  return localStorage.getItem('clickup_api_key') || '';
}

function saveManualKey() {
  const key = document.getElementById('apiKey')?.value.trim();
  if (key) localStorage.setItem('clickup_api_key', key);
  return key;
}

function clearManualKey() {
  localStorage.removeItem('clickup_api_key');
  const input = document.getElementById('apiKey');
  if (input) input.value = '';
}

// ── HELPERS ───────────────────────────────────────────────
function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg show ' + type;
}
function hideMsg(id) {
  const el = document.getElementById(id);
  if (el) el.className = 'msg';
}

// monta headers com email + key manual se tiver
function buildHeaders(extra) {
  const h = { 'Content-Type': 'application/json', 'X-User-Email': currentUserEmail };
  const manualKey = getManualKey();
  if (manualKey) h['X-Manual-Key'] = manualKey;
  return { ...h, ...extra };
}

// ── FILA DE CONCORRÊNCIA + RETRY (protege contra Rate Limit do ClickUp) ──
// O ClickUp limita ~100 req/min por token. Sem isso, qualquer Promise.all
// no código (ex: buscar detalhes de N tasks em paralelo) dispara tudo de
// uma vez e estoura 429 assim que o volume de dados cresce.
const MAX_CONCURRENT = 4;   // requisições simultâneas permitidas ao ClickUp
const RETRY_LIMIT = 5;      // tentativas em caso de 429 antes de desistir
let activeRequests = 0;
const requestQueue = [];

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function scheduleRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

function pumpQueue() {
  if (activeRequests >= MAX_CONCURRENT || !requestQueue.length) return;
  const { fn, resolve, reject } = requestQueue.shift();
  activeRequests++;
  fn().then(resolve, reject).finally(() => {
    activeRequests--;
    pumpQueue();
  });
}

async function withRetry(fn) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (e.isRateLimit && attempt < RETRY_LIMIT) {
        attempt++;
        // backoff crescente, respeitando o Retry-After do ClickUp quando existe
        await sleep(Math.min(e.retryAfter * 1000 * attempt, 30000));
        continue;
      }
      throw e;
    }
  }
}

async function rawRequest(path, opts) {
  const r = await fetch(BASE + path, opts);
  if (r.status === 429) {
    const err = new Error('Limite de requisições do ClickUp atingido, tentando novamente...');
    err.isRateLimit = true;
    err.retryAfter = parseFloat(r.headers.get('Retry-After')) || 1;
    throw err;
  }
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.err || e.error || 'HTTP ' + r.status); }
  return r.json();
}

async function apiFetch(path) {
  return scheduleRequest(() => withRetry(() => rawRequest(path, { headers: buildHeaders() })));
}

async function apiPost(path, body) {
  return scheduleRequest(() => withRetry(() => rawRequest(path, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  })));
}

// O ClickUp usa PUT pra "editar" (mudar status de uma tarefa, marcar item
// de checklist como feito, etc.) — apiPost sozinho não serve pra isso.
async function apiPut(path, body) {
  return scheduleRequest(() => withRetry(() => rawRequest(path, {
    method: 'PUT',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  })));
}

// ── CHAMADAS DE DADO DE RH (rota protegida no servidor) ───
// Qualquer tela que mostre OU EDITE dado de RH (status, 1:1, anotações,
// metas, conquistas) deve usar essas três funções em vez de
// apiFetch/apiPost/apiPut normais. O prefixo "/hr" faz o proxy.js
// confirmar de verdade, no servidor, que quem está pedindo é do time de
// Gestão de Pessoas — não é só o botão escondido na tela (ver comentário
// grande em proxy.js sobre isso).
async function apiFetchHR(path) {
  return apiFetch('/hr' + path);
}
async function apiPostHR(path, body) {
  return apiPost('/hr' + path, body);
}
async function apiPutHR(path, body) {
  return apiPut('/hr' + path, body);
}

// ── PAGINAÇÃO COMPLETA ────────────────────────────────────
// A API do ClickUp devolve no máx. 100 tasks por página. Chamar só
// page=0 (como antes) perde tasks silenciosamente quando a lista cresce.
// `pathPrefix` deve terminar em '?' ou '&' — a função completa com page=N.
async function apiFetchAllPages(pathPrefix) {
  let page = 0, all = [], lastPage = false;
  while (!lastPage) {
    const data = await apiFetch(`${pathPrefix}page=${page}`);
    const tasks = data.tasks || [];
    all = all.concat(tasks);
    lastPage = data.last_page === true || tasks.length === 0;
    page++;
    if (page > 50) break; // trava de segurança contra loop infinito
  }
  return all;
}

// Igual à de cima, mas via apiFetchHR (rota protegida) — usada só pra
// buscar tarefas da lista "Acompanhamento RH".
async function apiFetchAllPagesHR(pathPrefix) {
  let page = 0, all = [], lastPage = false;
  while (!lastPage) {
    const data = await apiFetchHR(`${pathPrefix}page=${page}`);
    const tasks = data.tasks || [];
    all = all.concat(tasks);
    lastPage = data.last_page === true || tasks.length === 0;
    page++;
    if (page > 50) break;
  }
  return all;
}

// ── CACHE DE DETALHES DE TASK (checklists) ────────────────
// loadCoursesByArea, loadDashboard e o "Atualizar" do dashboard buscam o
// detalhe (checklists) de CADA task toda vez que rodam. Isso é o maior
// consumidor de requisições do app: N tasks = N chamadas GET /task/:id
// repetidas mesmo quando nada mudou desde a última vez.
// Solução: cache em memória (dura enquanto a página está aberta, some
// no F5 — não usamos localStorage aqui pra não guardar dado de curso
// desatualizado entre sessões) chaveado por task.id, guardando também o
// `date_updated` que o próprio ClickUp devolve na listagem. Se o
// date_updated não mudou, a task não foi editada no ClickUp desde a
// última busca — então reaproveitamos o detalhe já salvo em vez de
// gastar mais uma chamada de API.
const taskDetailCache = {}; // { [taskId]: { date_updated, data } }

async function getTaskDetailCached(task) {
  const cached = taskDetailCache[task.id];
  if (cached && cached.date_updated === task.date_updated) {
    return cached.data; // nada mudou no ClickUp desde a última vez — usa o cache
  }
  try {
    const data = await apiFetch(`/task/${task.id}`);
    taskDetailCache[task.id] = { date_updated: task.date_updated, data };
    return data;
  } catch (e) {
    // se a busca falhar, devolve o cache antigo (se existir) em vez de quebrar a tela
    return cached ? cached.data : task;
  }
}

// Cache separado pra tarefas de RH (checklist de conquistas), via rota
// protegida. Fica num objeto à parte pra nunca misturar com o cache de
// cursos por engano.
const hrTaskDetailCache = {};

async function getHrTaskDetailCached(task) {
  const cached = hrTaskDetailCache[task.id];
  if (cached && cached.date_updated === task.date_updated) return cached.data;
  try {
    const data = await apiFetchHR(`/task/${task.id}`);
    hrTaskDetailCache[task.id] = { date_updated: task.date_updated, data };
    return data;
  } catch (e) {
    return cached ? cached.data : task;
  }
}

// Comentários de uma tarefa de RH = histórico de 1:1 e anotações. Não tem
// cache aqui de propósito — é justamente o dado que muda com mais
// frequência (RH escreve um novo a cada conversa), então sempre busca
// fresco.
async function getHrTaskComments(taskId) {
  try {
    const data = await apiFetchHR(`/task/${taskId}/comment`);
    return data.comments || [];
  } catch (e) {
    return [];
  }
}

// Subtarefas de uma tarefa de RH = metas do Estatamigo. O ClickUp só
// inclui subtasks na listagem se pedirmos `subtasks=true`, mas elas vêm
// junto com TODAS as tasks da lista (misturadas) — filtramos pelo `parent`
// bater com o id da tarefa principal.
function extractGoalsFor(taskId, allHrTasks) {
  return allHrTasks.filter(t => t.parent === taskId);
}

// ── LOGIN (Google Identity Services) ────────────────────────
// Chamada automaticamente pelo botão do Google (ver data-callback
// no index.html) assim que a pessoa termina de logar na conta Google.
// response.credential é um JWT assinado pelo Google — nós NÃO confiamos
// nele aqui no navegador (poderia ser forjado), só repassamos pro
// proxy.js, que confirma a autenticidade direto com o Google antes
// de liberar o acesso (ver seção "google-login" no proxy).
async function handleGoogleCredential(response) {
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  try {
    const r = await fetch(`${BASE}/google-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await r.json();
    if (!r.ok) {
      errEl.textContent = data.error || 'Erro ao validar login do Google.';
      errEl.style.display = 'block';
      return;
    }
    saveEmail(data.email);
    showApp();
  } catch (e) {
    errEl.textContent = 'Erro de conexão: ' + e.message;
    errEl.style.display = 'block';
  }
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('user-email-display').textContent = currentUserEmail;
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app-screen').style.display = 'none';
}

// ── AUTO CONNECT ──────────────────────────────────────────
async function autoConnect() {
  showMsg('msg-connect', 'Conectando automaticamente...', 'info');
  // esconde o painel de fallback
  document.getElementById('fallback-wrap').style.display = 'none';

  try {
    await loadWorkspace();
  } catch(e) {
    // se falhar, mostra painel de fallback para colar key manual
    showMsg('msg-connect', 'Falha na conexão automática. Cole sua API Key abaixo.', 'warn');
    document.getElementById('fallback-wrap').style.display = 'block';
  }
}

async function connectWithManualKey() {
  const key = saveManualKey();
  if (!key) { showMsg('msg-connect', 'Cole sua API Key primeiro.', 'warn'); return; }
  showMsg('msg-connect', 'Conectando...', 'info');
  document.getElementById('fallback-wrap').style.display = 'none';
  try {
    await loadWorkspace();
  } catch(e) {
    showMsg('msg-connect', 'Erro: ' + e.message, 'error');
    document.getElementById('fallback-wrap').style.display = 'block';
  }
}

// ── WORKSPACE ─────────────────────────────────────────────
let courseAreaLists = []; // [{id, name}] — cada lista = uma área de cursos
let memberListFound = null;
let trilhaSpaceName = '';
let hrTeamList = null;      // lista "Equipe RH" — controle de acesso ao botão de RH
let hrTrackingList = null;  // lista "Acompanhamento RH" — 1 tarefa por Estatamigo

async function loadWorkspace() {
  ['section-lists','section-courses','section-members','section-action']
    .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('section-hidden'); });

  const teams = await apiFetch('/team');
  if (!teams.teams?.length) throw new Error('Nenhum workspace encontrado.');
  const teamId = teams.teams[0].id;

  // membros do workspace
  try {
    const teamData = await apiFetch(`/team/${teamId}`);
    workspaceMembers = (teamData.team?.members || []).map(m => ({
      id: String(m.user.id),
      name: m.user.username || m.user.email,
      email: m.user.email,
    }));
  } catch(e) { workspaceMembers = []; }

  // procura o ESPAÇO "Trilha de Capacitações"
  const spaces = await apiFetch(`/team/${teamId}/space?archived=false`);
  let trilhaSpace = null;
  for (const sp of spaces.spaces) {
    if (sp.name.toLowerCase().includes('trilha') || sp.name.toLowerCase().includes('capacita')) {
      trilhaSpace = sp;
      break;
    }
  }
  if (!trilhaSpace) throw new Error('Espaço "Trilha de Capacitações" não encontrado. Verifique o nome no ClickUp.');
  trilhaSpaceName = trilhaSpace.name;

  courseAreaLists = [];
  memberListFound = null;
  hrTeamList = null;
  hrTrackingList = null;

  // Reconhece uma lista de Gestão de Pessoas de dois jeitos:
  //  1) o NOME DA LISTA já tem "equipe"/"acompanh" + "gestão" + "pessoa"
  //     tudo junto (funciona pra listas soltas na raiz do Espaço); ou
  //  2) a lista está dentro de uma PASTA cujo nome já é "gestão de
  //     pessoas" — nesse caso o nome da lista só precisa ter "equipe" ou
  //     "acompanh", sem repetir "gestão de pessoas" de novo (é assim que
  //     faz mais sentido organizar no ClickUp: pasta com o nome completo,
  //     listas dentro com nome curto).
  function classifyList(l, insideGPFolder) {
    const n = normalizeStatus(l.name);
    if (n.includes('membro')) { memberListFound = l; return; }

    const isTeamByFullName = n.includes('equipe') && n.includes('gest') && n.includes('pessoa');
    const isTrackingByFullName = n.includes('acompanh') && n.includes('gest') && n.includes('pessoa');
    const isTeamByFolder = insideGPFolder && n.includes('equipe');
    const isTrackingByFolder = insideGPFolder && n.includes('acompanh');

    if (isTeamByFullName || isTeamByFolder) { hrTeamList = l; return; }
    if (isTrackingByFullName || isTrackingByFolder) { hrTrackingList = l; return; }

    courseAreaLists.push({ id: l.id, name: l.name });
  }

  // listas direto no espaço (sem folder) — ex: Membros, Por área, Por soluções
  const rootListsData = await apiFetch(`/space/${trilhaSpace.id}/list?archived=false`);
  for (const l of (rootListsData.lists || [])) classifyList(l, false);

  // listas dentro de folders do espaço (ex: pasta "Gestão de pessoas" com
  // "Equipe de Gestão" + "Acompanhamento" dentro, e outras pastas com
  // listas de curso)
  const foldersData = await apiFetch(`/space/${trilhaSpace.id}/folder?archived=false`);
  for (const fo of (foldersData.folders || [])) {
    const folderName = normalizeStatus(fo.name);
    const insideGPFolder = folderName.includes('gest') && folderName.includes('pessoa');
    const flData = await apiFetch(`/folder/${fo.id}/list?archived=false`);
    for (const l of (flData.lists || [])) classifyList(l, insideGPFolder);
  }

  if (!memberListFound) throw new Error('Lista "Membros" não encontrada no espaço da Trilha.');
  if (!courseAreaLists.length) throw new Error('Nenhuma lista de cursos encontrada no espaço da Trilha.');

  memberListId = memberListFound.id;

  // info no step 2
  const folderInfoEl = document.getElementById('folder-info');
  if (folderInfoEl) {
    folderInfoEl.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;background:var(--sky-light);padding:8px 14px;border-radius:var(--radius);border:1px solid var(--border);flex-wrap:wrap;">
         <strong>${trilhaSpace.name}</strong>
         <span style="color:var(--muted)">·</span>
        <span style="color:var(--muted)">${courseAreaLists.length} lista(s) de cursos</span>
        <span style="color:var(--muted)">·</span>
        <span style="color:var(--muted)">Membros: <strong style="color:var(--text-sec)">${memberListFound.name}</strong></span>
        ${hrTeamList ? `<span style="color:var(--muted)">·</span><span style="color:var(--muted)">Equipe Gestão de Pessoas: <strong style="color:var(--text-sec)">${hrTeamList.name}</strong></span>` : ''}
        ${hrTrackingList ? `<span style="color:var(--muted)">·</span><span style="color:var(--muted)">Acompanhamento Gestão de Pessoas: <strong style="color:var(--text-sec)">${hrTrackingList.name}</strong></span>` : ''}
      </span>`;
  }
  document.getElementById('section-lists').classList.remove('section-hidden');
  document.getElementById('num-2').classList.add('done');
  document.getElementById('num-2').textContent = '✓';
  showMsg('msg-connect', `✓ Conectado ao espaço "${trilhaSpace.name}"!`, 'success');

  await resolveCreationStatus();
  await loadMembers();
  await loadCoursesByArea();
  await checkHrAccess();
}

// ── ACESSO À ABA DE RH ─────────────────────────────────────
// Em vez de uma lista fixa de emails (que precisaria ser atualizada toda
// vez que o time de RH muda, ano após ano), a permissão é lida direto do
// ClickUp: quem estiver como responsável (assignee) em qualquer tarefa
// da lista "Equipe RH" (detectada acima, ver hrTeamList) tem acesso.
// Pra trocar quem é do RH, basta trocar os responsáveis dessa lista no
// próprio ClickUp — nada de código ou configuração externa.
//
// Isso só controla o BOTÃO (cosmético). A proteção de verdade dos dados
// de RH acontece no servidor — ver apiFetchHR/apiPostHR e o proxy.js.
async function checkHrAccess() {
  currentUserIsHR = false;
  try {
    if (!hrTeamList) { applyHrVisibility(); return; }

    const me = workspaceMembers.find(
      m => m.email && m.email.toLowerCase() === currentUserEmail.toLowerCase()
    );
    if (!me) { applyHrVisibility(); return; }

    const tasks = await apiFetchAllPages(`/list/${hrTeamList.id}/task?archived=false&`);
    const isAssignedSomewhere = tasks.some(t =>
      (t.assignees || []).some(a => String(a.id) === me.id)
    );
    currentUserIsHR = isAssignedSomewhere;
  } catch (e) {
    // falha na checagem = mais seguro esconder do que mostrar
    currentUserIsHR = false;
  }
  applyHrVisibility();
}

// ── STATUS REAL PARA NOVAS TAREFAS ────────────────────────
// Em vez de forçar um nome fixo, procura o status da lista "Membros"
// que corresponde a "em progresso" (ignorando maiúsculas/acentos),
// pois o nome exato cadastrado no ClickUp pode variar.
let creationStatusName = null;

function normalizeStatus(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ── ÁREA/SOLUÇÃO DO CURSO (via Custom Field do ClickUp) ────────────
// Tanto "Por área" quanto "Por soluções" agrupam os cursos usando o
// mesmo mecanismo no ClickUp: um Custom Field (o "Grupo: ..." que
// aparece no topo da lista) — não Tags. As Tags continuam existindo nos
// cursos, mas com vários valores não-exclusivos por curso, então usá-las
// pra agrupar misturava tudo; por isso não são mais usadas para isso
// (continuam aparecendo como badge informativo ao lado do nome do curso).
// resolveCustomFieldLabel() decodifica o valor de um Custom Field pro
// texto legível, já que o ClickUp guarda isso de formas diferentes
// dependendo do tipo do campo:
//   - drop_down: value é o índice (orderindex) da opção escolhida
//   - labels:    value é um array de ids das opções escolhidas
//   - outros:    value já costuma vir como texto simples
function resolveCustomFieldLabel(field) {
  if (field.value === null || field.value === undefined || field.value === '') return null;
  const opts = field.type_config?.options || [];

  if (field.type === 'drop_down') {
    const opt = opts.find(o => o.orderindex === field.value) || opts[field.value];
    return opt ? (opt.name || opt.label || null) : null;
  }
  if (field.type === 'labels') {
    const ids = Array.isArray(field.value) ? field.value : [field.value];
    const opt = opts.find(o => ids.includes(o.id));
    return opt ? (opt.label || opt.name || null) : null;
  }
  // texto simples, número, etc. — usa o valor bruto se for utilizável
  if (typeof field.value === 'string' && field.value.trim()) return field.value.trim();
  return null;
}

function getAreaLabel(course) {
  const fields = course.custom_fields || [];
  const groupField = fields.find(f => {
    const n = normalizeStatus(f.name);
    return n.includes('area') || n.includes('solu') || n.includes('grupo');
  });
  if (groupField) {
    const label = resolveCustomFieldLabel(groupField);
    if (label) return label;
  }

  return 'Sem área';
}

async function resolveCreationStatus() {
  creationStatusName = null;
  try {
    const listData = await apiFetch(`/list/${memberListId}`);
    const statuses = listData.statuses || [];
    const target = statuses.find(s => normalizeStatus(s.status).includes('progress'));
    creationStatusName = target ? target.status : null;
  } catch(e) { creationStatusName = null; }
}

// ── CURSOS POR ÁREA (agrupados pela 1ª etiqueta de cada curso) ──
async function loadCoursesByArea() {
  document.getElementById('section-courses').classList.add('section-hidden');
  allCourses = [];

  try {
    const listResults = await Promise.all(
      courseAreaLists.map(async lst => {
        const tasks = await apiFetchAllPages(`/list/${lst.id}/task?archived=false&`);
        const details = await Promise.all(tasks.map(t => getTaskDetailCached(t)));
        return details;
      })
    );

    const groups = {}; // { areaLabel: [course, ...] }
    let totalCursos = 0;

    for (const tasks of listResults) {
      for (const d of tasks) {
        const course = {
          id: d.id, name: d.name, tags: d.tags || [],
          custom_fields: d.custom_fields || [],
          description: d.description || '',
          markdown_description: d.markdown_description || '',
          checklists: d.checklists || []
        };
        allCourses.push(course);
        totalCursos++;

        const areaLabel = getAreaLabel(course);
        if (!groups[areaLabel]) groups[areaLabel] = [];
        groups[areaLabel].push(course);
      }
    }

    const areaNames = Object.keys(groups).sort((a, b) => {
      if (a === 'Sem área') return 1;
      if (b === 'Sem área') return -1;
      return a.localeCompare(b);
    });

    const AREA_COLORS = ['#2E96D9', '#8B5FBF', '#1E9E5A', '#D9822E', '#D9457B', '#3AA6A6', '#C9A227', '#5B6FD9'];

    let html = '';

    areaNames.forEach((areaLabel, i) => {
      const courses = groups[areaLabel];
      const color = AREA_COLORS[i % AREA_COLORS.length];
      html += `<div class="area-group" style="--area-color:${color}">
        <div class="area-label" style="background:${color}1A;border-color:${color}66;color:${color}">${areaLabel}</div>
        <div class="list-grid">`;

      for (const course of courses) {
        const tagHtml = course.tags.map(t => `<span class="tag">${t.name}</span>`).join('');
        const total = course.checklists.reduce((a, cl) => a + (cl.items?.length || 0), 0);
        const badge = total > 0 ? `<span class="checklist-badge">✓ ${total} itens</span>` : '';
        html += `<div class="check-item" id="ci-c-${course.id}">
          <input type="checkbox" class="chk-course" value="${course.id}" onchange="onCheck(this,'ci-c-${course.id}')">
          <label onclick="this.previousElementSibling.click()">${course.name}${tagHtml}${badge}</label>
        </div>`;
      }
      html += `</div></div>`;
    });

    const el = document.getElementById('courses-list');
    document.getElementById('section-courses').classList.remove('section-hidden');

    if (!totalCursos) { el.innerHTML = '<span class="empty">Nenhum curso encontrado.</span>'; return; }
    document.getElementById('count-courses').textContent = totalCursos + ' cursos';
    el.innerHTML = html;
    updateSummary();
  } catch(e) { showMsg('msg-lists', 'Erro ao carregar cursos: ' + e.message, 'error'); }
}

// ── MEMBROS ───────────────────────────────────────────────
async function loadMembers() {
  document.getElementById('section-members').classList.add('section-hidden');
  try {
    const el = document.getElementById('members-list');
    document.getElementById('section-members').classList.remove('section-hidden');

    if (!workspaceMembers.length) {
      el.innerHTML = '<span class="empty">Nenhum membro encontrado no workspace.</span>';
      return;
    }
    document.getElementById('count-members').textContent = workspaceMembers.length + ' membros';

    let html = `<label class="select-all-row"><input type="checkbox" onchange="toggleAll('member',this.checked)"> Selecionar todos</label>
    <div class="list-grid">`;
    for (const m of workspaceMembers) {
      const safeId = m.id.replace(/[^a-zA-Z0-9]/g, '_');
      html += `<div class="check-item" id="ci-m-${safeId}">
        <input type="checkbox" class="chk-member" value="${m.id}" onchange="onCheck(this,'ci-m-${safeId}')">
        <label onclick="this.previousElementSibling.click()">${m.name}${m.email ? ` <span style="color:var(--muted);font-weight:400">(${m.email})</span>` : ''}</label>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
    updateSummary();
  } catch(e) { showMsg('msg-lists', 'Erro ao carregar membros: ' + e.message, 'error'); }
}

function onCheck(cb, wrapId) {
  const wrap = document.getElementById(wrapId);
  if (wrap) cb.checked ? wrap.classList.add('selected') : wrap.classList.remove('selected');
  updateSummary();
}

function toggleAll(type, checked) {
  document.querySelectorAll(`.chk-${type}`).forEach(c => {
    c.checked = checked;
    const wrap = c.closest('.check-item');
    if (wrap) checked ? wrap.classList.add('selected') : wrap.classList.remove('selected');
  });
  updateSummary();
}

function updateSummary() {
  const nc = document.querySelectorAll('.chk-course:checked').length;
  const nm = document.querySelectorAll('.chk-member:checked').length;
  const sect = document.getElementById('section-action');
  if (nc > 0 && nm > 0) {
    sect.classList.remove('section-hidden');
    const statusInfo = creationStatusName
      ? `com status inicial "<strong>${creationStatusName}</strong>"`
      : `com o status padrão da lista <span style="color:var(--warn)">(nenhum status "em progresso" encontrado)</span>`;
    document.getElementById('summary').innerHTML =
      `Serão criadas <strong>${nc * nm}</strong> tarefa(s): <strong>${nc}</strong> curso(s) × <strong>${nm}</strong> membro(s), atribuídas diretamente como responsável no ClickUp, ${statusInfo}.`;
  } else {
    sect.classList.add('section-hidden');
  }
}

async function copyCourses() {
  const selectedCourseIds = [...document.querySelectorAll('.chk-course:checked')].map(c => c.value);
  const selectedMemberIds = [...document.querySelectorAll('.chk-member:checked')].map(c => c.value);
  const courses = allCourses.filter(c => selectedCourseIds.includes(c.id));
  const total = courses.length * selectedMemberIds.length;
  let done = 0, errors = 0;
  const log = [];

  document.getElementById('btn-copy').disabled = true;
  document.getElementById('progress-wrap').style.display = '';
  document.getElementById('result-list').innerHTML = '';
  hideMsg('msg-result');

  for (const memberId of selectedMemberIds) {
    const member = workspaceMembers.find(m => m.id === memberId);
    const memberLabel = member ? member.name : memberId;
    for (const course of courses) {
      document.getElementById('progress-label').textContent = `Copiando "${course.name}" → "${memberLabel}"...`;
      try {
        const body = { name: course.name, assignees: [parseInt(memberId)] };
        if (creationStatusName) body.status = creationStatusName;
        if (course.markdown_description) body.markdown_description = course.markdown_description;
        else if (course.description) body.description = course.description;
        const created = await apiPost(`/list/${memberListId}/task`, body);
        for (const cl of course.checklists) {
          const newCl = await apiPost(`/task/${created.id}/checklist`, { name: cl.name || 'Checklist' });
          const clId = newCl.checklist?.id;
          if (!clId) continue;
          for (const item of (cl.items || []))
            await apiPost(`/checklist/${clId}/checklist_item`, { name: item.name, resolved: false });
        }
        log.push({ ok: true, text: `✓ ${course.name} → ${memberLabel}` });
      } catch(e) {
        errors++;
        log.push({ ok: false, text: `✗ ${course.name} → ${memberLabel}: ${e.message}` });
      }
      done++;
      document.getElementById('progress-fill').style.width = Math.round(done/total*100) + '%';
    }
  }

  document.getElementById('btn-copy').disabled = false;
  document.getElementById('progress-wrap').style.display = 'none';
  document.getElementById('result-list').innerHTML = log.map(l=>`<div class="result-item ${l.ok?'ok':'err'}">${l.text}</div>`).join('');
  showMsg('msg-result',
    errors===0 ? `✓ ${done} tarefa(s) criada(s) com sucesso!` : `${done-errors} criadas, ${errors} com erro.`,
    errors===0 ? 'success' : 'warn'
  );
}

// ── DASHBOARD (agrupado por Responsável/assignee) ─────────
async function loadDashboard() {
  if (!memberListId) {
    document.getElementById('dashboard-body').innerHTML = '<div class="dash-loading">Conecte primeiro na aba Copiar cursos.</div>';
    return;
  }
  document.getElementById('dashboard-body').innerHTML = '<div class="dash-loading">⏳ Carregando progresso...</div>';
  try {
    const tasks = await apiFetchAllPages(`/list/${memberListId}/task?archived=false&subtasks=true&include_closed=true&`);

    const byMember = {}; // key -> { name, tasks: [] }
    for (const t of tasks) {
      const assignees = (t.assignees && t.assignees.length) ? t.assignees : [{ id: '_sem', username: 'Sem responsável' }];
      for (const a of assignees) {
        const key = String(a.id);
        if (!byMember[key]) byMember[key] = { name: a.username || a.email || 'Sem responsável', tasks: [] };
        byMember[key].tasks.push(t);
      }
    }

    const details = await Promise.all(tasks.map(t => getTaskDetailCached(t).catch(()=>null)));
    const detailMap = {};
    for (const d of details) if (d) detailMap[d.id] = d;

    const memberKeys = Object.keys(byMember).sort((a,b) => byMember[a].name.localeCompare(byMember[b].name));
    if (!memberKeys.length) {
      document.getElementById('dashboard-body').innerHTML = '<div class="empty">Nenhum dado encontrado.</div>';
      return;
    }

    // calcula progresso geral de cada membro para o card de resumo
    let summaryHtml = '<div class="dash-summary-grid">';
    for (const key of memberKeys) {
      const { name, tasks: memberTasks } = byMember[key];
      let totalAll = 0, doneAll = 0;
      for (const task of memberTasks) {
        const d = detailMap[task.id];
        const cls = d?.checklists || [];
        totalAll += cls.reduce((a,cl) => a+(cl.items?.length||0), 0);
        doneAll  += cls.reduce((a,cl) => a+(cl.items?.filter(i=>i.resolved).length||0), 0);
      }
      const pctAll = totalAll > 0 ? Math.round((doneAll/totalAll)*100) : 0;
      const ring = '#2E96D9'; // azul da Estat (mesma cor de marca usada no resto do site)
      summaryHtml += `
        <div class="dash-member-card" data-member-key="${key}" onclick="filterDashboardMember('${key}')" title="Clique para ver só ${name}">
          <div class="dash-ring-wrap">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle cx="36" cy="36" r="30" fill="none" stroke="#E0EEF8" stroke-width="7"/>
              <circle cx="36" cy="36" r="30" fill="none" stroke="${ring}" stroke-width="7"
                stroke-dasharray="${Math.round(2*Math.PI*30)}"
                stroke-dashoffset="${Math.round(2*Math.PI*30 * (1 - pctAll/100))}"
                stroke-linecap="round"
                transform="rotate(-90 36 36)"/>
            </svg>
            <span class="dash-ring-pct" style="color:${ring}">${pctAll}%</span>
          </div>
          <div class="dash-card-info">
            <div class="dash-card-name">${name}</div>
            <div class="dash-card-meta">${memberTasks.length} curso(s) · ${doneAll}/${totalAll} itens</div>
          </div>
        </div>`;
    }
    summaryHtml += '</div>';

    // detalhe por membro — fica ESCONDIDO por padrão (display:none no
    // wrapper); só aparece quando a pessoa clica num card lá em cima
    // (ver applyDashboardFilter, que também garante que só o detalhe do
    // membro clicado fica visível ali dentro).
    let detailHtml = '';
    for (const key of memberKeys) {
      const { name, tasks: memberTasks } = byMember[key];
      detailHtml += `<div class="dash-member" data-member-key="${key}">
        <div class="dash-member-header">
          <strong>${name}</strong>
          <span class="dash-count">${memberTasks.length} curso(s)</span>
        </div>`;
      if (!memberTasks.length) {
        detailHtml += `<div class="dash-empty-member">Nenhum curso atribuído ainda.</div>`;
      } else {
        detailHtml += `<div class="dash-courses">`;
        for (const task of memberTasks) {
          const d = detailMap[task.id];
          const cls = d?.checklists || [];
          const totalItems = cls.reduce((a,cl) => a+(cl.items?.length||0), 0);
          const doneItems  = cls.reduce((a,cl) => a+(cl.items?.filter(i=>i.resolved).length||0), 0);
          const pct = totalItems > 0 ? Math.round((doneItems/totalItems)*100) : 0;
          const isClosed = task.status?.type === 'closed';
          const barColor = '#2E96D9'; // azul da Estat
          detailHtml += `<div class="dash-course-row">
            <div class="dash-course-top">
              <span class="dash-course-name ${isClosed?'done-text':''}">${isClosed?'✓ ':''}${task.name}</span>
              <span class="dash-course-pct-badge" style="background:${barColor}20;color:${barColor};border-color:${barColor}40">${pct}%</span>
            </div>
            <div class="dash-progress-wrap">
              <div class="dash-progress-bar">
                <div class="dash-progress-fill" style="width:${pct}%;background:${barColor}"></div>
              </div>
              <span class="dash-pct">${doneItems}/${totalItems} itens</span>
            </div>
          </div>`;
        }
        detailHtml += `</div>`;
      }
      detailHtml += `</div>`;
    }

    document.getElementById('dashboard-body').innerHTML =
      summaryHtml + `<div id="dash-detail-wrap" style="margin-top:1.5rem;display:none">${detailHtml}</div>`;
    applyDashboardFilter();
  } catch(e) {
    document.getElementById('dashboard-body').innerHTML = `<div class="msg show error">Erro: ${e.message}</div>`;
  }
}

// ── FILTRO "SÓ ESSA PESSOA" NO DASHBOARD ──────────────────
let dashboardFilterKey = null;

function filterDashboardMember(key) {
  dashboardFilterKey = (dashboardFilterKey === key) ? null : key;
  applyDashboardFilter();
}

function clearDashboardFilter() {
  dashboardFilterKey = null;
  applyDashboardFilter();
}

function applyDashboardFilter() {
  const clearBtn = document.getElementById('dash-clear-filter');
  if (clearBtn) clearBtn.style.display = dashboardFilterKey ? '' : 'none';

  document.querySelectorAll('.dash-member-card').forEach(card => {
    const isMatch = card.dataset.memberKey === dashboardFilterKey;
    card.classList.toggle('dash-card-active', isMatch);
    // com filtro ativo, deixa só o card clicado; sem filtro, mostra todos
    card.style.display = (!dashboardFilterKey || isMatch) ? '' : 'none';
  });

  // o bloco de detalhe inteiro só aparece quando algum membro está
  // selecionado — sem clique nenhum, fica escondido
  const detailWrap = document.getElementById('dash-detail-wrap');
  if (detailWrap) detailWrap.style.display = dashboardFilterKey ? '' : 'none';

  document.querySelectorAll('.dash-member').forEach(det => {
    det.style.display = (det.dataset.memberKey === dashboardFilterKey) ? '' : 'none';
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const savedEmail = loadSavedEmail();
  if (savedEmail) {
    showApp();
  } else {
    showLogin();
  }
});

// ── RANKING DE MELHORES CURSOS ────────────────────────────
async function loadRanking() {
  if (!memberListId) {
    document.getElementById('ranking-body').innerHTML =
      '<div class="dash-loading">Conecte primeiro na aba Copiar cursos.</div>';
    return;
  }

  document.getElementById('ranking-body').innerHTML =
    '<div class="dash-loading">⏳ Buscando avaliações...</div>';

  try {
    const tasks = await apiFetchAllPages(
      `/list/${memberListId}/task?archived=false&include_closed=true&`
    );

    const courseMap = {};

    for (const task of tasks) {
      const name = task.name;
      if (!courseMap[name]) courseMap[name] = { notas: [], concluidos: 0, total: 0 };
      courseMap[name].total++;
      if (task.status?.type === 'closed') courseMap[name].concluidos++;

      const fields = task.custom_fields || [];
      const ratingField = fields.find(f =>
        f.name?.toLowerCase().includes('avalia') ||
        f.name?.toLowerCase().includes('rating') ||
        f.name?.toLowerCase().includes('nota')
      );
      if (ratingField && ratingField.value !== null && ratingField.value !== undefined) {
        const val = parseFloat(ratingField.value);
        if (!isNaN(val) && val > 0) courseMap[name].notas.push(val);
      }
    }

    const cursos = Object.entries(courseMap)
      .map(([nome, info]) => {
        const media = info.notas.length > 0
          ? info.notas.reduce((a, b) => a + b, 0) / info.notas.length
          : null;
        return { nome, media, avaliacoes: info.notas.length, total: info.total, concluidos: info.concluidos, notas: info.notas };
      })
      .sort((a, b) => {
        if (a.media === null && b.media === null) return a.nome.localeCompare(b.nome);
        if (a.media === null) return 1;
        if (b.media === null) return -1;
        return b.media - a.media;
      });

    if (!cursos.length) {
      document.getElementById('ranking-body').innerHTML =
        '<div class="empty">Nenhum curso encontrado na lista de membros.</div>';
      return;
    }

    const comNota   = cursos.filter(c => c.media !== null);
    const semNota   = cursos.filter(c => c.media === null);

    let html = '';

    if (comNota.length) {
      html += '<div class="ranking-list">';
      comNota.forEach((curso, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `<span class="rank-num">${idx+1}</span>`;
        const stars = renderStars(curso.media);
        const pctConcluido = curso.total > 0 ? Math.round((curso.concluidos/curso.total)*100) : 0;
        const barColor = curso.media >= 4 ? '#1E9E5A' : curso.media >= 3 ? '#5BB8F5' : '#F0A020';
        html += `
          <div class="ranking-item">
            <div class="ranking-pos">${medal}</div>
            <div class="ranking-info">
              <div class="ranking-name">${curso.nome}</div>
              <div class="ranking-meta">
                <span class="ranking-stars">${stars}</span>
                <span class="ranking-avg">${curso.media.toFixed(1)}</span>
                <span class="ranking-count">(${curso.avaliacoes} avaliação${curso.avaliacoes>1?'ões':''})</span>
                <span class="ranking-sep">·</span>
                <span class="ranking-done">${curso.concluidos}/${curso.total} concluídos</span>
              </div>
              <div class="ranking-bar-wrap">
                <div class="ranking-bar">
                  <div class="ranking-bar-fill" style="width:${(curso.media/5)*100}%;background:${barColor}"></div>
                </div>
                <span class="ranking-pct-right">${pctConcluido}% concluído</span>
              </div>
            </div>
          </div>`;
      });
      html += '</div>';
    }

    if (semNota.length) {
      html += `
        <div class="ranking-sem-nota-title">
           Ainda sem avaliação (${semNota.length})
        </div>
        <div class="ranking-sem-nota-list">`;
      semNota.forEach(curso => {
        const pct = curso.total > 0 ? Math.round((curso.concluidos/curso.total)*100) : 0;
        html += `
          <div class="ranking-sem-nota-item">
            <span class="ranking-sem-nome">${curso.nome}</span>
            <span class="ranking-sem-meta">${curso.concluidos}/${curso.total} concluídos · ${pct}%</span>
          </div>`;
      });
      html += '</div>';
    }

    document.getElementById('ranking-body').innerHTML = html;

  } catch(e) {
    document.getElementById('ranking-body').innerHTML =
      `<div class="msg show error">Erro ao carregar ranking: ${e.message}</div>`;
  }
}

function renderStars(media) {
  if (media === null) return '☆☆☆☆☆';
  const full  = Math.floor(media);
  const half  = (media - full) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(empty);
}

// ── ACOMPANHAMENTO GESTÃO DE PESSOAS (dado sensível — só via apiFetchHR/apiPostHR/apiPutHR) ──
// Espelha a estrutura do Dashboard de cursos, mas lendo (E ESCREVENDO) na
// lista "Acompanhamento". Cada Estatamigo é UMA tarefa nessa lista, e
// cada informação vem de um mecanismo nativo do ClickUp (sem gastar
// Custom Field):
//   • Status do membro    → o Status da própria tarefa (cor já vem do ClickUp)
//   • Responsável de GP   → o assignee da tarefa
//   • Último 1:1/anotações → os Comentários da tarefa (data automática)
//   • Conquistas           → uma Checklist chamada "Conquistas"
//   • Metas                 → Subtarefas (cada uma = 1 meta, com prazo)
//
// Toda ação de escrita (mudar status, marcar conquista, criar meta,
// registrar comentário, criar Estatamigo novo) chama o ClickUp de
// verdade via apiPostHR/apiPutHR e depois recarrega a tela inteira — é
// mais simples e mais seguro contra estado desatualizado do que tentar
// atualizar só um pedaço da tela na mão.
function daysAgo(timestampMs) {
  const diffMs = Date.now() - Number(timestampMs);
  const days = Math.floor(diffMs / 86400000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'há 1 dia';
  return `há ${days} dias`;
}

let hrEnrichedByTaskId = {};   // cache do último load, usado pelos handlers de escrita
let hrTrackingStatuses = [];   // status configurados na lista Acompanhamento
let hrClosedStatusName = null; // usado pra marcar uma Meta (subtarefa) como concluída
let hrOpenStatusName = null;   // usado pra "desmarcar" uma Meta

async function loadHRTracking() {
  const body = document.getElementById('hr-body');
  if (!body) return;

  if (!currentUserIsHR) {
    body.innerHTML = '<div class="empty">Acesso restrito ao time de Gestão de Pessoas.</div>';
    return;
  }
  if (!hrTrackingList) {
    body.innerHTML = `<div class="msg show warn">
      Lista "Acompanhamento" (dentro da pasta "Gestão de pessoas") ainda não
      encontrada. Crie a lista e adicione uma tarefa por Estatamigo.
    </div>`;
    return;
  }

  body.innerHTML = '<div class="dash-loading">⏳ Carregando acompanhamento...</div>';

  try {
    // status configurados na lista (pro dropdown de status + achar qual é "concluído")
    const listData = await apiFetchHR(`/list/${hrTrackingList.id}`);
    hrTrackingStatuses = listData.statuses || [];
    const closed = hrTrackingStatuses.find(s => s.type === 'closed');
    const open = hrTrackingStatuses.find(s => s.type !== 'closed');
    hrClosedStatusName = closed ? closed.status : null;
    hrOpenStatusName = open ? open.status : null;

    // subtasks=true traz as metas (subtarefas) junto na mesma busca
    const allTasks = await apiFetchAllPagesHR(
      `/list/${hrTrackingList.id}/task?archived=false&subtasks=true&include_closed=true&`
    );
    const memberTasks = allTasks.filter(t => !t.parent);

    // busca checklist (conquistas) e comentários (1:1/anotações) de cada um
    const enriched = await Promise.all(memberTasks.map(async t => {
      const [detail, comments] = await Promise.all([
        getHrTaskDetailCached(t),
        getHrTaskComments(t.id)
      ]);
      const goals = extractGoalsFor(t.id, allTasks);
      const lastCommentMs = comments.length
        ? Math.max(...comments.map(c => Number(c.date) || 0))
        : null;
      const conquistas = (detail.checklists || []).find(cl =>
        (cl.name || '').toLowerCase().includes('conquist')
      );
      return { task: t, detail, comments, goals, lastCommentMs, achievementsChecklistId: conquistas?.id || null, achievementsItems: conquistas?.items || [] };
    }));

    enriched.sort((a, b) => a.task.name.localeCompare(b.task.name));
    hrEnrichedByTaskId = {};
    for (const item of enriched) hrEnrichedByTaskId[item.task.id] = item;

    // ── formulário "novo Estatamigo" ──────────────────────
    const memberOptions = workspaceMembers.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
    let html = `
      <div class="hr-new-form">
        <input type="text" id="hr-new-name" placeholder="Nome do Estatamigo" class="hr-input" style="flex:2">
        <select id="hr-new-resp" class="hr-input" style="flex:1">
          <option value="">Responsável de GP...</option>
          ${memberOptions}
        </select>
        <button class="btn btn-blue" onclick="addEstatamigo()">+ Adicionar</button>
      </div>`;

    if (!enriched.length) {
      html += '<div class="empty">Nenhum Estatamigo cadastrado ainda.</div>';
      body.innerHTML = html;
      return;
    }

    html += '<div class="dash-summary-grid">';
    for (const item of enriched) {
      const { task, comments, goals, lastCommentMs, achievementsItems } = item;
      const statusColor = task.status?.color || '#5BB8F5';
      const statusName = task.status?.status || 'Sem status';
      const responsavel = (task.assignees && task.assignees[0])
        ? (task.assignees[0].username || task.assignees[0].email) : 'Sem responsável';
      const ultimoContato = lastCommentMs ? daysAgo(lastCommentMs) : 'sem registro';
      const goalsDone = goals.filter(g => g.status?.type === 'closed').length;
      const achvDone = achievementsItems.filter(it => it.resolved).length;

      html += `
        <div class="dash-member-card" data-member-key="${task.id}" onclick="filterHRMember('${task.id}')" title="Clique para ver o histórico de ${task.name}">
          <div class="hr-status-dot" style="background:${statusColor}"></div>
          <div class="dash-card-info">
            <div class="dash-card-name">${task.name}</div>
            <div class="dash-card-meta" style="color:${statusColor}">${statusName}</div>
            <div class="dash-card-meta">GP: ${responsavel} · Último 1:1: ${ultimoContato}</div>
            <div class="dash-card-meta">🎯 ${goalsDone}/${goals.length} metas · 🏆 ${achvDone}/${achievementsItems.length} conquistas</div>
          </div>
        </div>`;
    }
    html += '</div>';

    // detalhe por membro — escondido até clicar, mesmo padrão do Dashboard
    let detailHtml = '';
    for (const item of enriched) {
      const { task, comments, goals, achievementsItems, achievementsChecklistId } = item;

      const statusOptions = hrTrackingStatuses.map(s =>
        `<option value="${s.status}" ${s.status === task.status?.status ? 'selected' : ''}>${s.status}</option>`
      ).join('');

      detailHtml += `<div class="dash-member" data-member-key="${task.id}">
        <div class="dash-member-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <strong>${task.name}</strong>
          <select class="hr-input" style="width:auto" onchange="changeHRStatus('${task.id}', this.value)">${statusOptions}</select>
        </div>

        <div class="hr-detail-section">
          <div class="hr-detail-title">🎯 Metas</div>
          ${goals.map(g => `
            <div class="dash-course-row" style="cursor:pointer" onclick="toggleGoal('${g.id}', ${g.status?.type === 'closed'})">
              <div class="dash-course-top">
                <span class="dash-course-name ${g.status?.type==='closed'?'done-text':''}">
                  ${g.status?.type==='closed'?'✓ ':'☐ '}${g.name}
                </span>
                ${g.due_date ? `<span class="dash-pct">até ${new Date(Number(g.due_date)).toLocaleDateString('pt-BR')}</span>` : ''}
              </div>
            </div>`).join('') || '<div class="dash-empty-member">Nenhuma meta cadastrada.</div>'}
          <div class="hr-new-form" style="margin-top:8px">
            <input type="text" id="hr-new-goal-${task.id}" placeholder="Nova meta..." class="hr-input" style="flex:2">
            <input type="date" id="hr-new-goal-date-${task.id}" class="hr-input" style="flex:1">
            <button class="btn btn-outline" onclick="addGoal('${task.id}')">+ Meta</button>
          </div>
        </div>

        <div class="hr-detail-section">
          <div class="hr-detail-title">🏆 Conquistas</div>
          ${achievementsItems.map(it => `
            <div class="dash-course-row" style="cursor:pointer" onclick="toggleAchievement('${achievementsChecklistId}','${it.id}', ${!!it.resolved})">
              <span class="dash-course-name ${it.resolved?'done-text':''}">${it.resolved?'✓ ':'☐ '}${it.name}</span>
            </div>`).join('') || '<div class="dash-empty-member">Nenhuma conquista registrada ainda.</div>'}
          <div class="hr-new-form" style="margin-top:8px">
            <input type="text" id="hr-new-achv-${task.id}" placeholder="Nova conquista..." class="hr-input" style="flex:2">
            <button class="btn btn-outline" onclick="addAchievement('${task.id}')">+ Conquista</button>
          </div>
        </div>

        <div class="hr-detail-section">
          <div class="hr-detail-title">📝 Histórico (1:1 e anotações)</div>
          ${comments.slice().sort((a,b)=>Number(b.date)-Number(a.date)).map(c => `
            <div class="hr-comment-row">
              <div class="hr-comment-meta">
                <strong>${c.user?.username || 'Gestão de Pessoas'}</strong>
                <span style="color:var(--muted)">${new Date(Number(c.date)).toLocaleDateString('pt-BR')}</span>
              </div>
              <div class="hr-comment-text">${c.comment_text || ''}</div>
            </div>`).join('') || '<div class="dash-empty-member">Nenhuma anotação registrada ainda.</div>'}
          <div class="hr-new-form" style="margin-top:8px">
            <textarea id="hr-new-comment-${task.id}" placeholder="Escreva uma anotação de 1:1..." class="hr-input" style="flex:1;min-height:60px"></textarea>
          </div>
          <button class="btn btn-blue" style="margin-top:6px" onclick="addHRComment('${task.id}')">Registrar 1:1</button>
        </div>
      </div>`;
    }

    body.innerHTML = html + `<div id="hr-detail-wrap" style="margin-top:1.5rem;display:none">${detailHtml}</div>`;
    applyHRFilter();
  } catch (e) {
    body.innerHTML = `<div class="msg show error">Erro ao carregar acompanhamento: ${e.message}</div>`;
  }
}

// ── AÇÕES DE ESCRITA (tudo via rota protegida hr/) ────────
async function addEstatamigo() {
  const nameInput = document.getElementById('hr-new-name');
  const respSelect = document.getElementById('hr-new-resp');
  const name = nameInput.value.trim();
  if (!name) { alert('Digite o nome do Estatamigo.'); return; }
  const body = { name };
  if (respSelect.value) body.assignees = [parseInt(respSelect.value)];
  try {
    await apiPostHR(`/list/${hrTrackingList.id}/task`, body);
    await loadHRTracking();
  } catch (e) { alert('Erro ao criar Estatamigo: ' + e.message); }
}

async function changeHRStatus(taskId, statusName) {
  try {
    await apiPutHR(`/task/${taskId}`, { status: statusName });
    await loadHRTracking();
  } catch (e) { alert('Erro ao mudar status: ' + e.message); }
}

async function addAchievement(taskId) {
  const input = document.getElementById(`hr-new-achv-${taskId}`);
  const text = input.value.trim();
  if (!text) return;
  try {
    let checklistId = hrEnrichedByTaskId[taskId]?.achievementsChecklistId;
    if (!checklistId) {
      const cl = await apiPostHR(`/task/${taskId}/checklist`, { name: 'Conquistas' });
      checklistId = cl.checklist?.id;
    }
    await apiPostHR(`/checklist/${checklistId}/checklist_item`, { name: text });
    await loadHRTracking();
  } catch (e) { alert('Erro ao adicionar conquista: ' + e.message); }
}

async function toggleAchievement(checklistId, itemId, wasResolved) {
  try {
    await apiPutHR(`/checklist/${checklistId}/checklist_item/${itemId}`, { resolved: !wasResolved });
    await loadHRTracking();
  } catch (e) { alert('Erro ao atualizar conquista: ' + e.message); }
}

async function addGoal(taskId) {
  const nameInput = document.getElementById(`hr-new-goal-${taskId}`);
  const dateInput = document.getElementById(`hr-new-goal-date-${taskId}`);
  const name = nameInput.value.trim();
  if (!name) return;
  const body = { name, parent: taskId };
  if (dateInput?.value) body.due_date = new Date(dateInput.value).getTime();
  try {
    await apiPostHR(`/list/${hrTrackingList.id}/task`, body);
    await loadHRTracking();
  } catch (e) { alert('Erro ao adicionar meta: ' + e.message); }
}

async function toggleGoal(goalId, isCurrentlyClosed) {
  const targetStatus = isCurrentlyClosed ? hrOpenStatusName : hrClosedStatusName;
  if (!targetStatus) { alert('Nenhum status de conclusão configurado na lista Acompanhamento.'); return; }
  try {
    await apiPutHR(`/task/${goalId}`, { status: targetStatus });
    await loadHRTracking();
  } catch (e) { alert('Erro ao atualizar meta: ' + e.message); }
}

async function addHRComment(taskId) {
  const textarea = document.getElementById(`hr-new-comment-${taskId}`);
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await apiPostHR(`/task/${taskId}/comment`, { comment_text: text });
    await loadHRTracking();
  } catch (e) { alert('Erro ao registrar anotação: ' + e.message); }
}

// ── FILTRO "SÓ ESSE ESTATAMIGO" (mesmo padrão do Dashboard de cursos) ──
let hrFilterKey = null;

function filterHRMember(key) {
  hrFilterKey = (hrFilterKey === key) ? null : key;
  applyHRFilter();
}

function clearHRFilter() {
  hrFilterKey = null;
  applyHRFilter();
}

function applyHRFilter() {
  const clearBtn = document.getElementById('hr-clear-filter');
  if (clearBtn) clearBtn.style.display = hrFilterKey ? '' : 'none';

  document.querySelectorAll('#hr-body .dash-member-card').forEach(card => {
    const isMatch = card.dataset.memberKey === hrFilterKey;
    card.classList.toggle('dash-card-active', isMatch);
    card.style.display = (!hrFilterKey || isMatch) ? '' : 'none';
  });
  const detailWrap = document.getElementById('hr-detail-wrap');
  if (detailWrap) detailWrap.style.display = hrFilterKey ? '' : 'none';
  document.querySelectorAll('#hr-body .dash-member').forEach(det => {
    det.style.display = (det.dataset.memberKey === hrFilterKey) ? '' : 'none';
  });
}
