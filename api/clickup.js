export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiToken = process.env.CLICKUP_API_TOKEN;
  if (!apiToken) {
    return res.status(500).json({ error: 'CLICKUP_API_TOKEN environment variable not set' });
  }

  // path comes in as ?path=/space/123/folder etc
  const { path, ...queryParams } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const queryString = new URLSearchParams(queryParams).toString();
  const url = `https://api.clickup.com/api/v2${path}${queryString ? '?' + queryString : ''}`;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': apiToken,
        'Content-Type': 'application/json',
      },
    };

    if (req.method !== 'GET' && req.method !== 'DELETE' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
