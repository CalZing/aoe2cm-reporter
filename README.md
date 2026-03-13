# AoE2 CM Reporter

**Physical draft reporter for [aoe2cm.net](https://aoe2cm.net)**

En PWA-app som låter en domare rapportera en fysisk AoE2-draft live till aoe2cm.net.
Appen ansluter som **både Host och Guest** till samma draft-session och växlar automatiskt
vilken anslutning som agerar beroende på vems tur det är.

Spectators (stream, publik) kan följa draften live via den vanliga spectator-URLen
på aoe2cm.net.

## Så funkar det

1. Skapa en preset på [aoe2cm.net](https://aoe2cm.net) med obegränsad betänketid
2. Starta appen och mata in preset-ID, host-namn och guest-namn
3. Appen skapar en draft, ansluter som båda spelarna, och readyar upp
4. Rapportera varje val genom att klicka på civilisationen/kartan
5. Spectator-länken visas i appen — öppna den i OBS eller på en annan dator

## Installation

```bash
# Klona eller kopiera projektet
cd aoe2cm-reporter

# Installera beroenden
npm install

# Starta servern
npm start
```

Appen körs på `http://localhost:3000` (standard). Öppna den i Safari på iPaden.

### Ändra port

```bash
PORT=8080 npm start
```

### Hosta publikt (VPS)

```bash
# Med en reverse proxy (nginx/caddy) framför:
PORT=3000 npm start

# Eller direkt på en port:
PORT=80 npm start
```

Exempel nginx-konfiguration:
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

### Environment-variabler

| Variabel | Default | Beskrivning |
|----------|---------|-------------|
| `PORT` | `3000` | Port att lyssna på |
| `AOE2CM_URL` | `https://aoe2cm.net` | URL till aoe2cm-servern |

## Användning på iPad

1. Öppna appen i Safari
2. Tryck "Dela" → "Lägg till på hemskärmen"
3. Appen öppnas som en standalone-app utan webbläsar-UI

## Arkitektur

```
┌──────────┐         ┌──────────────┐         ┌──────────────┐
│  iPad     │ Socket  │  Reporter    │ Socket  │  aoe2cm.net  │
│  (PWA)    │◄──────►│  Server      │◄──────►│  Server      │
│           │   IO    │  (Node.js)   │   IO    │              │
└──────────┘         └──────────────┘         └──────────────┘
                           │                         │
                           │ Socket A: HOST           │
                           │ Socket B: GUEST          │
                           └─────────────────────────┘
```

Servern upprätthåller **två parallella Socket.IO-anslutningar** till aoe2cm.net
per aktiv draft — en som HOST, en som GUEST. Frontend-appen kommunicerar med
servern via sin egen Socket.IO-anslutning, och servern routar `act`-meddelanden
genom rätt socket baserat på turordningen i preseten.

## Tap-to-confirm

För att undvika misstag kräver appen **två tryck** för att bekräfta ett val:
1. Första trycket: markerar valet (gul ram)
2. Andra trycket: bekräftar och skickar till servern

## Licens

Inte associerat med eller godkänt av Microsoft eller Siege Engineers.
Age of Empires © Microsoft Corporation.
