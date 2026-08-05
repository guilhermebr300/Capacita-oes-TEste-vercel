export const config = { api: { bodyParser: true } };

const ALLOWED_DOMAIN = 'estatjr.com.br';
const TIMEOUT_MS = 15000; // 15 segundos max

// Client ID gerado no Google Cloud Console (não é segredo — é seguro
// deixar ele fixo aqui, é o mesmo valor que já fica público no index.html).
const GOOGLE_CLIENT_ID = '286209182292-l8cvud3b33hp5fapdum6tqg4sk2dcfqg.apps.googleusercontent.com';

// ── PROTEÇÃO DOS DADOS DE RH ──────────────────────────────
// Esconder o botão de RH na tela (index.html) é só cosmético — qualquer
// pessoa logada poderia, tecnicamente, chamar a mesma rota do proxy
// direto pelo console do navegador e pegar dado de RH mesmo sem ver o
// botão. Isso é inaceitável pra anotação pessoal/1:1/status, que só o
// time de RH pode ver.
//
// Por isso, qualquer chamada que precise de dado de RH deve usar o
// prefixo "hr/" no path (ex: "hr/list/123/task" em vez de "list/123/task").
// Esse prefixo obriga o SERVIDOR a confirmar, a cada chamada, que o email
// de quem está pedindo está na lista "Equipe RH" do ClickUp — a mesma
// checagem que o back.js faz pra mostrar o botão, só que agora rodando
// aqui, onde ninguém consegue burlar só editando o JavaScript do navegador.
//
// Cache curto (60s) em memória do processo — funções serverless da Vercel
// reaproveitam a mesma instância entre chamadas próximas ("warm start"),
// então isso evita rebuscar a estrutura do ClickUp a cada clique.
let hrCache = { expiresAt: 0, assigneeIds: null };

async function fetchClickUp(path, apiKey) {
  const r = await fetch(`https://api.clickup.com/api/v2/${path}`, {
    headers: { Authorization: apiKey }
  });
  if (!r.ok) throw new Error('ClickUp respondeu ' + r.status + ' em ' + path);
  return r.json();
}

// Acha o id de quem está atribuído a alguma tarefa na lista "Equipe RH",
// procurando a mesma estrutura que o back.js já usa (Espaço "Trilha de
// Capacitações" → pasta ou lista raiz cujo nome bata com "equipe"+"rh").
async function getHrAssigneeIds(apiKey) {
  const now = Date.now();
  if (hrCache.assigneeIds && hrCache.expiresAt > now) return hrCache.assigneeIds;

  const teams = await fetchClickUp('team', apiKey);
  const teamId = teams.teams?.[0]?.id;
  if (!teamId) return new Set();

  const spaces = await fetchClickUp(`team/${teamId}/space?archived=false`, apiKey);
  const trilhaSpace = (spaces.spaces || []).find(sp => {
    const n = sp.name.toLowerCase();
    return n.includes('trilha') || n.includes('capacita');
  });
  if (!trilhaSpace) return new Set();

  // Marca cada lista candidata com se ela veio de dentro de uma pasta já
  // chamada "gestão de pessoas" — nesse caso o nome da lista só precisa
  // ter "equipe", sem repetir "gestão de pessoas" de novo (mesma lógica
  // usada em back.js/loadWorkspace, pra não haver dois padrões diferentes).
  const candidateLists = [];
  const rootLists = await fetchClickUp(`space/${trilhaSpace.id}/list?archived=false`, apiKey);
  for (const l of (rootLists.lists || [])) candidateLists.push({ list: l, insideGPFolder: false });
  const folders = await fetchClickUp(`space/${trilhaSpace.id}/folder?archived=false`, apiKey);
  for (const fo of (folders.folders || [])) {
    const folderName = fo.name.toLowerCase();
    const insideGPFolder = folderName.includes('gest') && folderName.includes('pessoa');
    const flData = await fetchClickUp(`folder/${fo.id}/list?archived=false`, apiKey);
    for (const l of (flData.lists || [])) candidateLists.push({ list: l, insideGPFolder });
  }

  const hrTeamEntry = candidateLists.find(({ list, insideGPFolder }) => {
    const n = list.name.toLowerCase();
    const byFullName = n.includes('equipe') && n.includes('gest') && n.includes('pessoa');
    const byFolder = insideGPFolder && n.includes('equipe');
    return byFullName || byFolder;
  });
  if (!hrTeamEntry) return new Set();
  const hrTeamList = hrTeamEntry.list;

  const tasksData = await fetchClickUp(`list/${hrTeamList.id}/task?archived=false`, apiKey);
  const ids = new Set();
  for (const t of (tasksData.tasks || [])) {
    for (const a of (t.assignees || [])) ids.add(String(a.id));
  }

  hrCache = { assigneeIds: ids, expiresAt: now + 60000 };
  return ids;
}

async function isEmailHR(email, apiKey) {
  try {
    const teams = await fetchClickUp('team', apiKey);
    const teamId = teams.teams?.[0]?.id;
    if (!teamId) return false;
    const teamData = await fetchClickUp(`team/${teamId}`, apiKey);
    const member = (teamData.team?.members || []).find(
      m => (m.user.email || '').toLowerCase() === email
    );
    if (!member) return false;

    const assigneeIds = await getHrAssigneeIds(apiKey);
    return assigneeIds.has(String(member.user.id));
  } catch (e) {
    return false; // qualquer falha na checagem = nega acesso, nunca libera por engano
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Email');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── login com Google (verificação real) ───────────────
  // Fica ANTES da checagem de X-User-Email de propósito: é justamente
  // aqui que a gente descobre e confirma qual é o email da pessoa —
  // ainda não existe um email "de confiança" antes desse passo.
  // O front-end (handleGoogleCredential em back.js) manda o token (JWT)
  // que o Google devolveu depois do login. Esse token PODE ter sido
  // forjado por qualquer um no navegador, então nunca confiamos nele
  // sem checar — em vez disso, perguntamos pro próprio Google "esse
  // token é seu mesmo, e pra quem ele pertence?" através do endpoint
  // oficial de tokeninfo. Só depois disso o email é considerado válido.
  if (req.query.path === 'google-login') {
    const credential = req.body?.credential;
    if (!credential) {
      res.status(400).json({ error: 'Credencial do Google não informada.' }); return;
    }
    try {
      const gRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
      );
      const payload = await gRes.json();
      if (!gRes.ok) {
        res.status(401).json({ error: 'Token do Google inválido ou expirado.' }); return;
      }
      // o token precisa ter sido emitido para ESTE site (evita reaproveitar
      // um token válido de outro app do Google pra entrar aqui)
      if (payload.aud !== GOOGLE_CLIENT_ID) {
        res.status(401).json({ error: 'Token não pertence a este aplicativo.' }); return;
      }
      // o Google só marca email_verified=true quando confirmou de fato
      // que a pessoa é dona daquele email
      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        res.status(401).json({ error: 'Email do Google não verificado.' }); return;
      }
      const email = (payload.email || '').toLowerCase();
      if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
        res.status(403).json({ error: 'Acesso restrito a contas @' + ALLOWED_DOMAIN }); return;
      }
      res.status(200).json({ ok: true, email });
    } catch (e) {
      res.status(500).json({ error: 'Erro ao validar login do Google: ' + e.message });
    }
    return;
  }

  // ── verifica email ────────────────────────────────────
  const userEmail = (req.headers['x-user-email'] || '').toLowerCase().trim();
  if (!userEmail) {
    res.status(401).json({ error: 'Email não informado.' }); return;
  }
  if (!userEmail.endsWith('@' + ALLOWED_DOMAIN)) {
    res.status(403).json({ error: 'Acesso restrito a emails @' + ALLOWED_DOMAIN }); return;
  }

  const rawPath = req.query.path;

  // rota de validação de email
  if (rawPath === 'auth-check') {
    res.status(200).json({ ok: true, email: userEmail }); return;
  }

  if (!rawPath) { res.status(400).json({ error: 'path obrigatório' }); return; }

  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'CLICKUP_API_KEY não configurada na Vercel.' }); return;
  }

  // ── dados de RH: exige confirmação no servidor, não só o botão escondido ──
  let segment = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  if (segment.startsWith('hr/')) {
    const authorized = await isEmailHR(userEmail, apiKey);
    if (!authorized) {
      res.status(403).json({ error: 'Acesso restrito ao time de Gestão de Pessoas.' }); return;
    }
    segment = segment.slice(3); // remove o prefixo "hr/" antes de repassar pro ClickUp
  }

  // ── monta URL do ClickUp ──────────────────────────────
  const clickupUrl = `https://api.clickup.com/api/v2/${segment}`;
  const extraParams = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fullUrl = extraParams ? `${clickupUrl}?${extraParams}` : clickupUrl;

  // ── fetch com timeout ─────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const options = {
      method: req.method,
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (req.method === 'POST' && req.body) {
      options.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const r = await fetch(fullUrl, options);
    clearTimeout(timer);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      res.status(504).json({ error: 'Timeout: o ClickUp demorou demais para responder.' });
    } else {
      res.status(500).json({ error: 'Erro interno: ' + e.message });
    }
  }
}
