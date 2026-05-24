let pollInterval;
let timerInterval;
let currentElapsed = 0;
let isRunning = false;
let maxTime = 3600;

document.addEventListener('DOMContentLoaded', () => {
    // Buttons
    const btnSaveStart = document.getElementById('btn-save-start');
    const btnStartHour = document.getElementById('btn-start-hour');
    const btnExport = document.getElementById('btn-export');
    const btnReset = document.getElementById('btn-reset');
    const teamsGrid = document.getElementById('teams-grid');

    // UI Elements
    const displayHour = document.getElementById('display-hour');
    const globalTimer = document.getElementById('global-timer');
    const stateBadge = document.getElementById('race-state-badge');
    const setupScreen = document.getElementById('setup-screen');
    const dashboardScreen = document.getElementById('dashboard-screen');

    // 1. Initial State Check
    fetch('/api/race/status')
        .then(res => res.json())
        .then(data => {
            if (data.state !== 'setup') {
                showDashboard();
                updateDashboard(data);
                startPolling();
                startTimerLoop();
            }
        });

    // 2. Setup Race
    btnSaveStart.addEventListener('click', async () => {
        const config = {
            num_teams: parseInt(document.getElementById('num-teams').value),
            max_laps: parseInt(document.getElementById('max-laps').value),
            max_time_per_hour: parseInt(document.getElementById('max-time').value)
        };

        const res = await fetch('/api/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config)
        });

        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
        } else {
            showDashboard();
            pollStatus();
            startPolling();
            startTimerLoop();
        }
    });

    // 3. Start Hour
    btnStartHour.addEventListener('click', async () => {
        const res = await fetch('/api/race/start_hour', { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
        } else {
            showToast(`Hour ${data.hour} started!`, 'success');
            pollStatus();
        }
    });

    // 4. Record Lap / DNF via Event Delegation
    teamsGrid.addEventListener('click', async (e) => {
        const btnLap = e.target.closest('.btn-lap');
        const btnDnf = e.target.closest('.btn-dnf');
        
        if (!btnLap && !btnDnf) return;

        const card = e.target.closest('.team-card');
        const bib = card.dataset.bib;

        if (btnLap && !btnLap.disabled) {
            const runner = btnLap.dataset.runner;
            const res = await fetch('/api/lap', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ bib, runner })
            });
            const data = await res.json();
            if (data.error) {
                showToast(data.error, 'error');
            } else {
                showToast(`Lap ${data.lap_number} recorded for Team ${bib} (${runner})`, 'success');
                pollStatus();
            }
        }

        if (btnDnf && !btnDnf.disabled) {
            const runner = btnDnf.dataset.runner;
            if (confirm(`Are you sure you want to mark ${runner === 'BOTH' ? 'Team ' + bib : runner} as DNF?`)) {
                const res = await fetch('/api/dnf', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ bib, runner })
                });
                const data = await res.json();
                if (data.error) {
                    showToast(data.error, 'error');
                } else {
                    showToast(data.team_eliminated ? `Team ${bib} eliminated!` : `Runner ${runner} of Team ${bib} DNF.`, 'success');
                    pollStatus();
                }
            }
        }
    });

    // 5. Export & Reset
    btnExport.addEventListener('click', () => {
        window.location.href = '/api/export';
    });

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
    }

    function startPolling() {
        if (!pollInterval) {
            pollInterval = setInterval(pollStatus, 1000);
        }
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/race/status');
            const data = await res.json();
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
                    if (currentElapsed <= maxTime) {
                        globalTimer.innerText = formatTime(currentElapsed);
                    }
                }
            }, 1000);
        }
    }

    function updateDashboard(data) {
        // Update Timers and State
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
        } else if (data.state === 'running') {
            stateBadge.innerText = 'Running';
            stateBadge.className = 'race-state-badge state-running';
            btnStartHour.style.display = "none";
            globalTimer.innerText = formatTime(currentElapsed);
        } else if (data.state === 'waiting') {
            stateBadge.innerText = 'Waiting';
            stateBadge.className = 'race-state-badge';
            btnStartHour.innerText = `Start Hour ${data.current_hour}`;
            btnStartHour.style.display = "block";
            globalTimer.innerText = "00:00:00";
        } else if (data.state === 'finished') {
            stateBadge.innerText = 'Finished';
            stateBadge.className = 'race-state-badge state-finished';
            btnStartHour.style.display = "none";
            
            if (data.winner && data.winner.winner) {
                globalTimer.innerText = `Winner: Team ${data.winner.winner}`;
            } else {
                globalTimer.innerText = "All Eliminated";
            }
        }

        // Update Teams
        const tpl = document.getElementById('tpl-team-card');
        const grid = document.getElementById('teams-grid');
        
        // Only build grid once if empty, otherwise update in place
        const teamKeys = Object.keys(data.teams);
        if (grid.children.length !== teamKeys.length && teamKeys.length > 0) {
            grid.innerHTML = '';
            teamKeys.forEach(bib => {
                const clone = tpl.content.cloneNode(true);
                clone.querySelector('.team-card').dataset.bib = bib;
                clone.querySelector('.bib-num').innerText = bib;
                grid.appendChild(clone);
            });
        }

        // Update each card
        teamKeys.forEach(bib => {
            const team = data.teams[bib];
            const card = grid.querySelector(`.team-card[data-bib="${bib}"]`);
            if (!card) return;

            const maxLaps = data.config.max_laps;
            
            card.querySelector('.lap-count').innerText = `${team.laps_this_hour}/${maxLaps}`;
            card.querySelector('.total-laps').innerText = team.total_laps;
            
            const pct = (team.laps_this_hour / maxLaps) * 100;
            card.querySelector('.progress-fill').style.width = `${Math.min(pct, 100)}%`;

            // DNF UI update
            if (team.dnf) {
                card.classList.add('dnf');
                card.querySelector('.status-badge').innerText = 'DNF';
                const dReason = team.dnf_info?.reason || '';
                if (dReason === 'timeout') card.querySelector('.status-badge').innerText = `Timeout Hr ${team.dnf_info.hour}`;
            } else {
                card.classList.remove('dnf');
                card.querySelector('.status-badge').innerText = 'Active';
            }

            // Buttons state
            const btnM = card.querySelector('.btn-male');
            const btnF = card.querySelector('.btn-female');
            const dnfM = card.querySelector('.btn-dnf[data-runner="M"]');
            const dnfF = card.querySelector('.btn-dnf[data-runner="F"]');
            const dnfAll = card.querySelector('.btn-dnf[data-runner="BOTH"]');

            const isRunningState = (data.state === 'running');
            const atMax = (team.laps_this_hour >= maxLaps);

            btnM.disabled = team.dnf || !team.runners.M || !isRunningState || atMax;
            btnF.disabled = team.dnf || !team.runners.F || !isRunningState || atMax;

            dnfM.disabled = team.dnf || !team.runners.M;
            dnfF.disabled = team.dnf || !team.runners.F;
            dnfAll.disabled = team.dnf;
            
            if (!team.runners.M) btnM.innerText = 'DNF';
            else btnM.innerText = '+ Lap M';
            
            if (!team.runners.F) btnF.innerText = 'DNF';
            else btnF.innerText = '+ Lap F';
        });

        // Update Logs & Leaderboard
        updateList('leaderboard-list', data.leaderboard, (entry, i) => `
            <div class="lb-item ${entry.dnf ? 'dnf' : ''}">
                <span class="lb-rank">${i+1}</span>
                <span class="lb-bib">Team ${entry.bib}</span>
                <span class="lb-laps">${entry.laps} Laps</span>
            </div>
        `);

        updateList('event-log', [...data.events].reverse(), (ev) => `
            <div class="log-item">
                <span class="log-time">${ev.time}</span>
                <span class="${ev.type === 'elimination' ? 'log-elimination' : ''}">${ev.message}</span>
            </div>
        `);
    }

    function updateList(containerId, items, templateFn) {
        const container = document.getElementById(containerId);
        const html = items.map((item, i) => templateFn(item, i)).join('');
        if (container.innerHTML !== html) {
            container.innerHTML = html;
        }
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
