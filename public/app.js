// AoE2 CM Reporter – Dual mode: Live + Post-draft
(function () {
    'use strict';

    // --- Civ decoder (mirrors aoe2cm2 CivilisationEncoder) ---
    const ALL_CIVS = [
        'Aztecs','Berbers','Britons','Burmese','Byzantines','Celts','Chinese',
        'Ethiopians','Franks','Goths','Huns','Incas','Indians','Italians',
        'Japanese','Khmer','Koreans','Magyars','Malay','Malians','Mayans',
        'Mongols','Persians','Portuguese','Saracens','Slavs','Spanish',
        'Teutons','Turks','Vietnamese','Vikings','Bulgarians','Cumans',
        'Lithuanians','Tatars','Burgundians','Sicilians','Bohemians','Poles',
        'Bengalis','Dravidians','Gurjaras','Hindustanis','Romans',
        'Armenians','Georgians',
        'Achaemenids','Athenians','Spartans',
        'Shu','Wu','Wei','Jurchens','Khitans',
        'Macedonians','Thracians','Puru',
        'Mapuche','Muisca','Tupi',
    ];

    function decodeEncodedCivs(encoded) {
        if (!encoded) return [];
        const bits = [];
        for (const ch of encoded) {
            const n = parseInt(ch, 16);
            if (isNaN(n)) return [];
            bits.push(...n.toString(2).padStart(4, '0').split('').map(b => b === '1'));
        }
        const first = bits.indexOf(true);
        const trimmed = bits.slice(first);
        const civs = [];
        for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i]) {
                const idx = trimmed.length - 1 - i;
                if (idx < ALL_CIVS.length) {
                    civs.push({
                        id: ALL_CIVS[idx], name: ALL_CIVS[idx], category: 'default',
                        imageUrls: {
                            unit: `/images/civs/${ALL_CIVS[idx].toLowerCase()}.png`,
                            emblem: `/images/civemblems/${ALL_CIVS[idx].toLowerCase()}.png`,
                        },
                    });
                }
            }
        }
        civs.sort((a, b) => a.name.localeCompare(b.name));
        return civs;
    }

    function resolveOptions(preset) {
        if (preset.draftOptions && preset.draftOptions.length > 0) return preset.draftOptions;
        if (preset.encodedCivilisations) return decodeEncodedCivs(preset.encodedCivilisations);
        return [];
    }

    // --- State ---
    let socket = null;
    let mode = 'post'; // 'post' or 'live'
    let draft = null;
    let selectedOptionId = null;
    let liveConnected = false;  // live mode: server sockets connected?
    let livePending = false;    // live mode: waiting for server ack?

    // --- DOM ---
    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const setupScreen = $('#setup-screen');
    const draftScreen = $('#draft-screen');
    const uploadScreen = $('#upload-screen');
    const presetInput = $('#preset-id');
    const hostInput = $('#host-name');
    const guestInput = $('#guest-name');
    const createBtn = $('#create-btn');
    const setupError = $('#setup-error');
    const hdrHost = $('#hdr-host');
    const hdrGuest = $('#hdr-guest');
    const turnBadge = $('#turn-badge');
    const turnPlayer = $('#turn-player');
    const turnAction = $('#turn-action');
    const turnDetail = $('#turn-detail');
    const optionsGrid = $('#options-grid');
    const eventsList = $('#events-list');
    const draftError = $('#draft-error');
    const uploadBtn = $('#upload-btn');
    const undoBtn = $('#undo-btn');
    const specLinkBtn = $('#spec-link-btn');
    const uploadStatus = $('#upload-status');
    const uploadProgress = $('#upload-progress');
    const uploadResult = $('#upload-result');
    const specUrlEl = $('#spec-url');
    const newDraftBtn = $('#new-draft-btn');

    // --- Init ---
    function init() {
        socket = io({ transports: ['websocket', 'polling'] });

        socket.on('connect', () => {
            console.log('Socket connected:', socket.id);
            createBtn.disabled = false;
        });
        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err.message);
            showError(setupError, 'Cannot connect to server: ' + err.message);
        });
        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
        });

        // Setup
        createBtn.addEventListener('click', startDraft);
        $$('.mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mode = btn.dataset.mode;
                localStorage.setItem('aoe2cm_mode', mode);
            });
        });
        [presetInput, hostInput, guestInput].forEach(el => {
            el.addEventListener('keydown', e => { if (e.key === 'Enter') startDraft(); });
        });

        // Draft
        uploadBtn.addEventListener('click', uploadDraft);
        undoBtn.addEventListener('click', undoLastAction);
        specLinkBtn.addEventListener('click', copySpecLink);
        newDraftBtn.addEventListener('click', resetToSetup);

        // Live mode server events
        socket.on('live_player_event', onLivePlayerEvent);
        socket.on('live_admin_event', onLiveAdminEvent);
        socket.on('live_finished', onLiveFinished);

        // Upload events
        socket.on('upload_progress', onUploadProgress);
        socket.on('upload_complete', onUploadComplete);
        socket.on('upload_error', onUploadError);

        // Restore saved values
        presetInput.value = localStorage.getItem('aoe2cm_preset') || '';
        hostInput.value = localStorage.getItem('aoe2cm_host') || '';
        guestInput.value = localStorage.getItem('aoe2cm_guest') || '';
        const savedMode = localStorage.getItem('aoe2cm_mode');
        if (savedMode === 'live' || savedMode === 'post') {
            mode = savedMode;
            $$('.mode-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === mode);
            });
        }
    }

    // ============================================================
    // SETUP
    // ============================================================

    function startDraft() {
        const presetId = presetInput.value.trim();
        const hostName = hostInput.value.trim() || 'Host';
        const guestName = guestInput.value.trim() || 'Guest';
        if (!presetId) { showError(setupError, 'Enter a preset ID'); return; }

        if (!socket.connected) {
            showError(setupError, 'Not connected to server — waiting for connection…');
            return;
        }

        console.log('startDraft:', { presetId, hostName, guestName, mode });

        localStorage.setItem('aoe2cm_preset', presetId);
        localStorage.setItem('aoe2cm_host', hostName);
        localStorage.setItem('aoe2cm_guest', guestName);

        createBtn.disabled = true;
        createBtn.textContent = 'Creating draft…';
        hideError(setupError);

        socket.emit('create_draft', { presetId, hostName, guestName }, (response) => {
            if (response.error) {
                createBtn.disabled = false;
                createBtn.textContent = 'Start Draft';
                showError(setupError, response.error);
                return;
            }

            const preset = response.preset;
            const options = resolveOptions(preset);
            if (options.length === 0) {
                createBtn.disabled = false;
                createBtn.textContent = 'Start Draft';
                showError(setupError, 'Preset has no options/civilisations');
                return;
            }

            draft = {
                preset, options,
                draftId: response.draftId,
                spectatorUrl: response.spectatorUrl,
                turns: preset.turns,
                hostName, guestName,
                events: [],
                nextAction: 0,
            };

            hdrHost.textContent = hostName;
            hdrGuest.textContent = guestName;
            selectedOptionId = null;
            liveConnected = false;
            livePending = false;

            if (mode === 'live') {
                initLiveMode();
            } else {
                initPostMode();
            }
        });
    }

    // ============================================================
    // POST-DRAFT MODE (local draft, upload at end)
    // ============================================================

    function initPostMode() {
        skipAdminTurns();
        renderAll();
        setupScreen.classList.remove('active');
        draftScreen.classList.add('active');
        // Undo visible in post mode
        undoBtn.classList.remove('always-hidden');
    }

    function skipAdminTurns() {
        while (draft.nextAction < draft.turns.length) {
            const turn = draft.turns[draft.nextAction];
            if (turn.executingPlayer === 'NONE') {
                draft.events.push({
                    player: turn.player, executingPlayer: 'NONE',
                    actionType: 'admin', action: turn.action,
                    chosenOptionId: null, turnIndex: draft.nextAction,
                });
                draft.nextAction++;
            } else { break; }
        }
    }

    function applyLocalAction(optionId) {
        const turn = getCurrentTurn();
        if (!turn || turn.executingPlayer === 'NONE') return;
        const actionMap = { PICK:'pick', BAN:'ban', SNIPE:'snipe', STEAL:'steal' };
        draft.events.push({
            player: turn.player, executingPlayer: turn.executingPlayer,
            actionType: actionMap[turn.action] || turn.action.toLowerCase(),
            chosenOptionId: optionId, turnIndex: draft.nextAction,
        });
        draft.nextAction++;
        skipAdminTurns();
    }

    function undoLastAction() {
        if (mode === 'live' || !draft || draft.events.length === 0) return;
        while (draft.events.length > 0) {
            const last = draft.events[draft.events.length - 1];
            draft.events.pop();
            draft.nextAction = last.turnIndex;
            if (last.actionType !== 'admin') break;
        }
        if (draft.events.length > 0) {
            draft.nextAction = draft.events[draft.events.length - 1].turnIndex + 1;
            skipAdminTurns();
        } else {
            draft.nextAction = 0;
            skipAdminTurns();
        }
        selectedOptionId = null;
        renderAll();
    }

    // ============================================================
    // LIVE MODE (real-time via server sockets)
    // ============================================================

    function initLiveMode() {
        // Show draft screen with "connecting" state
        turnBadge.textContent = 'Connecting…';
        turnBadge.className = 'turn-badge waiting';
        renderOptionsGrid();
        renderEvents();
        undoBtn.classList.add('always-hidden'); // no undo in live mode
        uploadBtn.classList.add('hidden');
        setupScreen.classList.remove('active');
        draftScreen.classList.add('active');

        socket.emit('live_connect', {
            draftId: draft.draftId,
            hostName: draft.hostName,
            guestName: draft.guestName,
        }, (response) => {
            if (response.error) {
                showDraftError(`Connection failed: ${response.error}`);
                return;
            }
            liveConnected = true;
            // Skip leading admin turns in our local tracking
            skipAdminTurns();
            renderAll();
        });
    }

    function onLivePlayerEvent(event) {
        if (!draft) return;
        // The server confirmed this event happened. Update local state.
        const HIDDEN_IDS = ['HIDDEN_PICK','HIDDEN_BAN','HIDDEN_SNIPE','HIDDEN_STEAL','HIDDEN'];
        let resolvedId = event.chosenOptionId;
        // If the event came back as hidden (opponent's hidden turn from HOST perspective),
        // but WE sent it, we know what it was from our pending act
        if (HIDDEN_IDS.includes(resolvedId) && livePending && draft._pendingOptionId) {
            resolvedId = draft._pendingOptionId;
        }
        livePending = false;
        draft._pendingOptionId = null;

        draft.events.push({
            player: event.player, executingPlayer: event.executingPlayer,
            actionType: event.actionType, chosenOptionId: resolvedId,
            turnIndex: draft.nextAction,
        });
        draft.nextAction++;
        skipAdminTurns();
        selectedOptionId = null;
        renderAll();
    }

    function onLiveAdminEvent(event) {
        if (!draft) return;
        draft.events.push({
            player: event.player, executingPlayer: 'NONE',
            actionType: 'admin', action: event.action,
            chosenOptionId: null, turnIndex: draft.nextAction,
        });
        draft.nextAction++;
        skipAdminTurns();
        renderAll();
    }

    function onLiveFinished() {
        if (!draft) return;
        draft.finished = true;
        showDraftComplete();
    }

    function sendLiveAct(optionId) {
        if (!liveConnected || livePending) return;
        const turn = getCurrentTurn();
        if (!turn || turn.executingPlayer === 'NONE') return;
        const actionMap = { PICK:'pick', BAN:'ban', SNIPE:'snipe', STEAL:'steal' };
        livePending = true;
        draft._pendingOptionId = optionId;

        turnBadge.textContent = 'Sending…';
        turnBadge.className = 'turn-badge waiting';

        socket.emit('live_act', {
            player: turn.player,
            executingPlayer: turn.executingPlayer,
            actionType: actionMap[turn.action] || turn.action.toLowerCase(),
            chosenOptionId: optionId,
        }, (response) => {
            if (response.error) {
                livePending = false;
                draft._pendingOptionId = null;
                showDraftError(response.error);
                renderTurnIndicator();
            }
            // Success: wait for live_player_event from server
        });
    }

    // ============================================================
    // UPLOAD (post-draft mode)
    // ============================================================

    function uploadDraft() {
        if (!draft || !isDraftComplete()) return;
        uploadBtn.disabled = true;
        const eventsForUpload = draft.events.filter(e => e.actionType !== 'admin');

        draftScreen.classList.remove('active');
        uploadScreen.classList.add('active');
        uploadStatus.textContent = 'Connecting to aoe2cm.net…';
        uploadProgress.style.width = '5%';
        specUrlEl.href = draft.spectatorUrl;
        specUrlEl.textContent = draft.spectatorUrl;

        socket.emit('upload_draft', {
            draftId: draft.draftId, preset: draft.preset,
            hostName: draft.hostName, guestName: draft.guestName,
            events: eventsForUpload,
        }, (response) => {
            if (response?.error) {
                uploadStatus.textContent = `Error: ${response.error}`;
                uploadProgress.style.width = '0%';
                uploadBtn.disabled = false;
                draftScreen.classList.add('active');
                uploadScreen.classList.remove('active');
            }
        });
    }

    function onUploadProgress(data) {
        if (data.phase === 'connected') {
            uploadStatus.textContent = 'Connected. Replaying events…';
            uploadProgress.style.width = '30%';
        } else if (data.phase === 'replaying') {
            const pct = 30 + (data.current / data.total) * 65;
            uploadProgress.style.width = `${pct}%`;
            uploadStatus.textContent = `Replaying ${data.current}/${data.total}…`;
        }
    }
    function onUploadComplete() {
        uploadProgress.style.width = '100%';
        uploadStatus.textContent = 'Upload complete!';
        uploadResult.classList.remove('hidden');
    }
    function onUploadError(data) {
        uploadStatus.textContent = `Error: ${data.message}`;
    }

    // ============================================================
    // SHARED DRAFT LOGIC
    // ============================================================

    function getCurrentTurn() {
        if (!draft || draft.nextAction >= draft.turns.length) return null;
        return draft.turns[draft.nextAction];
    }

    function isDraftComplete() {
        return draft && draft.nextAction >= draft.turns.length;
    }

    // --- Availability ---
    function computeAvailableOptions() {
        const allIds = draft.options.map(o => o.id);
        const h = { pick: new Set(allIds), ban: new Set(allIds), snipe: new Set(), steal: new Set() };
        const g = { pick: new Set(allIds), ban: new Set(allIds), snipe: new Set(), steal: new Set() };

        for (const evt of draft.events) {
            if (evt.actionType === 'admin') continue;
            const turn = draft.turns[evt.turnIndex];
            if (!turn) continue;
            const id = evt.chosenOptionId;
            const ex = turn.exclusivity;
            const isH = evt.player === 'HOST';

            if (evt.actionType === 'pick') {
                if (ex === 'GLOBAL') { h.pick.delete(id); h.ban.delete(id); g.pick.delete(id); g.ban.delete(id); }
                else if (ex === 'EXCLUSIVE') { if (isH) { h.pick.delete(id); g.ban.delete(id); } else { g.pick.delete(id); h.ban.delete(id); } }
                if (isH) { g.snipe.add(id); g.steal.add(id); } else { h.snipe.add(id); h.steal.add(id); }
            }
            if (evt.actionType === 'ban') {
                if (ex === 'GLOBAL') { h.pick.delete(id); h.ban.delete(id); g.pick.delete(id); g.ban.delete(id); }
                else if (ex === 'EXCLUSIVE') { if (isH) { g.pick.delete(id); h.ban.delete(id); } else { h.pick.delete(id); g.ban.delete(id); } }
                else { if (isH) g.pick.delete(id); else h.pick.delete(id); }
            }
            if (evt.actionType === 'snipe') {
                if (isH) { h.snipe.delete(id); h.steal.delete(id); } else { g.snipe.delete(id); g.steal.delete(id); }
            }
            if (evt.actionType === 'steal') {
                if (isH) { h.snipe.delete(id); h.steal.delete(id); } else { g.snipe.delete(id); g.steal.delete(id); }
                if (isH) { g.snipe.add(id); g.steal.add(id); } else { h.snipe.add(id); h.steal.add(id); }
            }
        }
        return { host: h, guest: g };
    }

    function getValidIdsForCurrentTurn() {
        const turn = getCurrentTurn();
        if (!turn || turn.executingPlayer === 'NONE') return new Set();
        const valid = computeAvailableOptions();
        const pv = turn.player === 'HOST' ? valid.host : valid.guest;
        const am = { PICK:'pick', BAN:'ban', SNIPE:'snipe', STEAL:'steal' };
        const pool = pv[am[turn.action]];
        if (!pool) return new Set();
        const cats = turn.categories || ['default'];
        const result = new Set();
        for (const id of pool) {
            const opt = draft.options.find(o => o.id === id);
            if (opt && cats.includes(opt.category || 'default')) result.add(id);
        }
        return result;
    }

    function getOptionDisplayState(optionId) {
        const r = { available: true, cssClass: 'available', badge: null, badgeClass: '' };
        for (const evt of draft.events) {
            if (evt.chosenOptionId !== optionId || evt.actionType === 'admin') continue;
            const isH = evt.player === 'HOST';
            const p = isH ? 'H' : 'G';
            switch (evt.actionType) {
                case 'pick': r.cssClass = isH?'picked-host':'picked-guest'; r.badge=`${p} Pick`; r.badgeClass=isH?'badge-host':'badge-guest'; r.available=false; break;
                case 'ban': r.cssClass='banned'; r.badge=`${p} Ban`; r.badgeClass='badge-ban'; r.available=false; break;
                case 'snipe': r.cssClass='sniped'; r.badge=`${p} Snipe`; r.badgeClass='badge-snipe'; r.available=false; break;
                case 'steal': r.cssClass=isH?'picked-host':'picked-guest'; r.badge=`${p} Steal`; r.badgeClass=isH?'badge-host':'badge-guest'; r.available=false; break;
            }
        }
        return r;
    }

    // ============================================================
    // RENDERING
    // ============================================================

    function renderAll() {
        renderTurnIndicator();
        renderOptionsGrid();
        renderEvents();
        renderButtons();
    }

    function renderTurnIndicator() {
        if (isDraftComplete()) {
            turnBadge.textContent = mode === 'live' ? 'Draft Complete' : 'Draft Complete — Ready to upload';
            turnBadge.className = 'turn-badge complete';
            turnPlayer.textContent = '';
            turnAction.textContent = mode === 'live' ? 'All turns done!' : 'All turns done — press Upload below';
            turnDetail.textContent = '';
            if (mode === 'live') showDraftComplete();
            return;
        }
        const turn = getCurrentTurn();
        if (!turn) return;
        if (mode === 'live' && !liveConnected) {
            turnBadge.textContent = 'Connecting…';
            turnBadge.className = 'turn-badge waiting';
            turnPlayer.textContent = ''; turnAction.textContent = ''; turnDetail.textContent = '';
            return;
        }

        const isH = turn.player === 'HOST';
        const name = isH ? draft.hostName : draft.guestName;
        turnBadge.textContent = `${name} — ${fmtAction(turn.action)}`;
        turnBadge.className = `turn-badge ${isH ? 'host-turn' : 'guest-turn'}`;
        turnPlayer.textContent = name;
        turnPlayer.className = `turn-player ${isH ? 'host-color' : 'guest-color'}`;
        turnAction.textContent = fmtAction(turn.action);
        turnAction.className = `turn-action action-${turn.action.toLowerCase()}`;

        const details = [];
        if (turn.hidden) details.push('Hidden');
        if (turn.parallel) details.push('Parallel');
        if (turn.exclusivity === 'GLOBAL') details.push('Global');
        else if (turn.exclusivity === 'EXCLUSIVE') details.push('Exclusive');
        let remaining = 0;
        for (let i = draft.nextAction; i < draft.turns.length; i++) {
            if (draft.turns[i].executingPlayer !== 'NONE') remaining++;
        }
        turnDetail.textContent = (details.length ? `(${details.join(', ')}) — ` : '') + `${remaining} turns left`;
    }

    function renderOptionsGrid() {
        optionsGrid.innerHTML = '';
        if (!draft) return;
        const validIds = isDraftComplete() ? new Set() : getValidIdsForCurrentTurn();
        const cats = new Map();
        for (const opt of draft.options) {
            const c = opt.category || 'default';
            if (!cats.has(c)) cats.set(c, []);
            cats.get(c).push(opt);
        }

        for (const [cat, opts] of cats) {
            if (cats.size > 1) {
                const h = document.createElement('div');
                h.className = 'category-header';
                h.textContent = cat === 'default' ? 'Civilisations' : cap(cat);
                optionsGrid.appendChild(h);
            }
            const grid = document.createElement('div');
            grid.className = 'options-subgrid';
            optionsGrid.appendChild(grid);

            for (const opt of opts) {
                const ds = getOptionDisplayState(opt.id);
                const isValid = validIds.has(opt.id);
                const el = document.createElement('div');
                el.className = `option-card ${ds.cssClass}`;
                if (!isValid && !isDraftComplete()) el.classList.add('unavailable');
                if (selectedOptionId === opt.id) el.classList.add('selected');

                const img = document.createElement('img');
                img.src = opt.imageUrls?.emblem || opt.imageUrls?.unit || '';
                img.alt = opt.name || opt.id; img.loading = 'lazy';
                img.onerror = function() {
                    if (this.src.includes('emblem')) this.src = opt.imageUrls?.unit || '';
                    else this.style.display = 'none';
                };
                el.appendChild(img);

                const nameEl = document.createElement('span');
                nameEl.className = 'option-name';
                nameEl.textContent = opt.name || opt.id;
                el.appendChild(nameEl);

                if (ds.badge) {
                    const badge = document.createElement('span');
                    badge.className = `option-badge ${ds.badgeClass}`;
                    badge.textContent = ds.badge;
                    el.appendChild(badge);
                }

                const canClick = isValid && !isDraftComplete() && !(mode === 'live' && livePending);
                if (canClick) el.addEventListener('click', () => onOptionClick(opt.id));
                grid.appendChild(el);
            }
        }
    }

    function renderEvents() {
        if (!draft) return;
        eventsList.innerHTML = '';
        for (let i = 0; i < draft.events.length; i++) {
            const evt = draft.events[i];
            const el = document.createElement('div');
            el.className = 'event-item';
            if (evt.actionType === 'admin') {
                el.classList.add('event-admin');
                el.innerHTML = `<span class="event-num">${i+1}</span><span class="event-text">⚙️ ${fmtAction(evt.action)}</span>`;
            } else {
                const isH = evt.player === 'HOST';
                el.classList.add(isH ? 'event-host' : 'event-guest');
                el.innerHTML = `<span class="event-num">${i+1}</span>
                    <span class="event-player ${isH?'host-color':'guest-color'}">${isH?draft.hostName:draft.guestName}</span>
                    <span class="event-action-type">${evt.actionType}</span>
                    <span class="event-option">${evt.chosenOptionId}</span>`;
            }
            eventsList.appendChild(el);
        }
        eventsList.scrollTop = eventsList.scrollHeight;
    }

    function renderButtons() {
        if (!draft) return;
        const hasPlayerEvents = draft.events.some(e => e.actionType !== 'admin');
        undoBtn.classList.toggle('hidden', mode === 'live' || !hasPlayerEvents);
        uploadBtn.classList.toggle('hidden', mode === 'live' || !isDraftComplete());
    }

    function showDraftComplete() {
        // For live mode, the draft is done — just show a message
        turnBadge.textContent = 'Draft Complete';
        turnBadge.className = 'turn-badge complete';
    }

    // ============================================================
    // INTERACTION
    // ============================================================

    function onOptionClick(optionId) {
        if (selectedOptionId === optionId) {
            // Second tap: confirm
            selectedOptionId = null;
            if (mode === 'live') {
                sendLiveAct(optionId);
            } else {
                applyLocalAction(optionId);
                renderAll();
            }
        } else {
            selectedOptionId = optionId;
            renderOptionsGrid();
        }
    }

    // ============================================================
    // HELPERS
    // ============================================================

    function fmtAction(a) {
        return { PICK:'Pick', BAN:'Ban', SNIPE:'Snipe', STEAL:'Steal',
            REVEAL_ALL:'Reveal All', REVEAL_PICKS:'Reveal Picks',
            REVEAL_BANS:'Reveal Bans', REVEAL_SNIPES:'Reveal Snipes',
            PAUSE:'Pause', RESET_CL:'Reset' }[a] || a;
    }
    function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    function copySpecLink() {
        if (!draft?.spectatorUrl) return;
        navigator.clipboard.writeText(draft.spectatorUrl).then(() => {
            specLinkBtn.textContent = '✅ Copied!';
            setTimeout(() => { specLinkBtn.textContent = '📋 Spec'; }, 2000);
        }).catch(() => prompt('Spectator URL:', draft.spectatorUrl));
    }

    function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
    function hideError(el) { el.classList.add('hidden'); }
    function showDraftError(msg) {
        draftError.textContent = msg; draftError.classList.remove('hidden');
        setTimeout(() => draftError.classList.add('hidden'), 5000);
    }

    function resetToSetup() {
        uploadScreen.classList.remove('active');
        draftScreen.classList.remove('active');
        setupScreen.classList.add('active');
        uploadResult.classList.add('hidden');
        uploadBtn.disabled = false;
        createBtn.disabled = false;
        createBtn.textContent = 'Start Draft';
        draft = null; selectedOptionId = null;
        liveConnected = false; livePending = false;
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    document.addEventListener('DOMContentLoaded', init);
})();
