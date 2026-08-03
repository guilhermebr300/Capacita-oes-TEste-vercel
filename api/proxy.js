export const config = { api: { bodyParser: true } };

const ALLOWED_DOMAIN = 'estatjr.com.br';
const TIMEOUT_MS = 15000; // 15 segundos max

// Client ID gerado no Google Cloud Console (não é segredo — é seguro
// deixar ele fixo aqui, é o mesmo valor que já fica público no index.html).
const GOOGLE_CLIENT_ID = '286209182292-l8cvud3b33hp5fapdum6tqg4sk2dcfqg.apps.googleusercontent.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // ── monta URL do ClickUp ──────────────────────────────
  const segment = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
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
