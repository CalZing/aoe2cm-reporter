const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

const PORT = process.env.PORT || 3000;
const AOE2CM_URL = process.env.AOE2CM_URL || 'https://aoe2cm.net';

// --- Civilisation decoding (mirrors aoe2cm2 source) ---

const ALL_CIVS = [
    'Aztecs', 'Berbers', 'Britons', 'Burmese', 'Byzantines', 'Celts', 'Chinese',
    'Ethiopians', 'Franks', 'Goths', 'Huns', 'Incas', 'Indians', 'Italians',
    'Japanese', 'Khmer', 'Koreans', 'Magyars', 'Malay', 'Malians', 'Mayans',
    'Mongols', 'Persians', 'Portuguese', 'Saracens', 'Slavs', 'Spanish',
    'Teutons', 'Turks', 'Vietnamese', 'Vikings', 'Bulgarians', 'Cumans',
    'Lithuanians', 'Tatars', 'Burgundians', 'Sicilians', 'Bohemians', 'Poles',
    'Bengalis', 'Dravidians', 'Gurjaras', 'Hindustanis', 'Romans',
    'Armenians', 'Georgians',
    'Achaemenids', 'Athenians', 'Spartans',
    'Shu', 'Wu', 'Wei', 'Jurchens', 'Khitans',
    'Macedonians', 'Thracians', 'Puru',
    'Mapuche', 'Muisca', 'Tupi',
];

function decodeEncodedCivilisations(encoded) {
    if (!encoded) return [];
    try {
        const bits = [];
        for (const ch of encoded.split('')) {
            const num = parseInt(ch, 16);
            if (isNaN(num)) return [];
            const bin = num.toString(2).padStart(4, '0');
            for (const b of bin) bits.push(b === '1');
        }
        const first = bits.indexOf(true);
        const trimmed = bits.slice(first);

        const civs = [];
        for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i]) {
                const civIndex = trimmed.length - 1 - i;
                if (civIndex < ALL_CIVS.length) {
                    civs.push({
                        id: ALL_CIVS[civIndex],
                        name: ALL_CIVS[civIndex],
                        imageUrls: {
                            unit: `/images/civs/${ALL_CIVS[civIndex].toLowerCase()}.png`,
                            emblem: `/images/civemblems/${ALL_CIVS[civIndex].toLowerCase()}.png`,
                        },
                        i18nPrefix: 'civs.',
                        category: 'default',
                    });
                }
            }
        }
        civs.sort((a, b) => a.name.localeCompare(b.name));
        return civs;
    } catch (e) {
        console.error('Failed to decode civilisations:', e);
        return [];
    }
}

function resolveOptions(preset) {
    if (preset.draftOptions && preset.draftOptions.length > 0) {
        return preset.draftOptions;
    }
    if (preset.encodedCivilisations) {
        return decodeEncodedCivilisations(preset.encodedCivilisations);
    }
    return [];
}

function actionToActionType(action) {
    switch (action) {
        case 'PICK': return 'pick';
        case 'BAN': return 'ban';
        case 'SNIPE': return 'snipe';
        case 'STEAL': return 'steal';
        default: return action.toLowerCase();
    }
}

// --- Active draft sessions ---
const sessions = new Map();

// --- Serve static files ---
app.use(express.static(path.join(__dirname, 'public')));

// Proxy civ/map images from aoe2cm.net
app.get('/images/*', async (req, res) => {
    try {
        const imageUrl = `${AOE2CM_URL}${req.path}`;
        const response = await fetch(imageUrl);
        if (!response.ok) { res.status(404).send('Not found'); return; }
        const contentType = response.headers.get('content-type');
        if (contentType) res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
    } catch (e) {
        res.status(500).send('Image fetch failed');
    }
});

// --- Socket.IO handling ---

io.on('connection', (frontendSocket) => {
    console.log('Frontend client connected:', frontendSocket.id);
    let currentSession = null;

    frontendSocket.on('create_draft', async (data) => {
        const { presetId, hostName, guestName } = data;
        console.log(`Creating draft: preset=${presetId}, host=${hostName}, guest=${guestName}`);

        try {
            // 1. Fetch preset from aoe2cm.net
            const presetRes = await fetch(`${AOE2CM_URL}/api/preset/${encodeURIComponent(presetId)}`);
            if (!presetRes.ok) {
                frontendSocket.emit('error_msg', { message: `Failed to fetch preset: ${presetRes.status}` });
                return;
            }
            const preset = await presetRes.json();
            const options = resolveOptions(preset);

            // 2. Create draft on aoe2cm.net
            const createRes = await fetch(`${AOE2CM_URL}/api/draft/new`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preset,
                    participants: { host: hostName, guest: guestName },
                }),
            });
            const createData = await createRes.json();
            if (createData.status !== 'ok') {
                frontendSocket.emit('error_msg', {
                    message: `Draft creation failed: ${JSON.stringify(createData.validationErrors || createData.message)}`,
                });
                return;
            }

            const draftId = createData.draftId;
            console.log(`Draft created: ${draftId}`);

            // 3. Set up session state
            const session = {
                draftId,
                preset,
                options,
                turns: preset.turns,
                hostName,
                guestName,
                nextAction: 0,
                events: [],
                hostSocket: null,
                guestSocket: null,
                hostRoleSet: false,
                guestRoleSet: false,
                hostReady: false,
                guestReady: false,
                bothPlayersReadySent: false,
                finished: false,
                pendingAct: null,       // tracks last act sent (resolves hidden events)
            };
            sessions.set(draftId, session);
            currentSession = session;

            // 4. Send initial info to frontend
            frontendSocket.emit('draft_created', {
                draftId,
                spectatorUrl: `${AOE2CM_URL}/draft/${draftId}`,
                options,
                turns: preset.turns,
                hostName,
                guestName,
            });

            // 5. Connect two sockets to aoe2cm.net
            await connectPlayerSockets(session, frontendSocket);

        } catch (e) {
            console.error('Error creating draft:', e);
            frontendSocket.emit('error_msg', { message: `Error: ${e.message}` });
        }
    });

    frontendSocket.on('act', (data) => {
        if (!currentSession || currentSession.finished) {
            frontendSocket.emit('error_msg', { message: 'No active draft session' });
            return;
        }

        const { chosenOptionId } = data;
        const session = currentSession;
        const turnIndex = session.nextAction;

        if (turnIndex >= session.turns.length) {
            frontendSocket.emit('error_msg', { message: 'Draft is already complete' });
            return;
        }

        const turn = session.turns[turnIndex];

        // Skip admin turns (REVEAL, PAUSE, etc.) - handled by server automatically
        if (turn.executingPlayer === 'NONE') {
            frontendSocket.emit('error_msg', { message: 'Waiting for admin action from server...' });
            return;
        }

        const actionType = actionToActionType(turn.action);
        const playerEvent = {
            player: turn.player,
            executingPlayer: turn.executingPlayer,
            actionType,
            chosenOptionId,
            isRandomlyChosen: false,
            offset: 0,
        };

        // Determine which socket to use
        const targetSocket = (turn.executingPlayer === 'HOST')
            ? session.hostSocket
            : session.guestSocket;

        if (!targetSocket || !targetSocket.connected) {
            frontendSocket.emit('error_msg', { message: `${turn.executingPlayer} socket is not connected` });
            return;
        }

        console.log(`Sending act via ${turn.executingPlayer}:`, playerEvent);

        // Store pending act so we can resolve hidden events
        session.pendingAct = {
            chosenOptionId,
            player: turn.player,
            executingPlayer: turn.executingPlayer,
            actionType,
        };

        targetSocket.emit('act', playerEvent, (response) => {
            console.log('Act response:', response);
            if (response && response.status === 'error') {
                session.pendingAct = null;
                frontendSocket.emit('error_msg', {
                    message: `Validation error: ${JSON.stringify(response.validationErrors)}`,
                });
            }
        });
    });

    frontendSocket.on('disconnect', () => {
        console.log('Frontend client disconnected:', frontendSocket.id);
        if (currentSession) {
            cleanupSession(currentSession);
        }
    });
});

async function connectPlayerSockets(session, frontendSocket) {
    const { draftId, hostName, guestName } = session;

    return new Promise((resolve, reject) => {
        let hostConnected = false;
        let guestConnected = false;

        function checkBothConnected() {
            if (hostConnected && guestConnected) {
                resolve();
            }
        }

        // --- HOST SOCKET ---
        const hostSocket = ioClient(AOE2CM_URL, {
            query: { draftId },
            transports: ['websocket'],
            forceNew: true,
        });
        session.hostSocket = hostSocket;

        hostSocket.on('connect', () => {
            console.log(`HOST socket connected for draft ${draftId}`);

            hostSocket.emit('set_role', { name: hostName, role: 'HOST' }, (draftConfig) => {
                console.log('HOST role set');
                session.hostRoleSet = true;
                hostConnected = true;
                checkBothConnected();
                tryReadyUp(session, frontendSocket);
            });
        });

        hostSocket.on('draft_state', (state) => {
            console.log('HOST received draft_state');
        });

        hostSocket.on('playerEvent', (event) => {
            console.log('HOST received playerEvent:', event);
            handlePlayerEvent(session, event, 'HOST', frontendSocket);
        });

        hostSocket.on('adminEvent', (event) => {
            console.log('HOST received adminEvent:', event);
            handleAdminEvent(session, event, frontendSocket);
        });

        hostSocket.on('player_set_role', (msg) => {
            console.log('HOST saw player_set_role:', msg);
        });

        hostSocket.on('player_ready', (msg) => {
            console.log('HOST saw player_ready:', msg);
        });

        hostSocket.on('disconnect', (reason) => {
            console.log(`HOST socket disconnected: ${reason}`);
            if (session.finished) {
                frontendSocket.emit('draft_finished', {});
            } else {
                frontendSocket.emit('error_msg', { message: `HOST disconnected: ${reason}` });
            }
        });

        hostSocket.on('connect_error', (err) => {
            console.error('HOST connection error:', err.message);
            frontendSocket.emit('error_msg', { message: `HOST connection error: ${err.message}` });
        });

        hostSocket.on('message', (msg) => {
            console.log('HOST received message:', msg);
        });

        // --- GUEST SOCKET ---
        const guestSocket = ioClient(AOE2CM_URL, {
            query: { draftId },
            transports: ['websocket'],
            forceNew: true,
        });
        session.guestSocket = guestSocket;

        guestSocket.on('connect', () => {
            console.log(`GUEST socket connected for draft ${draftId}`);

            guestSocket.emit('set_role', { name: guestName, role: 'GUEST' }, (draftConfig) => {
                console.log('GUEST role set');
                session.guestRoleSet = true;
                guestConnected = true;
                checkBothConnected();
                tryReadyUp(session, frontendSocket);
            });
        });

        guestSocket.on('draft_state', (state) => {
            console.log('GUEST received draft_state');
        });

        guestSocket.on('playerEvent', () => {
            // Tracked via HOST socket only
        });

        guestSocket.on('adminEvent', () => {
            // Tracked via HOST socket only
        });

        guestSocket.on('player_set_role', (msg) => {
            console.log('GUEST saw player_set_role:', msg);
        });

        guestSocket.on('player_ready', (msg) => {
            console.log('GUEST saw player_ready:', msg);
        });

        guestSocket.on('disconnect', (reason) => {
            console.log(`GUEST socket disconnected: ${reason}`);
            if (session.finished) {
                frontendSocket.emit('draft_finished', {});
            } else {
                frontendSocket.emit('error_msg', { message: `GUEST disconnected: ${reason}` });
            }
        });

        guestSocket.on('connect_error', (err) => {
            console.error('GUEST connection error:', err.message);
            frontendSocket.emit('error_msg', { message: `GUEST connection error: ${err.message}` });
        });

        guestSocket.on('message', (msg) => {
            console.log('GUEST received message:', msg);
        });

        // Timeout
        setTimeout(() => {
            if (!hostConnected || !guestConnected) {
                reject(new Error('Connection timeout'));
            }
        }, 15000);
    });
}

function tryReadyUp(session, frontendSocket) {
    if (session.bothPlayersReadySent) return;
    if (!session.hostRoleSet || !session.guestRoleSet) return;
    if (!session.hostSocket?.connected || !session.guestSocket?.connected) return;

    session.bothPlayersReadySent = true;
    console.log('Both roles set, readying up...');

    session.hostSocket.emit('ready', {}, (draftConfig) => {
        console.log('HOST ready ack');
        session.hostReady = true;
        checkDraftStarted(session, frontendSocket);
    });

    session.guestSocket.emit('ready', {}, (draftConfig) => {
        console.log('GUEST ready ack');
        session.guestReady = true;
        checkDraftStarted(session, frontendSocket);
    });
}

function checkDraftStarted(session, frontendSocket) {
    if (session.hostReady && session.guestReady) {
        console.log('Both players ready - draft started!');
        frontendSocket.emit('draft_started', {
            nextAction: session.nextAction,
            turn: session.turns[session.nextAction] || null,
        });
    }
}

function handlePlayerEvent(session, event, source, frontendSocket) {
    // Resolve hidden events using our known pending act
    const HIDDEN_IDS = ['HIDDEN_PICK', 'HIDDEN_BAN', 'HIDDEN_SNIPE', 'HIDDEN_STEAL', 'HIDDEN'];
    let resolvedOptionId = event.chosenOptionId;

    if (HIDDEN_IDS.includes(event.chosenOptionId) && session.pendingAct) {
        resolvedOptionId = session.pendingAct.chosenOptionId;
        console.log(`Resolved hidden ${event.chosenOptionId} → ${resolvedOptionId}`);
    }
    session.pendingAct = null;

    const resolvedEvent = {
        ...event,
        chosenOptionId: resolvedOptionId,
    };

    // Track the event
    session.events.push(resolvedEvent);
    session.nextAction++;

    // Send to frontend
    frontendSocket.emit('player_event', {
        ...resolvedEvent,
        turnIndex: session.nextAction - 1,
        nextAction: session.nextAction,
        nextTurn: session.turns[session.nextAction] || null,
    });

    // Check if draft is complete
    if (session.nextAction >= session.turns.length) {
        session.finished = true;
        console.log('Draft complete!');
    }
}

function handleAdminEvent(session, event, frontendSocket) {
    session.events.push(event);
    session.nextAction++;

    frontendSocket.emit('admin_event', {
        ...event,
        turnIndex: session.nextAction - 1,
        nextAction: session.nextAction,
        nextTurn: session.turns[session.nextAction] || null,
    });

    if (session.nextAction >= session.turns.length) {
        session.finished = true;
        console.log('Draft complete (after admin event)!');
    }
}

function cleanupSession(session) {
    if (session.hostSocket) {
        session.hostSocket.disconnect();
        session.hostSocket = null;
    }
    if (session.guestSocket) {
        session.guestSocket.disconnect();
        session.guestSocket = null;
    }
    sessions.delete(session.draftId);
    console.log(`Session ${session.draftId} cleaned up`);
}

// --- Start server ---
server.listen(PORT, () => {
    console.log(`\n  AoE2 CM Reporter running at:`);
    console.log(`  → Local:   http://localhost:${PORT}`);
    console.log(`  → Network: http://<your-ip>:${PORT}\n`);
    console.log(`  Proxying to: ${AOE2CM_URL}\n`);
});
