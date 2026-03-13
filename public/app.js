// AoE2 CM Reporter – Frontend
(function () {
    'use strict';

    // --- State ---
    let socket = null;
    let state = {
        draftId: null,
        spectatorUrl: '',
        options: [],         // all draft options (civs/maps)
        turns: [],           // preset turn sequence
        hostName: '',
        guestName: '',
        nextAction: 0,       // current turn index
        events: [],          // array of { player, actionType, chosenOptionId, ... }
        started: false,
        finished: false,
        selectedOptionId: null,
    };

    // --- DOM refs ---
    const $ = (sel) => document.querySelector(sel);
    const setupScreen = $('#setup-screen');
    const draftScreen = $('#draft-screen');
    const presetInput = $('#preset-id');
    const hostInput = $('#host-name');
    const guestInput = $('#guest-name');
    const createBtn = $('#create-btn');
    const setupError = $('#setup-error');
    const setupStatus = $('#setup-status');
    const hdrHost = $('#hdr-host');
    const hdrGuest = $('#hdr-guest');
    const turnBadge = $('#turn-badge');
    const turnPlayer = $('#turn-player');
    const turnAction = $('#turn-action');
    const turnDetail = $('#turn-detail');
    const optionsGrid = $('#options-grid');
    const eventsList = $('#events-list');
    const draftError = $('#draft-error');
    const draftComplete = $('#draft-complete');
    const specLinkBtn = $('#spec-link-btn');
    const newDraftBtn = $('#new-draft-btn');

    // --- Init ---
    function init() {
        socket = io();

        socket.on('connect', () => console.log('Connected to server'));
        socket.on('disconnect', () => console.log('Disconnected from server'));

        socket.on('draft_created', onDraftCreated);
        socket.on('draft_started', onDraftStarted);
        socket.on('player_event', onPlayerEvent);
        socket.on('admin_event', onAdminEvent);
        socket.on('draft_finished', onDraftFinished);
        socket.on('error_msg', onError);

        createBtn.addEventListener('click', createDraft);
        specLinkBtn.addEventListener('click', copySpecLink);
        newDraftBtn.addEventListener('click', resetToSetup);

        // Enter key on inputs
        [presetInput, hostInput, guestInput].forEach(el => {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') createDraft();
            });
        });

        // Load saved values
        presetInput.value = localStorage.getItem('aoe2cm_preset') || '';
        hostInput.value = localStorage.getItem('aoe2cm_host') || '';
        guestInput.value = localStorage.getItem('aoe2cm_guest') || '';
    }

    // --- Setup ---
    function createDraft() {
        const presetId = presetInput.value.trim();
        const hostName = hostInput.value.trim() || 'Host';
        const guestName = guestInput.value.trim() || 'Guest';

        if (!presetId) {
            showSetupError('Enter a preset ID');
            return;
        }

        // Save for next time
        localStorage.setItem('aoe2cm_preset', presetId);
        localStorage.setItem('aoe2cm_host', hostName);
        localStorage.setItem('aoe2cm_guest', guestName);

        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        hideSetupError();
        showSetupStatus('Fetching preset and creating draft…');

        socket.emit('create_draft', { presetId, hostName, guestName });
    }

    function onDraftCreated(data) {
        console.log('Draft created:', data);
        state.draftId = data.draftId;
        state.spectatorUrl = data.spectatorUrl;
        state.options = data.options;
        state.turns = data.turns;
        state.hostName = data.hostName;
        state.guestName = data.guestName;
        state.nextAction = 0;
        state.events = [];
        state.started = false;
        state.finished = false;

        showSetupStatus('Draft created! Connecting as both players…');

        // Switch to draft screen
        hdrHost.textContent = state.hostName;
        hdrGuest.textContent = state.guestName;
        turnBadge.textContent = 'Connecting…';
        turnBadge.className = 'turn-badge waiting';

        renderOptionsGrid();
        renderEvents();

        setupScreen.classList.remove('active');
        draftScreen.classList.add('active');
    }

    function onDraftStarted(data) {
        console.log('Draft started:', data);
        state.started = true;
        state.nextAction = data.nextAction;
        updateTurnDisplay();
    }

    // --- Draft events ---

    function onPlayerEvent(data) {
        console.log('Player event:', data);

        state.events.push({
            player: data.player,
            executingPlayer: data.executingPlayer,
            actionType: data.actionType,
            chosenOptionId: data.chosenOptionId,
            isRandomlyChosen: data.isRandomlyChosen,
            turnIndex: data.turnIndex,
        });
        state.nextAction = data.nextAction;
        state.selectedOptionId = null;

        renderOptionsGrid();
        renderEvents();
        updateTurnDisplay();

        // Check if done
        if (state.nextAction >= state.turns.length && !hasRemainingNonAdminTurns()) {
            // Might still have admin turns; wait for server
        }

        hideDraftError();
    }

    function onAdminEvent(data) {
        console.log('Admin event:', data);

        state.events.push({
            player: data.player,
            actionType: 'admin',
            action: data.action,
            turnIndex: data.turnIndex,
        });
        state.nextAction = data.nextAction;

        // After a reveal, we may need to update shown events with revealed data
        if (data.events) {
            // The server sends updated events array after reveals
            // We could update our events, but for the reporter it's not critical
            // since they already know what was picked
        }

        renderEvents();
        updateTurnDisplay();
        hideDraftError();
    }

    function onDraftFinished() {
        console.log('Draft finished!');
        state.finished = true;
        draftComplete.classList.remove('hidden');
    }

    function onError(data) {
        console.error('Error:', data);
        if (setupScreen.classList.contains('active')) {
            showSetupError(data.message);
            createBtn.disabled = false;
            createBtn.textContent = 'Create Draft';
            hideSetupStatus();
        } else {
            showDraftError(data.message);
        }
    }

    // --- Rendering ---

    function renderOptionsGrid() {
        optionsGrid.innerHTML = '';

        // Group by category
        const categories = new Map();
        for (const opt of state.options) {
            const cat = opt.category || 'default';
            if (!categories.has(cat)) categories.set(cat, []);
            categories.get(cat).push(opt);
        }

        // Get current turn info for category filtering
        const currentTurn = state.turns[state.nextAction];
        const turnCategories = currentTurn?.categories || ['default'];

        for (const [cat, opts] of categories) {
            // If this category isn't relevant to the current turn, dim it
            const isTurnCategory = turnCategories.includes(cat);

            if (categories.size > 1) {
                const catHeader = document.createElement('div');
                catHeader.className = 'category-header';
                catHeader.textContent = cat === 'default' ? 'Civilisations' : capitalize(cat);
                optionsGrid.appendChild(catHeader);
            }

            const grid = document.createElement('div');
            grid.className = 'options-subgrid';
            optionsGrid.appendChild(grid);

            for (const opt of opts) {
                const optState = getOptionState(opt.id);
                const el = document.createElement('div');
                el.className = `option-card ${optState.cssClass}`;
                el.dataset.optionId = opt.id;

                if (!isTurnCategory && state.started && !state.finished) {
                    el.classList.add('wrong-category');
                }

                if (state.selectedOptionId === opt.id) {
                    el.classList.add('selected');
                }

                // Image
                const img = document.createElement('img');
                img.src = opt.imageUrls?.emblem || opt.imageUrls?.unit || '';
                img.alt = opt.name || opt.id;
                img.loading = 'lazy';
                img.onerror = function() {
                    // Fallback: try unit image, then placeholder
                    if (this.src.includes('emblem')) {
                        this.src = opt.imageUrls?.unit || '';
                    } else {
                        this.style.display = 'none';
                    }
                };
                el.appendChild(img);

                // Name
                const name = document.createElement('span');
                name.className = 'option-name';
                name.textContent = opt.name || opt.id;
                el.appendChild(name);

                // State badge
                if (optState.badge) {
                    const badge = document.createElement('span');
                    badge.className = `option-badge ${optState.badgeClass}`;
                    badge.textContent = optState.badge;
                    el.appendChild(badge);
                }

                // Click handler
                if (state.started && !state.finished && optState.available && isTurnCategory) {
                    el.addEventListener('click', () => onOptionClick(opt.id));
                }

                grid.appendChild(el);
            }
        }
    }

    function getOptionState(optionId) {
        // Check all events to determine this option's state
        let result = { available: true, cssClass: 'available', badge: null, badgeClass: '' };

        for (let i = 0; i < state.events.length; i++) {
            const evt = state.events[i];
            if (evt.chosenOptionId !== optionId) continue;
            if (evt.actionType === 'admin') continue;

            const turn = state.turns[evt.turnIndex];
            if (!turn) continue;

            const isHost = evt.player === 'HOST';
            const playerLabel = isHost ? 'H' : 'G';

            switch (evt.actionType) {
                case 'pick':
                    result.available = false;
                    result.cssClass = isHost ? 'picked-host' : 'picked-guest';
                    result.badge = `${playerLabel} Pick`;
                    result.badgeClass = isHost ? 'badge-host' : 'badge-guest';
                    break;
                case 'ban':
                    result.available = false;
                    result.cssClass = 'banned';
                    result.badge = `${playerLabel} Ban`;
                    result.badgeClass = 'badge-ban';
                    break;
                case 'snipe':
                    result.available = false;
                    result.cssClass = 'sniped';
                    result.badge = `${playerLabel} Snipe`;
                    result.badgeClass = 'badge-snipe';
                    break;
                case 'steal':
                    result.available = false;
                    result.cssClass = isHost ? 'picked-host' : 'picked-guest';
                    result.badge = `${playerLabel} Steal`;
                    result.badgeClass = isHost ? 'badge-host' : 'badge-guest';
                    break;
            }
        }

        if (state.finished) result.available = false;

        return result;
    }

    function renderEvents() {
        eventsList.innerHTML = '';

        for (let i = 0; i < state.events.length; i++) {
            const evt = state.events[i];
            const el = document.createElement('div');
            el.className = 'event-item';

            if (evt.actionType === 'admin') {
                el.classList.add('event-admin');
                el.innerHTML = `<span class="event-num">${i + 1}</span>
                    <span class="event-text">⚙️ ${formatAction(evt.action)}</span>`;
            } else {
                const isHost = evt.player === 'HOST';
                const name = isHost ? state.hostName : state.guestName;
                const optName = getOptionName(evt.chosenOptionId);
                el.classList.add(isHost ? 'event-host' : 'event-guest');
                el.innerHTML = `<span class="event-num">${i + 1}</span>
                    <span class="event-player ${isHost ? 'host-color' : 'guest-color'}">${name}</span>
                    <span class="event-action-type">${evt.actionType}</span>
                    <span class="event-option">${optName}</span>`;
            }

            eventsList.appendChild(el);
        }

        // Scroll to bottom
        eventsList.scrollTop = eventsList.scrollHeight;
    }

    function updateTurnDisplay() {
        if (!state.started) {
            turnBadge.textContent = 'Waiting…';
            turnBadge.className = 'turn-badge waiting';
            return;
        }

        // Skip to next non-admin turn for display
        let displayIndex = state.nextAction;
        while (displayIndex < state.turns.length && state.turns[displayIndex].executingPlayer === 'NONE') {
            displayIndex++;
        }

        if (displayIndex >= state.turns.length) {
            turnBadge.textContent = 'Complete';
            turnBadge.className = 'turn-badge complete';
            turnPlayer.textContent = '';
            turnAction.textContent = 'Draft complete!';
            turnDetail.textContent = '';
            state.finished = true;
            draftComplete.classList.remove('hidden');
            return;
        }

        const turn = state.turns[displayIndex];
        const isHost = turn.player === 'HOST';
        const playerName = isHost ? state.hostName : state.guestName;

        turnBadge.textContent = `${playerName} – ${formatAction(turn.action)}`;
        turnBadge.className = `turn-badge ${isHost ? 'host-turn' : 'guest-turn'}`;

        turnPlayer.textContent = playerName;
        turnPlayer.className = `turn-player ${isHost ? 'host-color' : 'guest-color'}`;
        turnAction.textContent = formatAction(turn.action);
        turnAction.className = `turn-action action-${turn.action.toLowerCase().replace('_', '-')}`;

        const details = [];
        if (turn.hidden) details.push('Hidden');
        if (turn.parallel) details.push('Parallel');
        if (turn.exclusivity === 'GLOBAL') details.push('Global');
        if (turn.exclusivity === 'EXCLUSIVE') details.push('Exclusive');
        turnDetail.textContent = details.length ? `(${details.join(', ')})` : '';

        // Also count remaining turns
        let remaining = 0;
        for (let i = state.nextAction; i < state.turns.length; i++) {
            if (state.turns[i].executingPlayer !== 'NONE') remaining++;
        }
        turnDetail.textContent += ` — ${remaining} turns left`;
    }

    // --- Option interaction ---

    function onOptionClick(optionId) {
        if (state.selectedOptionId === optionId) {
            // Double-click / confirm: send the act
            confirmAction(optionId);
        } else {
            // First click: select
            state.selectedOptionId = optionId;
            renderOptionsGrid();
        }
    }

    function confirmAction(optionId) {
        console.log('Confirming action:', optionId);
        socket.emit('act', { chosenOptionId: optionId });

        // Optimistically mark as pending
        state.selectedOptionId = null;
        turnBadge.textContent = 'Sending…';
        turnBadge.className = 'turn-badge waiting';
    }

    // --- Helpers ---

    function getOptionName(id) {
        const opt = state.options.find(o => o.id === id);
        return opt?.name || id;
    }

    function formatAction(action) {
        const map = {
            'PICK': 'Pick',
            'BAN': 'Ban',
            'SNIPE': 'Snipe',
            'STEAL': 'Steal',
            'REVEAL_ALL': 'Reveal All',
            'REVEAL_PICKS': 'Reveal Picks',
            'REVEAL_BANS': 'Reveal Bans',
            'REVEAL_SNIPES': 'Reveal Snipes',
            'PAUSE': 'Pause',
            'RESET_CL': 'Reset',
        };
        return map[action] || action;
    }

    function capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function hasRemainingNonAdminTurns() {
        for (let i = state.nextAction; i < state.turns.length; i++) {
            if (state.turns[i].executingPlayer !== 'NONE') return true;
        }
        return false;
    }

    function copySpecLink() {
        if (state.spectatorUrl) {
            navigator.clipboard.writeText(state.spectatorUrl).then(() => {
                specLinkBtn.textContent = '✅ Copied!';
                setTimeout(() => { specLinkBtn.textContent = '📋 Spec Link'; }, 2000);
            }).catch(() => {
                // Fallback
                prompt('Spectator URL:', state.spectatorUrl);
            });
        }
    }

    function resetToSetup() {
        draftScreen.classList.remove('active');
        setupScreen.classList.add('active');
        draftComplete.classList.add('hidden');
        createBtn.disabled = false;
        createBtn.textContent = 'Create Draft';
        hideSetupError();
        hideSetupStatus();
        state = {
            draftId: null, spectatorUrl: '', options: [], turns: [],
            hostName: '', guestName: '', nextAction: 0, events: [],
            started: false, finished: false, selectedOptionId: null,
        };
    }

    function showSetupError(msg) {
        setupError.textContent = msg;
        setupError.classList.remove('hidden');
    }
    function hideSetupError() {
        setupError.classList.add('hidden');
    }
    function showSetupStatus(msg) {
        setupStatus.textContent = msg;
        setupStatus.classList.remove('hidden');
    }
    function hideSetupStatus() {
        setupStatus.classList.add('hidden');
    }
    function showDraftError(msg) {
        draftError.textContent = msg;
        draftError.classList.remove('hidden');
        setTimeout(hideDraftError, 5000);
    }
    function hideDraftError() {
        draftError.classList.add('hidden');
    }

    // --- PWA registration ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // --- Boot ---
    document.addEventListener('DOMContentLoaded', init);
})();
