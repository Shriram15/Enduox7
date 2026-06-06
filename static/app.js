let pollInterval;
let timerInterval;
let currentElapsed = 0;
let isRunning = false;
let maxTime = 3600;
let lastStatus = null;

document.addEventListener('DOMContentLoaded', () => {
    // Buttons
    const btnSaveConfig = document.getElementById('btn-save-config');
    const btnAddTeam = document.getElementById('btn-add-team');
    const btnStartRace = document.getElementById('btn-start-race');
    
    const btnStartHour = document.getElementById('btn-start-hour');
    const btnExport = document.getElementById('btn-export');
    const btnReset = document.getElementById('btn-reset');
    
    const teamsGrid = document.getElementById('teams-grid');
    const fastEntryInput = document.getElementById('fast-entry-input');

    // UI Elements
    const displayHour = document.getElementById('display-hour');
    const globalTimer = document.getElementById('global-timer');
    const stateBadge = document.getElementById('race-state-badge');
    const setupScreen = document.getElementById('setup-screen');
    const dashboardScreen = document.getElementById('dashboard-screen');
    const regTeamsContainer = document.getElementById('reg-teams-container');
    const regCount = document.getElementById('reg-count');

    // 1. Initial State Check
    fetch('/api/race/status')
        .then(res => res.json())
        .then(data => {
            if (data.state !== 'setup') {
                showDashboard();
                updateDashboard(data);
                startPolling();
                startTimerLoop();
            } else {
                renderSetupTeams(data.teams);
            }
        });

    // 2. Setup Logic
    btnSaveConfig.addEventListener('click', async () => {
        const config = { max_time_per_hour: parseInt(document.getElementById('max-time').value) };
        const res = await fetch('/api/config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(config) });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        else showToast('Config saved', 'success');
    });

    btnAddTeam.addEventListener('click', async () => {
        const bib = document.getElementById('reg-bib').value;
        const category = document.getElementById('reg-category').value;
        
        if (!bib) return showToast("Enter a Bib number", "error");

        const res = await fetch('/api/teams', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ bib, category })
        });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        else {
            document.getElementById('reg-bib').value = '';
            document.getElementById('reg-bib').focus();
            renderSetupTeams(data.teams);
        }
    });

    regTeamsContainer.addEventListener('click', async (e) => {
        if (e.target.classList.contains('btn-remove')) {
            const bib = e.target.dataset.bib;
            const res = await fetch(`/api/teams/${bib}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.error) renderSetupTeams(data.teams);
        }
    });

    btnStartRace.addEventListener('click', async () => {
        const res = await fetch('/api/race/status');
        const data = await res.json();
        if (Object.keys(data.teams).length < 2) {
            return showToast("Need at least 2 bibs to start the dashboard.", "error");
        }
        showDashboard();
        pollStatus();
        startPolling();
        startTimerLoop();
    });

    function renderSetupTeams(teams) {
        regCount.innerText = Object.keys(teams).length;
        regTeamsContainer.innerHTML = Object.entries(teams).map(([bib, t]) => `
            <div class="reg-team-item">
                <span><strong>Bib ${bib}</strong> - ${t.category.toUpperCase()}</span>
                <button class="btn-remove" data-bib="${bib}">✖</button>
            </div>
        `).join('');
    }

    // 3. Start Hour
    btnStartHour.addEventListener('click', async () => {
        const res = await fetch('/api/race/start_hour', { method: 'POST' });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        else {
            showToast(`Hour ${data.hour} started!`, 'success');
            pollStatus();
        }
    });

    // 4. Record Lap / DNF via Event Delegation
    teamsGrid.addEventListener('click', async (e) => {
        const btnLap = e.target.closest('.btn-lap');
        const btnDnf = e.target.closest('.btn-dnf');
        const btnDelete = e.target.closest('.btn-delete-lap');

        // proceed if any relevant button was clicked
        if (!btnLap && !btnDnf && !btnDelete) return;

        const card = e.target.closest('.team-card');
        const bib = card.dataset.bib;

        if (btnLap && !btnLap.disabled) {
            const runner = btnLap.dataset.runner;
            submitLap(bib, runner);
        }

        if (btnDnf && !btnDnf.disabled) {
            const runner = btnDnf.dataset.runner;
            if (confirm(`Are you sure you want to mark ${runner === 'BOTH' ? 'Bib ' + bib : runner} as DNF?`)) {
                const res = await fetch('/api/dnf', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ bib, runner })
                });
                const data = await res.json();
                if (data.error) showToast(data.error, 'error');
                else {
                    showToast(data.team_eliminated ? `Bib ${bib} eliminated!` : `Runner ${runner} of Bib ${bib} DNF.`, 'success');
                    pollStatus();
                }
            }
        }
        if (btnDelete) {
            if (!confirm(`Delete last lap for Bib ${bib}?`)) return;
            // Try DELETE first, then fallback to POST /api/lap/delete for clients that strip DELETE bodies
            let res = await fetch('/api/lap', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ bib })
            });
            let data = null;
            try { data = await res.json(); } catch (e) { data = { error: 'Delete failed' }; }

            if (res.status !== 200 || data.error) {
                // fallback
                const res2 = await fetch('/api/lap/delete', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ bib })
                });
                const data2 = await res2.json();
                if (data2.error) showToast(data2.error, 'error');
                else {
                    showToast(`Deleted last lap for Bib ${bib}`, 'success');
                    pollStatus();
                }
            } else {
                showToast(`Deleted last lap for Bib ${bib}`, 'success');
                pollStatus();
            }
        }
    });

    // 5. Fast Entry Bar
    fastEntryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = fastEntryInput.value.trim().toLowerCase();
            if (!val) return;

            // Multiple bibs comma-separated
            if (val.includes(',')) {
                const parts = val.split(',').map(p => p.trim()).filter(Boolean);
                const simple = parts.every(p => /^\d+$/.test(p));
                if (simple) {
                    // Submit batch of bibs (no global runner dropdown)
                    submitMultiLap(parts);
                } else {
                    // Mixed entries like 12m,5f -> fallback to individual submits
                    parts.forEach(p => {
                        const m = p.match(/^(\d+)([mf]?)$/);
                        if (m) submitLap(m[1], (m[2] || '').toUpperCase(), true);
                    });
                }
                fastEntryInput.value = '';
                return;
            }

            const match = val.match(/^(\d+)([mf]?)$/);
            if (!match) {
                return fastEntryError("Invalid format. Use '12' or '12m'")
            }

            const bib = match[1];
            const runner = match[2].toUpperCase(); // will be 'M', 'F', or ''
            
            submitLap(bib, runner, true);
        }
    });

    function fastEntryError(msg) {
        showToast(msg, 'error');
        fastEntryInput.classList.remove('error-shake');
        void fastEntryInput.offsetWidth; // trigger reflow
        fastEntryInput.classList.add('error-shake');
    }

    async function submitLap(bib, runner, isFastEntry=false) {
        const res = await fetch('/api/lap', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ bib, runner })
        });
        const data = await res.json();
        
        if (data.error) {
            if (isFastEntry) fastEntryError(data.error);
            else showToast(data.error, 'error');
        } else {
            showToast(`Lap ${data.lap_number} recorded for Bib ${bib} ${data.runner ? '('+data.runner+')' : ''}`, 'success');
            if (isFastEntry) fastEntryInput.value = '';
            pollStatus();
        }
    }

    async function submitMultiLap(bibs) {
        if (!Array.isArray(bibs) || bibs.length === 0) return;

        const res = await fetch('/api/lap', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ bibs: bibs })
        });

        const data = await res.json();
        if (data.error) { showToast(data.error, 'error'); return; }

        if (data.results) {
            let ok = 0, fail = 0;
            data.results.forEach(r => { if (r.success) ok++; else fail++; });
            showToast(`Batch: ${ok} success, ${fail} failed`, fail ? 'error' : 'success');
            pollStatus();
        }
    }


    // 6. Export & Reset
    btnExport.addEventListener('click', () => { window.location.href = '/api/export'; });

    btnReset.addEventListener('click', async () => {
        if (confirm("Are you sure you want to completely reset the race? All data will be lost.")) {
            await fetch('/api/race/reset', { method: 'POST' });
            window.location.reload();
        }
    });

    // --- Core Logic ---
    function showDashboard() {
        setupScreen.classList.remove('active');
        dashboardScreen.classList.add('active');
        fastEntryInput.focus();
    }

    function startPolling() {
        if (!pollInterval) pollInterval = setInterval(pollStatus, 1000);
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/race/status');
            const data = await res.json();
            lastStatus = data;
            updateDashboard(data);
        } catch (e) {
            console.error("Polling error", e);
        }
    }

    function startTimerLoop() {
        if (!timerInterval) {
            timerInterval = setInterval(() => {
                if (isRunning) {
                    currentElapsed += 1;
                    const remaining = Math.max(0, Math.floor(maxTime - currentElapsed));
                    globalTimer.innerText = formatTime(remaining);
                }
            }, 1000);
        }
    }

    function updateDashboard(data) {
        currentElapsed = data.elapsed_seconds;
        maxTime = data.config.max_time_per_hour;
        isRunning = (data.state === 'running');
        
        displayHour.innerText = `Hour ${data.current_hour}`;
        
        if (data.state === 'setup') {
            stateBadge.innerText = 'Setup';
            stateBadge.className = 'race-state-badge';
            globalTimer.innerText = "00:00:00";
            btnStartHour.innerText = "Start Hour 1";
            btnStartHour.style.display = "block";
            fastEntryInput.disabled = true;
        } else if (data.state === 'running') {
            stateBadge.innerText = 'Running';
            stateBadge.className = 'race-state-badge state-running';
            btnStartHour.style.display = "none";
            // Show remaining countdown (start from max -> 0)
            const remaining = Math.max(0, Math.floor(maxTime - currentElapsed));
            globalTimer.innerText = formatTime(remaining);
            fastEntryInput.disabled = false;
        } else if (data.state === 'waiting') {
            stateBadge.innerText = 'Waiting';
            stateBadge.className = 'race-state-badge';
            btnStartHour.innerText = `Start Hour ${data.current_hour}`;
            btnStartHour.style.display = "block";
            // show standby timer as full hour (not running)
            globalTimer.innerText = formatTime(maxTime);
            fastEntryInput.disabled = true;
        } else if (data.state === 'finished') {
            stateBadge.innerText = 'Finished';
            stateBadge.className = 'race-state-badge state-finished';
            btnStartHour.style.display = "none";
            fastEntryInput.disabled = true;

            // Show per-category winners summary (detailed winner badges are on leaderboards)
            const winners = data.winners_by_category || {};
            const parts = [];
            if (winners.duo) parts.push(`Duo: ${winners.duo}`);
            if (winners.solo_m) parts.push(`Solo M: ${winners.solo_m}`);
            if (winners.solo_f) parts.push(`Solo F: ${winners.solo_f}`);
            globalTimer.innerText = parts.length ? `Winners: ${parts.join(' • ')}` : 'Finished';
        }

        const tpl = document.getElementById('tpl-team-card');
        const grid = document.getElementById('teams-grid');
        const mainContentEl = document.querySelector('.main-content');
        const winnersGlobal = data.winners_by_category || {};
        const allWinners = winnersGlobal && winnersGlobal.duo && winnersGlobal.solo_m && winnersGlobal.solo_f;

        // If all categories have winners, switch to leaderboards-only view
        if (allWinners) {
            mainContentEl.classList.add('leaderboards-only');
            document.getElementById('fast-entry-container').classList.add('hidden');
            // remove team cards entirely
            grid.innerHTML = '';
            return; // nothing more to render for teams
        } else {
            mainContentEl.classList.remove('leaderboards-only');
            document.getElementById('fast-entry-container').classList.remove('hidden');
        }
        
        const teamKeys = Object.keys(data.teams);
        if (grid.children.length !== teamKeys.length && teamKeys.length > 0) {
            grid.innerHTML = '';
            teamKeys.forEach(bib => {
                const clone = tpl.content.cloneNode(true);
                clone.querySelector('.team-card').dataset.bib = bib;
                clone.querySelector('.bib-num').innerText = bib;
                
                const cat = data.teams[bib].category;
                const catBadge = clone.querySelector('.cat-badge');
                catBadge.classList.add(cat);
                
                if (cat === 'duo') catBadge.innerText = 'Duo';
                if (cat === 'solo_m') {
                    catBadge.innerText = 'Solo M';
                    clone.querySelector('.btn-female').classList.add('hidden');
                    clone.querySelector('.dnf-f').classList.add('hidden');
                    clone.querySelector('.dnf-m').classList.add('hidden'); // Solo just needs Bib DNF
                }
                if (cat === 'solo_f') {
                    catBadge.innerText = 'Solo F';
                    clone.querySelector('.btn-male').classList.add('hidden');
                    clone.querySelector('.dnf-m').classList.add('hidden');
                    clone.querySelector('.dnf-f').classList.add('hidden');
                }

                grid.appendChild(clone);
            });
        }

        teamKeys.forEach(bib => {
            const team = data.teams[bib];
            const card = grid.querySelector(`.team-card[data-bib="${bib}"]`);
            if (!card) return;

            const maxLaps = team.target_laps || 0;

            card.querySelector('.lap-count').innerText = `${team.laps_this_hour}/${maxLaps}`;
            card.querySelector('.total-laps').innerText = team.total_laps;

            const pct = maxLaps > 0 ? (team.laps_this_hour / maxLaps) * 100 : 0;
            card.querySelector('.progress-fill').style.width = `${Math.min(pct, 100)}%`;

            // reset state classes
            card.classList.remove('dnf', 'disabled', 'winner');

            if (team.dnf) {
                card.classList.add('dnf');
                card.querySelector('.status-badge').innerText = 'DNF';
                const dReason = team.dnf_info?.reason || '';
                if (dReason === 'timeout') card.querySelector('.status-badge').innerText = `Timeout Hr ${team.dnf_info.hour}`;
            } else {
                card.querySelector('.status-badge').innerText = 'Active';
            }

            const winners = data.winners_by_category || {};
            const catKey = team.category;
            const winnerBib = winners[catKey] || winners[catKey.replace('_', '')];

            const lapBtns = card.querySelectorAll('.btn-lap');
            const dnfBtns = card.querySelectorAll('.btn-dnf');
            const deleteBtn = card.querySelector('.btn-delete-lap');

            if (winnerBib) {
                // category has a winner; disable lap/dnf buttons for all cards in category
                if (parseInt(bib) === parseInt(winnerBib)) {
                    card.querySelector('.winner-badge').classList.remove('hidden');
                    card.classList.add('winner', 'disabled');
                } else {
                    card.querySelector('.winner-badge').classList.add('hidden');
                    card.classList.add('disabled');
                }
                lapBtns.forEach(b => b.disabled = true);
                dnfBtns.forEach(b => b.disabled = true);
                if (deleteBtn) deleteBtn.disabled = false; // keep delete enabled
            } else {
                // normal operation
                card.querySelector('.winner-badge').classList.add('hidden');
                lapBtns.forEach(b => b.disabled = false);
                dnfBtns.forEach(b => b.disabled = false);
                if (deleteBtn) deleteBtn.disabled = false;
            }

            const btnM = card.querySelector('.btn-male');
            const btnF = card.querySelector('.btn-female');
            const dnfM = card.querySelector('.dnf-m');
            const dnfF = card.querySelector('.dnf-f');
            const dnfAll = card.querySelector('.dnf-all');

            const isRunningState = (data.state === 'running');
            const atMax = (team.laps_this_hour >= maxLaps);

            if (!winnerBib) {
                if (btnM) btnM.disabled = team.dnf || !team.runners.M || !isRunningState || atMax;
                if (btnF) btnF.disabled = team.dnf || !team.runners.F || !isRunningState || atMax;

                if (dnfM) dnfM.disabled = team.dnf || !team.runners.M;
                if (dnfF) dnfF.disabled = team.dnf || !team.runners.F;
                if (dnfAll) dnfAll.disabled = team.dnf;
            } else {
                // when category winner exists, lap/dnf already disabled; ensure DNF buttons disabled
                if (btnM) btnM.disabled = true;
                if (btnF) btnF.disabled = true;
                if (dnfM) dnfM.disabled = true;
                if (dnfF) dnfF.disabled = true;
                if (dnfAll) dnfAll.disabled = true;
            }
        });

        // Populate separate leaderboard boxes per category
        const duoList = (data.leaderboards && data.leaderboards.duo) ? data.leaderboards.duo : (data.leaderboard || []).filter(e => e.category === 'Duo');
        const solomList = (data.leaderboards && data.leaderboards.solo_m) ? data.leaderboards.solo_m : (data.leaderboard || []).filter(e => e.category === 'Solo M');
        const solofList = (data.leaderboards && data.leaderboards.solo_f) ? data.leaderboards.solo_f : (data.leaderboard || []).filter(e => e.category === 'Solo F');

        updateList('leaderboard-duo', duoList, (entry, i) => `
            <div class="lb-item ${entry.dnf ? 'dnf' : ''} ${entry.winner ? 'winner' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="lb-bib">Bib ${entry.bib} <small>(${entry.category})</small></span>
                <span class="lb-laps">${entry.laps} Laps</span>
                ${entry.winner ? '<span class="lb-winner">🏆 Winner</span>' : ''}
            </div>
        `);

        updateList('leaderboard-solom', solomList, (entry, i) => `
            <div class="lb-item ${entry.dnf ? 'dnf' : ''} ${entry.winner ? 'winner' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="lb-bib">Bib ${entry.bib} <small>(${entry.category})</small></span>
                <span class="lb-laps">${entry.laps} Laps</span>
                ${entry.winner ? '<span class="lb-winner">🏆 Winner</span>' : ''}
            </div>
        `);

        updateList('leaderboard-solof', solofList, (entry, i) => `
            <div class="lb-item ${entry.dnf ? 'dnf' : ''} ${entry.winner ? 'winner' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="lb-bib">Bib ${entry.bib} <small>(${entry.category})</small></span>
                <span class="lb-laps">${entry.laps} Laps</span>
                ${entry.winner ? '<span class="lb-winner">🏆 Winner</span>' : ''}
            </div>
        `);

        updateList('event-log', [...data.events].reverse(), (ev) => `
            <div class="log-item">
                <span class="log-time">${ev.time}</span>
                <span class="${ev.type === 'elimination' ? 'log-elimination' : ''}">${ev.message}</span>
            </div>
        `);
    }

    // Leaderboard boxes (no dropdown filter)

    function updateList(containerId, items, templateFn) {
        const container = document.getElementById(containerId);
        const html = items.map((item, i) => templateFn(item, i)).join('');
        if (container.innerHTML !== html) container.innerHTML = html;
    }

    function formatTime(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600).toString().padStart(2, '0');
        const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
        const s = (sec % 60).toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    function showToast(msg, type='info') {
        const c = document.getElementById('toast-container');
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.innerText = msg;
        c.appendChild(t);
        setTimeout(() => {
            t.classList.add('fade-out');
            setTimeout(() => t.remove(), 300);
        }, 3000);
    }
});
