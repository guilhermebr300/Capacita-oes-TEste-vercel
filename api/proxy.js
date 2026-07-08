export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // pega o path da query string — vem como string "team/123/space" 
  const rawPath = req.query.path;
  if (!rawPath) { res.status(400).json({ error: 'path obrigatório' }); return; }

  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'CLICKUP_API_KEY não configurada na Vercel' }); return; }

  // monta URL completa do ClickUp
  const clickupBase = 'https://api.clickup.com/api/v2';
  const segment = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  const clickupUrl = `${clickupBase}/${segment}`;

  // repassa query params extras (ex: archived=false, page=0)
  const extraParams = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fullUrl = extraParams ? `${clickupUrl}?${extraParams}` : clickupUrl;

  try {
    const options = {
      method: req.method,
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
    };
    if (req.method === 'POST' && req.body) {
      options.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const r = await fetch(fullUrl, options);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno: ' + e.message });
  }
}
