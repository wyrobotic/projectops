# ProjectOPS — Strategic Layer

A personal project portfolio management tool that sits above task managers like ClickUp, providing an executive-level strategic view across Verticals → Goals → Projects.

## Architecture

```
projectops/
  public/
    index.html        ← Full single-page app (HTML/CSS/JS)
  api/
    clickup.js        ← Vercel serverless proxy for ClickUp API
  vercel.json         ← Vercel routing config
  README.md
```

## Deploy to Vercel

### 1. Push to GitHub
```bash
cd projectops
git init
git add .
git commit -m "Initial ProjectOPS deploy"
gh repo create projectops --private
git push -u origin main
```

### 2. Import to Vercel
1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your `projectops` GitHub repo
3. Framework Preset: **Other**
4. Root Directory: leave as `/`
5. Click **Deploy**

### 3. Set Environment Variable
In your Vercel project dashboard:
- Go to **Settings → Environment Variables**
- Add: `CLICKUP_API_TOKEN` = your ClickUp Personal API Token
  - Get this from: ClickUp → Profile → Apps → API Token
- Redeploy after adding the variable

### 4. Configure Verticals
1. In ProjectOPS, create a Vertical
2. In ClickUp, create a Space using your preferred template
3. Copy the Space ID from the ClickUp URL:
   `https://app.clickup.com/[workspace]/v/l/[SPACE_ID]/...`
4. Paste the Space ID into the Vertical record in ProjectOPS
5. Use "Verify Space" to confirm the connection

## How It Works

- **Verticals** = ClickUp Spaces (manually linked via Space ID)
- **Goals** = ClickUp Folders (auto-created on Goal save)
- **Projects** = ClickUp Lists (auto-created on Project save)
- **Archive Project** = Archives the ClickUp List via API

## Data

All data is persisted in browser `localStorage` under the key `projectops_v3`.
Export to plain text, Markdown, or CSV via the Export button.

## ClickUp API Token

The token is stored as a Vercel environment variable (`CLICKUP_API_TOKEN`) and
never exposed to the browser. All ClickUp API calls are proxied through the
`/api/clickup` serverless function.
