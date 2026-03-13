# AoE2 CM Reporter

**Fysisk draft-reporter för [aoe2cm.net](https://aoe2cm.net)**

En webbapp som låter en domare rapportera en fysisk AoE2 Captains Mode-draft.
Draften körs **helt lokalt** utan tidsbegränsning. När alla val är gjorda laddas
resultatet upp till aoe2cm.net, där det syns som en vanlig avslutad draft.

## Så funkar det

Appen har två lägen:

### 📋 Post-draft (standard)
```
1. Skapa preset    →  aoe2cm.net
2. Starta draft    →  Appen skapar draft + spectator-URL direkt
3. Kör draft       →  Helt lokalt, ingen timer, undo-knapp
4. Upload          →  Appen spelar upp alla events automatiskt
5. Se resultat     →  aoe2cm.net/draft/<id>
```
Bäst för: fysiska drafts, brädspels-draften, situationer där man vill
kunna ta sin tid.

### 📡 Live (med timer)
```
1. Skapa preset    →  aoe2cm.net
2. Starta draft    →  Appen skapar draft + ansluter direkt
3. Rapportera live →  Varje val skickas direkt (30s timer per val)
4. Klart           →  Spectators ser allt i realtid
```
Bäst för: matcher där spectators vill följa draften steg för steg i
realtid på stream.

## Installation (Windows)

### 1. Installera Node.js

Ladda ner från [nodejs.org](https://nodejs.org) (LTS-versionen). Kör installern.

Verifiera i cmd/PowerShell:
```
node --version
npm --version
```

### 2. Packa upp och installera

```
cd C:\Users\ditt-namn\Downloads\aoe2cm-reporter
npm install
```

### 3. Starta

```
npm start
```

### 4. Öppna

Gå till `http://localhost:3000` i din webbläsare.

## iPad-åtkomst

Om iPaden och datorn är på samma WiFi, öppna `http://<datorns-ip>:3000` på iPaden.
Hitta IP:n med `ipconfig` i cmd.

Tips: I Safari, tryck Dela → Lägg till på hemskärmen för att köra som app.

## Hosta publikt

Om du har en VPS (Linux-server med SSH-access):

```bash
# Installera Node.js på servern
# Kopiera projektfilerna dit
npm install
PORT=3000 npm start
```

Med nginx som reverse proxy:
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

## Environment-variabler

| Variabel | Default | Beskrivning |
|----------|---------|-------------|
| `PORT` | `3000` | Port att lyssna på |
| `AOE2CM_URL` | `https://aoe2cm.net` | URL till aoe2cm-servern |

## Arkitektur

```
┌────────────┐              ┌──────────┐
│  Webbläsare │  Socket.IO   │  Node.js │
│  (draft UI) │◄────────────►│  server  │
└────────────┘              └────┬─────┘
                                 │
                Post-draft:      │  Live:
                1) Hämta preset  │  1) Hämta preset
                2) Skapa draft   │  2) Skapa draft
                3) Ladda upp     │  3) Anslut + forward
                   färdig draft  │     varje act direkt
                                 ▼
                           ┌──────────┐
                           │aoe2cm.net│
                           └──────────┘
```

I **post-draft** körs all draft-logik lokalt i webbläsaren. Servern
behövs bara som proxy mot aoe2cm.net (pga CORS).

I **live-mode** upprätthåller servern två Socket.IO-anslutningar till
aoe2cm.net (en som HOST, en som GUEST) och vidarebefordrar varje val
i realtid.

## Licens

Ej associerat med eller godkänt av Microsoft eller Siege Engineers.
Age of Empires © Microsoft Corporation.
