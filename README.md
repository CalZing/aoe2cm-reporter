# AoE2 CM Reporter

**Physical draft reporter for [aoe2cm.net](https://aoe2cm.net)**

A web app that lets a referee report a physical Age of Empires II Captains Mode
draft. The result is published to aoe2cm.net where spectators can view it.

## Modes

### 📋 Post-draft (default)
Run the entire draft locally with no time pressure. When all picks/bans are done,
the app uploads the result to aoe2cm.net in one go. Undo is available.

### 📡 Live
Each pick/ban is sent to aoe2cm.net in real-time (30s timer per turn). Spectators
see the draft unfold step by step. No undo.

Both modes create the draft on aoe2cm.net immediately at setup, so the spectator
URL is available before the first pick.

## Preset input

The preset field accepts any of:
- A raw preset ID: `WBp4y`
- A full URL: `https://aoe2cm.net/preset/WBp4y`

The preset name is shown automatically as you type or paste.

## Direct links

You can pre-fill the preset by adding it to the URL:
```
https://your-host.com/?preset=WBp4y
```
This is useful for sending a ready-to-go link to a less technical referee.

## Installation

Requires [Node.js](https://nodejs.org) (LTS, v18+).

```bash
cd aoe2cm-reporter
npm install
npm start
```

Open `http://localhost:3000` in your browser.

### Change port

```bash
PORT=8080 npm start
```

### iPad access

If the iPad and your computer are on the same network, open
`http://<your-computers-ip>:3000` on the iPad. Find your IP with `ipconfig` (Windows)
or `ifconfig` (Mac/Linux). In Safari: Share → Add to Home Screen to run it as an app.

## Hosting

### Render (free)

1. Push the repo to GitHub
2. Go to [render.com](https://render.com), sign in with GitHub
3. New → Web Service → select the repo
4. Build Command: `npm install`, Start Command: `npm start`
5. Free plan works fine

### VPS with nginx

```bash
npm install
PORT=3000 npm start
```

```nginx
server {
    listen 80;
    server_name draft.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## Architecture

```
Browser (draft UI)  ◄──Socket.IO──►  Node.js server  ◄──Socket.IO──►  aoe2cm.net
                                          │
                                          ├─ POST /api/preset/:id  (fetch preset)
                                          ├─ POST /api/draft/new   (create draft)
                                          └─ GET  /images/*        (proxy images)
```

In **post-draft** mode, all draft logic runs in the browser. The server is only
used to proxy API calls (CORS) and replay the completed draft via Socket.IO.

In **live** mode, the server maintains two persistent Socket.IO connections to
aoe2cm.net (one as HOST, one as GUEST) and forwards each action in real-time.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `AOE2CM_URL` | `https://aoe2cm.net` | aoe2cm server URL |

## License

Not associated with or endorsed by Microsoft or Siege Engineers.
Age of Empires © Microsoft Corporation.
