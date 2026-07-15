export const config = { api: { bodyParser: true } };

const ALLOWED_DOMAIN = 'estatjr.com.br';
const TIMEOUT_MS = 15000; // 15 segundos max

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Email');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

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
