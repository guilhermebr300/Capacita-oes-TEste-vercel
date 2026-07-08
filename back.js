// Proxy da Vercel — a API Key fica segura no servidor
const BASE = '/api/proxy';

let allCourses = [], allStatuses = [], memberListId = null;
let workspaceMembers = [];
let statusUserMap = {};

// ── API KEY salva no navegador ────────────────────────────
// (usada apenas para identificar o usuário logado se necessário)
// A key real fica na Vercel — o campo abaixo pode ficar vazio
function getKey() { return document.getElementById('apiKey').value.trim(); }

function saveKey() {
  const key = getKey();
  if (key) {
    localStorage.setItem('clickup_api_key', key);
    const badge = document.getElementById('key-saved-badge');
    if (badge) badge.style.display = 'inline-flex';
  }
}

function loadSavedKey() {
  const saved = localStorage.getItem('clickup_api_key');
  if (saved) {
    const input = document.getElementById('apiKey');
    if (input) input.value = saved;
    const badge = document.getElementById('key-saved-badge');
    if (badge) badge.style.display = 'inline-flex';
  }
}

function clearKey() {
  localStorage.removeItem('clickup_api_key');
  const input = document.getElementById('apiKey');
  if (input) input.value = '';
  const badge = document.getElementById('key-saved-badge');
  if (badge) badge.style.display = 'none';
}

window.addEventListener('DOMContentLoaded', loadSavedKey);

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

// GET
async function apiFetch(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.err || e.error || 'HTTP ' + r.status); }
  return r.json();
}

// POST
async function apiPost(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.err || e.error || 'HTTP ' + r.status); }
  return r.json();
}

// ── CONECTAR ──────────────────────────────────────────────
async function loadWorkspace() {
  showMsg('msg-connect', 'Conectando...', 'info');
  ['section-lists','section-courses','section-members','section-action']
    .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('section-hidden'); });

  try {
    const teams = await apiFetch('/team');
    if (!teams.teams?.length) { showMsg('msg-connect', 'Nenhum workspace encontrado.', 'error'); return; }
    const teamId = teams.teams[0].id;

    // membros do workspace
    try {
      const teamData = await apiFetch(`/team/${teamId}`);
      workspaceMembers = (teamData.team?.members || []).map(m => ({
        id: String(m.user.id),
        name: m.user.username || m.user.email,
        email: m.user.email,
      }));
    } catch(e) {
      workspaceMembers = [];
      console.warn('Usuários não carregados:', e.message);
    }

    // todas as listas
    const spaces = await apiFetch(`/team/${teamId}/space?archived=false`);
    let allLists = [];
    for (const sp of spaces.spaces) {
      const fd = await apiFetch(`/space/${sp.id}/folder?archived=false`);
      for (const fo of fd.folders) {
        const ld = await apiFetch(`/folder/${fo.id}/list?archived=false`);
        for (const l of ld.lists) allLists.push({ id: l.id, label: `${sp.name} / ${fo.name} / ${l.name}`, raw: l.name });
      }
      const rd = await apiFetch(`/space/${sp.id}/list?archived=false`);
      for (const l of rd.lists) allLists.push({ id: l.id, label: `${sp.name} / ${l.name}`, raw: l.name });
    }
    if (!allLists.length) { showMsg('msg-connect', 'Nenhuma lista encontrada.', 'error'); return; }

    const selC = document.getElementById('sel-courses');
    const selM = document.getElementById('sel-members');
    selC.innerHTML = '<option value="">— selecione a lista de cursos —</option>';
    selM.innerHTML = '<option value="">— selecione a lista de membros —</option>';
    for (const l of allLists) {
      const n = l.raw.toLowerCase();
      selC.appendChild(Object.assign(new Option(l.label, l.id), { selected: n.includes('curso') || n.includes('capacit') }));
      selM.appendChild(Object.assign(new Option(l.label, l.id), { selected: n === 'membros' || n.includes('membro') }));
    }

    // carrega mapa de vínculos salvo
    const saved = localStorage.getItem('statusUserMap');
    statusUserMap = saved ? JSON.parse(saved) : {};

    document.getElementById('section-lists').classList.remove('section-hidden');
    document.getElementById('num-1').classList.add('done');
    document.getElementById('num-1').textContent = '✓';
    showMsg('msg-connect', '✓ Conectado com sucesso!', 'success');
    if (selC.value) loadCourses();
    if (selM.value) loadMemberStatuses();
  } catch(e) { showMsg('msg-connect', 'Erro: ' + e.message, 'error'); }
}

// ── CURSOS ────────────────────────────────────────────────
async function loadCourses() {
  const listId = document.getElementById('sel-courses').value;
  if (!listId) return;
  document.getElementById('section-courses').classList.add('section-hidden');
  allCourses = [];
  try {
    const data = await apiFetch(`/list/${listId}/task?archived=false&page=0`);
    const tasks = data.tasks || [];
    const details = await Promise.all(tasks.map(t => apiFetch(`/task/${t.id}`).catch(() => t)));
    allCourses = details.map(d => ({
      id: d.id, name: d.name, tags: d.tags || [],
      description: d.description || '',
      markdown_description: d.markdown_description || '',
      checklists: d.checklists || []
    }));
    const el = document.getElementById('courses-list');
    document.getElementById('section-courses').classList.remove('section-hidden');
    if (!allCourses.length) { el.innerHTML = '<span class="empty">Nenhuma tarefa encontrada.</span>'; return; }
    document.getElementById('count-courses').textContent = allCourses.length + ' cursos';
    let html = `<label class="select-all-row"><input type="checkbox" onchange="toggleAll('course',this.checked)"> Selecionar todos</label><div class="list-grid">`;
    for (const c of allCourses) {
      const tagHtml = c.tags.map(t => `<span class="tag">${t.name}</span>`).join('');
      const total = c.checklists.reduce((a, cl) => a + (cl.items?.length || 0), 0);
      const badge = total > 0 ? `<span class="checklist-badge">✓ ${total} itens</span>` : '';
      html += `<div class="check-item" id="ci-c-${c.id}">
        <input type="checkbox" class="chk-course" value="${c.id}" onchange="onCheck(this,'ci-c-${c.id}')">
        <label onclick="this.previousElementSibling.click()">${c.name}${tagHtml}${badge}</label>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
    updateSummary();
  } catch(e) { showMsg('msg-lists', 'Erro ao carregar cursos: ' + e.message, 'error'); }
}

// ── MEMBROS (STATUS + VÍNCULO DE USUÁRIO) ─────────────────
async function loadMemberStatuses() {
  const listId = document.getElementById('sel-members').value;
  if (!listId) return;
  memberListId = listId;
  document.getElementById('section-members').classList.add('section-hidden');
  allStatuses = [];
  try {
    const data = await apiFetch(`/list/${listId}`);
    allStatuses = (data.statuses || [])
      .filter(s => s.type !== 'closed')
      .map(s => ({ name: s.status, color: s.color || '#4BAED4' }));
    const el = document.getElementById('members-list');
    document.getElementById('section-members').classList.remove('section-hidden');
    if (!allStatuses.length) { el.innerHTML = '<span class="empty">Nenhum status encontrado.</span>'; return; }
    document.getElementById('count-members').textContent = allStatuses.length + ' membros';

    const userOptions = workspaceMembers.map(m => `<option value="${m.id}">${m.name}</option>`).join('');

    let html = `<label class="select-all-row"><input type="checkbox" onchange="toggleAll('member',this.checked)"> Selecionar todos</label>
    <div class="member-hint">💡 Vincule cada membro ao usuário do ClickUp — ele será atribuído automaticamente e receberá notificação</div>
    <div class="list-grid">`;
    for (const s of allStatuses) {
      const sid = s.name.replace(/[^a-zA-Z0-9]/g, '_');
      html += `<div class="check-item" id="ci-m-${sid}">
        <input type="checkbox" class="chk-member" value="${s.name}" onchange="onCheck(this,'ci-m-${sid}')">
        <span class="status-dot" style="background:${s.color}"></span>
        <label onclick="this.previousElementSibling.previousElementSibling.click()" style="min-width:120px">${s.name}</label>
        <select class="user-select" data-status="${s.name}" onchange="saveStatusUser('${s.name}',this.value)">
          <option value="">— sem vínculo —</option>${userOptions}
        </select>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;

    // restaura vínculos salvos
    document.querySelectorAll('.user-select').forEach(sel => {
      if (statusUserMap[sel.dataset.status]) sel.value = statusUserMap[sel.dataset.status];
    });
    updateSummary();
  } catch(e) { showMsg('msg-lists', 'Erro ao carregar membros: ' + e.message, 'error'); }
}

function saveStatusUser(statusName, userId) {
  statusUserMap[statusName] = userId;
  localStorage.setItem('statusUserMap', JSON.stringify(statusUserMap));
}

// ── CHECKS & SUMMARY ─────────────────────────────────────
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
    const withUser = [...document.querySelectorAll('.chk-member:checked')].filter(cb => statusUserMap[cb.value]).length;
    document.getElementById('summary').innerHTML =
      `Serão criadas <strong>${nc * nm}</strong> tarefa(s): <strong>${nc}</strong> curso(s) × <strong>${nm}</strong> membro(s).<br>
       <span style="font-size:12px;color:var(--muted)">✓ ${withUser} de ${nm} membros com responsável vinculado.</span>`;
  } else {
    sect.classList.add('section-hidden');
  }
}

// ── COPIAR CURSOS ─────────────────────────────────────────
async function copyCourses() {
  const selectedCourseIds = [...document.querySelectorAll('.chk-course:checked')].map(c => c.value);
  const selectedStatuses  = [...document.querySelectorAll('.chk-member:checked')].map(c => c.value);
  const courses = allCourses.filter(c => selectedCourseIds.includes(c.id));
  const total = courses.length * selectedStatuses.length;
  let done = 0, errors = 0;
  const log = [];

  document.getElementById('btn-copy').disabled = true;
  document.getElementById('progress-wrap').style.display = '';
  document.getElementById('result-list').innerHTML = '';
  hideMsg('msg-result');

  for (const statusName of selectedStatuses) {
    const assigneeId = statusUserMap[statusName] || null;
    for (const course of courses) {
      document.getElementById('progress-label').textContent = `Copiando "${course.name}" → "${statusName}"...`;
      try {
        const body = { name: course.name, status: statusName };
        if (course.markdown_description) body.markdown_description = course.markdown_description;
        else if (course.description) body.description = course.description;
        if (assigneeId) body.assignees = [parseInt(assigneeId)];

        const created = await apiPost(`/list/${memberListId}/task`, body);

        for (const cl of course.checklists) {
          const newCl = await apiPost(`/task/${created.id}/checklist`, { name: cl.name || 'Checklist' });
          const clId = newCl.checklist?.id;
          if (!clId) continue;
          for (const item of (cl.items || []))
            await apiPost(`/checklist/${clId}/checklist_item`, { name: item.name, resolved: false });
        }

        const userLabel = assigneeId ? ` → atribuído a ${workspaceMembers.find(m => m.id == assigneeId)?.name || '?'}` : '';
        log.push({ ok: true, text: `✓ ${course.name} → ${statusName}${userLabel}` });
      } catch(e) {
        errors++;
        log.push({ ok: false, text: `✗ ${course.name} → ${statusName}: ${e.message}` });
      }
      done++;
      document.getElementById('progress-fill').style.width = Math.round(done / total * 100) + '%';
    }
  }

  document.getElementById('btn-copy').disabled = false;
  document.getElementById('progress-wrap').style.display = 'none';
  document.getElementById('result-list').innerHTML = log.map(l => `<div class="result-item ${l.ok?'ok':'err'}">${l.text}</div>`).join('');
  document.getElementById('num-5').classList.add('done');
  document.getElementById('num-5').textContent = errors === 0 ? '✓' : '!';
  showMsg('msg-result',
    errors === 0 ? `✓ ${done} tarefa(s) criada(s) e responsáveis notificados!` : `${done - errors} criadas, ${errors} com erro.`,
    errors === 0 ? 'success' : 'warn'
  );
}

// ── DASHBOARD ─────────────────────────────────────────────
async function loadDashboard() {
  if (!memberListId) {
    const listId = document.getElementById('sel-members')?.value;
    if (!listId) { document.getElementById('dashboard-body').innerHTML = '<div class="dash-loading">Conecte ao ClickUp na aba anterior primeiro.</div>'; return; }
    memberListId = listId;
  }
  document.getElementById('dashboard-body').innerHTML = '<div class="dash-loading">Carregando dados...</div>';
  try {
    const data = await apiFetch(`/list/${memberListId}/task?archived=false&subtasks=true&page=0`);
    const tasks = data.tasks || [];

    const byStatus = {};
    for (const t of tasks) {
      const status = t.status?.status || 'sem status';
      if (!byStatus[status]) byStatus[status] = [];
      byStatus[status].push(t);
    }

    const details = await Promise.all(tasks.map(t => apiFetch(`/task/${t.id}`).catch(() => null)));
    const detailMap = {};
    for (const d of details) if (d) detailMap[d.id] = d;

    let html = '';
    const statusNames = Object.keys(byStatus).sort();
    if (!statusNames.length) {
      html = '<div class="empty">Nenhum dado encontrado.</div>';
    } else {
      for (const status of statusNames) {
        const memberTasks = byStatus[status];
        const userId = statusUserMap[status];
        const user = workspaceMembers.find(m => m.id == userId);
        html += `<div class="dash-member">
          <div class="dash-member-header">
            <span class="status-dot" style="background:${allStatuses.find(s=>s.name===status)?.color||'#4BAED4'}"></span>
            <strong>${status}</strong>
            ${user ? `<span class="dash-user-badge">${user.name}</span>` : ''}
            <span class="dash-count">${memberTasks.length} curso(s)</span>
          </div>`;
        if (!memberTasks.length) {
          html += `<div class="dash-empty-member">Nenhum curso atribuído.</div>`;
        } else {
          html += `<div class="dash-courses">`;
          for (const task of memberTasks) {
            const d = detailMap[task.id];
            const checklists = d?.checklists || [];
            const totalItems = checklists.reduce((a, cl) => a + (cl.items?.length || 0), 0);
            const doneItems  = checklists.reduce((a, cl) => a + (cl.items?.filter(i=>i.resolved).length || 0), 0);
            const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
            const isClosed = task.status?.type === 'closed';
            html += `<div class="dash-course-row">
              <div class="dash-course-name ${isClosed?'done-text':''}">${isClosed?'✓ ':''}${task.name}</div>
              <div class="dash-progress-wrap">
                <div class="dash-progress-bar">
                  <div class="dash-progress-fill" style="width:${pct}%;background:${pct===100?'var(--success)':'var(--blue)'}"></div>
                </div>
                <span class="dash-pct">${doneItems}/${totalItems} itens · ${pct}%</span>
              </div>
            </div>`;
          }
          html += `</div>`;
        }
        html += `</div>`;
      }
    }
    document.getElementById('dashboard-body').innerHTML = html;
  } catch(e) {
    document.getElementById('dashboard-body').innerHTML = `<div class="msg show error">Erro: ${e.message}</div>`;
  }
}
