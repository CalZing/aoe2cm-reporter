// AoE2 CM Reporter – Node.js server
// Proxies requests to aoe2cm.net and manages live/post-draft Socket.IO sessions.

const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const AOE2CM_URL = process.env.AOE2CM_URL || 'https://aoe2cm.net';

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// Proxy civ/map images from aoe2cm.net (avoids CORS issues in browser)
app.get('/images/*', async (req, res) => {
    try {
        const r = await fetch(`${AOE2CM_URL}${req.path}`);
        if (!r.ok) { res.status(404).send('Not found'); return; }
        const ct = r.headers.get('content-type');
        if (ct) res.set('Content-Type', ct);
        res.set('Cache-Control', 'public, max-age=604800');
        res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.status(500).send('Image fetch failed'); }
});

// --- Socket.IO event handlers ---

io.on('connection', (client) => {
    console.log('[connect]', client.id);
    let liveSession = null;

    // == Fetch preset metadata (name preview) ==
    client.on('fetch_preset', async (data, ack) => {
        const { presetId } = data;
        try {
            const res = await fetch(`${AOE2CM_URL}/api/preset/${encodeURIComponent(presetId)}`);
            if (!res.ok) { ack({ error: `Preset not found (${res.status})` }); return; }
            const preset = await res.json();
            ack({ name: preset.name, turnCount: preset.turns.length });
        } catch (e) {
            ack({ error: e.message });
        }
    });

    // == Create draft on aoe2cm.net ==
    client.on('create_draft', async (data, ack) => {
        const { presetId, hostName, guestName } = data;
        console.log(`[create_draft] preset=${presetId} host=${hostName} guest=${guestName}`);
        try {
            const presetRes = await fetch(`${AOE2CM_URL}/api/preset/${encodeURIComponent(presetId)}`);
            if (!presetRes.ok) { ack({ error: `Preset not found (${presetRes.status})` }); return; }
            const preset = await presetRes.json();

            console.log(`[create_draft] Preset "${preset.name}" loaded, ${preset.turns.length} turns`);
            const createRes = await fetch(`${AOE2CM_URL}/api/draft/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preset, participants: { host: hostName, guest: guestName } }),
            });
            const createData = await createRes.json();
            if (createData.status !== 'ok') {
                ack({ error: `Draft creation failed: ${JSON.stringify(createData.validationErrors || createData)}` });
                return;
            }

            const draftId = createData.draftId;
            console.log(`[create_draft] OK draftId=${draftId}`);
            ack({ preset, draftId, spectatorUrl: `${AOE2CM_URL}/draft/${draftId}` });
        } catch (e) {
            console.error('[create_draft] Error:', e);
            ack({ error: `Network error: ${e.message}` });
        }
    });

    // == Live mode: connect sockets and forward acts in real-time ==
    client.on('live_connect', async (data, ack) => {
        const { draftId, hostName, guestName } = data;
        console.log(`[live_connect] ${draftId}`);
        try {
            const hostSocket = ioClient(AOE2CM_URL, { query: { draftId }, transports: ['websocket'], forceNew: true });
            const guestSocket = ioClient(AOE2CM_URL, { query: { draftId }, transports: ['websocket'], forceNew: true });
            liveSession = { draftId, hostSocket, guestSocket, finished: false };

            await Promise.all([
                waitForRole(hostSocket, hostName, 'HOST'),
                waitForRole(guestSocket, guestName, 'GUEST'),
            ]);

            hostSocket.on('playerEvent', (e) => client.emit('live_player_event', e));
            hostSocket.on('adminEvent', (e) => client.emit('live_admin_event', e));
            hostSocket.on('disconnect', () => {
                if (liveSession && !liveSession.finished) {
                    liveSession.finished = true;
                    client.emit('live_finished', {});
                }
            });

            await Promise.all([
                emitWithAck(hostSocket, 'ready', {}),
                emitWithAck(guestSocket, 'ready', {}),
            ]);
            console.log('[live_connect] Both ready, draft started');
            ack({ status: 'ok' });
        } catch (e) {
            console.error('[live_connect] Error:', e);
            ack({ error: e.message });
        }
    });

    client.on('live_act', async (data, ack) => {
        if (!liveSession) { ack({ error: 'No live session' }); return; }
        const { executingPlayer, player, actionType, chosenOptionId } = data;
        const socket = executingPlayer === 'HOST' ? liveSession.hostSocket : liveSession.guestSocket;
        if (!socket?.connected) { ack({ error: `${executingPlayer} socket not connected` }); return; }

        socket.emit('act', {
            player, executingPlayer, actionType, chosenOptionId,
            isRandomlyChosen: false, offset: 0,
        }, (response) => {
            if (response?.status === 'error') {
                ack({ error: `Validation: ${JSON.stringify(response.validationErrors)}` });
            } else {
                ack({ status: 'ok' });
            }
        });
    });

    // == Post-draft mode: replay completed events ==
    client.on('upload_draft', async (data, ack) => {
        const { draftId, preset, hostName, guestName, events } = data;
        console.log(`[upload] ${events.length} events → ${draftId}`);
        try {
            await replayDraft(draftId, hostName, guestName, preset.turns, events, client);
            ack({ status: 'ok' });
        } catch (e) {
            console.error('[upload] Error:', e);
            ack({ error: e.message });
        }
    });

    // == Cleanup ==
    client.on('disconnect', () => {
        console.log('[disconnect]', client.id);
        if (liveSession) {
            liveSession.hostSocket?.disconnect();
            liveSession.guestSocket?.disconnect();
            liveSession = null;
        }
    });
});

// --- Post-draft replay engine ---

async function replayDraft(draftId, hostName, guestName, turns, playerEvents, client) {
    const hostSocket = ioClient(AOE2CM_URL, { query: { draftId }, transports: ['websocket'], forceNew: true });
    const guestSocket = ioClient(AOE2CM_URL, { query: { draftId }, transports: ['websocket'], forceNew: true });
    const ADMIN_DELAY = 2500; // aoe2cm server uses 2000ms per admin event
    const cleanup = () => { hostSocket.disconnect(); guestSocket.disconnect(); };

    try {
        await Promise.all([
            waitForRole(hostSocket, hostName, 'HOST'),
            waitForRole(guestSocket, guestName, 'GUEST'),
        ]);
        client.emit('upload_progress', { phase: 'connected', current: 0, total: playerEvents.length });

        await Promise.all([
            emitWithAck(hostSocket, 'ready', {}),
            emitWithAck(guestSocket, 'ready', {}),
        ]);

        // Skip leading admin turns
        let turnIdx = 0;
        let leadingAdmins = 0;
        while (turnIdx < turns.length && isAdminTurn(turns[turnIdx])) { leadingAdmins++; turnIdx++; }
        if (leadingAdmins > 0) await delay(leadingAdmins * ADMIN_DELAY);

        client.emit('upload_progress', { phase: 'replaying', current: 0, total: playerEvents.length });

        // Fire player events, respecting admin turn delays
        let evtIdx = 0;
        while (evtIdx < playerEvents.length && turnIdx < turns.length) {
            const evt = playerEvents[evtIdx];
            const socket = evt.executingPlayer === 'HOST' ? hostSocket : guestSocket;
            const result = await emitWithAck(socket, 'act', {
                player: evt.player, executingPlayer: evt.executingPlayer,
                actionType: evt.actionType, chosenOptionId: evt.chosenOptionId,
                isRandomlyChosen: false, offset: 0,
            });
            if (result?.status === 'error') {
                throw new Error(`Event ${evtIdx + 1}: ${JSON.stringify(result.validationErrors)}`);
            }

            evtIdx++; turnIdx++;
            client.emit('upload_progress', { phase: 'replaying', current: evtIdx, total: playerEvents.length });

            // Wait for consecutive admin turns that follow
            let adminCount = 0;
            while (turnIdx < turns.length && isAdminTurn(turns[turnIdx])) { adminCount++; turnIdx++; }
            await delay(adminCount > 0 ? adminCount * ADMIN_DELAY : 200);
        }

        await delay(2000);
        client.emit('upload_complete', { draftId });
    } catch (e) {
        client.emit('upload_error', { message: e.message });
    } finally { cleanup(); }
}

// --- Helpers ---

function isAdminTurn(t) {
    return t.executingPlayer === 'NONE' ||
        ['REVEAL_ALL', 'REVEAL_PICKS', 'REVEAL_BANS', 'REVEAL_SNIPES', 'PAUSE', 'RESET_CL'].includes(t.action);
}

function waitForRole(socket, name, role) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${role} timeout`)), 15000);
        socket.on('connect', () => {
            socket.emit('set_role', { name, role }, () => { clearTimeout(t); resolve(); });
        });
        socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    });
}

function emitWithAck(socket, event, data) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 10000);
        socket.emit(event, data, (r) => { clearTimeout(t); resolve(r); });
    });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  AoE2 CM Reporter`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  → Proxying to: ${AOE2CM_URL}\n`);
});
