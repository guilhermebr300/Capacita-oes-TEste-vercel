export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { path } = req.query;
  if (!path) { res.status(400).json({ error: 'path obrigatório' }); return; }

  const apiKey = process.env.CLICKUP_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'CLICKUP_API_KEY não configurada na Vercel' }); return; }

  // monta URL do ClickUp
  const segments = Array.isArray(path) ? path.join('/') : path;
  const clickupUrl = `https://api.clickup.com/api/v2/${segments}`;

  // repassa query params (exceto 'path')
  const params = Object.entries(req.query)
    .filter(([k]) => k !== 'path')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const fullUrl = params ? `${clickupUrl}?${params}` : clickupUrl;

  try {
    const options = {
      method: req.method,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' }
    };
    if (req.method === 'POST' && req.body) {
      options.body = JSON.stringify(req.body);
    }
    const r = await fetch(fullUrl, options);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
