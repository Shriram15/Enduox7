from flask import Flask, jsonify, request, render_template, send_file
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
import time
import os

app = Flask(__name__)

# ================ RACE STATE ================
# States: 'setup', 'running', 'waiting', 'finished'
race = {
    "state": "setup",
    "current_hour": 1,
    "hour_start_time": None,
    "config": {
        "num_teams": 10,
        "max_laps": 14,
        "max_time_per_hour": 3600
    },
    "teams": {},
    "events": []
}


def init_teams():
    """Initialize teams based on current config."""
    race["teams"] = {}
    n = race["config"]["num_teams"]
    for i in range(1, n + 1):
        race["teams"][i] = {
            "laps": {},
            "last_time_this_hour": None,
            "total_time": 0.0,
            "runners": {"M": True, "F": True},
            "dnf": False,
            "dnf_info": None,
            "runner_time": {"M": 0.0, "F": 0.0}
        }


def format_time(sec):
    """Format seconds into HH:MM:SS string."""
    sec = max(0, int(sec))
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    return f"{h:02}:{m:02}:{s:02}"


def add_event(event_type, message, bib=None):
    """Add an event to the race event log."""
    # Elapsed time is relative to current hour if running, else 0
    if race["state"] == "running" and race["hour_start_time"]:
        elapsed = time.time() - race["hour_start_time"]
    else:
        elapsed = 0
    
    race["events"].append({
        "time": time.strftime("%H:%M:%S"),
        "elapsed": format_time(elapsed),
        "hour": race["current_hour"],
        "type": event_type,
        "message": message,
        "bib": bib
    })


def check_hour_state():
    """Check if the current hour has ended."""
    if race["state"] != "running" or race["hour_start_time"] is None:
        return

    now = time.time()
    elapsed = now - race["hour_start_time"]
    max_time = race["config"]["max_time_per_hour"]

    # Has the hour ended?
    if elapsed >= max_time:
        hour = race["current_hour"]
        max_laps = race["config"]["max_laps"]

        # Check all teams for DNF
        for bib, team in race["teams"].items():
            if team["dnf"]:
                continue
            
            laps_completed = len(team["laps"].get(hour, []))
            if laps_completed < max_laps:
                team["dnf"] = True
                team["dnf_info"] = {
                    "reason": "timeout",
                    "hour": hour,
                    "laps_completed": laps_completed
                }
                add_event(
                    "elimination",
                    f"Team {bib} eliminated ({laps_completed}/{max_laps} laps in Hour {hour})",
                    bib
                )

        # Transition state
        race["state"] = "waiting"
        race["current_hour"] += 1
        
        # Check if race is over (0 or 1 teams left)
        active = [bib for bib, t in race["teams"].items() if not t["dnf"]]
        if len(active) <= 1:
            race["state"] = "finished"


def get_winner_info():
    """Check if there's a winner. Returns dict or None."""
    if race["state"] == "setup":
        return None

    active = [bib for bib, t in race["teams"].items() if not t["dnf"]]

    if len(active) == 1:
        return {"winner": active[0], "finished": True}
    elif len(active) == 0:
        return {"winner": None, "finished": True, "all_eliminated": True}
    return None


def build_leaderboard():
    """Build sorted leaderboard data."""
    entries = []
    for bib, team in race["teams"].items():
        total_laps = sum(len(laps) for laps in team["laps"].values())
        total_time = team["runner_time"]["M"] + team["runner_time"]["F"]

        entries.append({
            "bib": bib,
            "laps": total_laps,
            "time": total_time,
            "time_fmt": format_time(total_time),
            "dnf": team["dnf"],
            "runner_m": format_time(team["runner_time"]["M"]),
            "runner_f": format_time(team["runner_time"]["F"]),
            "status": "DNF" if team["dnf"] else "Active"
        })

    entries.sort(key=lambda x: (x["dnf"], -x["laps"], x["time"]))
    return entries


def build_status_response():
    """Build full race status response."""
    check_hour_state()
    
    elapsed = 0
    if race["state"] == "running" and race["hour_start_time"]:
        elapsed = time.time() - race["hour_start_time"]

    teams_data = {}
    for bib, team in race["teams"].items():
        # Get laps for the currently displayed hour
        # If waiting, display the hour that is about to start
        disp_hour = race["current_hour"]
        if race["state"] == "finished" and disp_hour > 1:
            disp_hour -= 1
            
        laps_this_hour = len(team["laps"].get(disp_hour, []))
        
        teams_data[str(bib)] = {
            "laps": {str(k): v for k, v in team["laps"].items()},
            "runners": team["runners"],
            "dnf": team["dnf"],
            "dnf_info": team["dnf_info"],
            "total_time": format_time(team["total_time"]),
            "runner_time": {
                "M": format_time(team["runner_time"]["M"]),
                "F": format_time(team["runner_time"]["F"])
            },
            "laps_this_hour": laps_this_hour,
            "total_laps": sum(len(l) for l in team["laps"].values())
        }

    winner = get_winner_info()
    if winner and race["state"] != "finished":
        race["state"] = "finished"

    return {
        "state": race["state"],
        "elapsed": format_time(elapsed),
        "elapsed_seconds": elapsed,
        "current_hour": race["current_hour"],
        "config": race["config"],
        "teams": teams_data,
        "leaderboard": build_leaderboard(),
        "events": race["events"][-100:],
        "winner": winner
    }


# ================ ROUTES ================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(race["config"])


@app.route("/api/config", methods=["POST"])
def set_config():
    if race["state"] != "setup":
        return jsonify({"error": "Cannot change configuration after the race has started."}), 409

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data provided."}), 400

    errors = []

    if "num_teams" in data:
        try:
            n = int(data["num_teams"])
            if n < 2 or n > 50:
                errors.append("Number of teams must be between 2 and 50.")
            else:
                race["config"]["num_teams"] = n
        except (ValueError, TypeError):
            errors.append("Number of teams must be a valid integer.")

    if "max_laps" in data:
        try:
            ml = int(data["max_laps"])
            if ml < 1 or ml > 100:
                errors.append("Max laps per hour must be between 1 and 100.")
            else:
                race["config"]["max_laps"] = ml
        except (ValueError, TypeError):
            errors.append("Max laps must be a valid integer.")

    if "max_time_per_hour" in data:
        try:
            mt = int(data["max_time_per_hour"])
            if mt < 10 or mt > 7200:
                errors.append("Hour duration must be between 10 and 7200 seconds.")
            else:
                race["config"]["max_time_per_hour"] = mt
        except (ValueError, TypeError):
            errors.append("Hour duration must be a valid integer.")

    if errors:
        return jsonify({"error": " ".join(errors)}), 400

    return jsonify({"success": True, "config": race["config"]})


@app.route("/api/race/start_hour", methods=["POST"])
def start_hour():
    check_hour_state()
    
    if race["state"] == "running":
        return jsonify({"error": "An hour is already running."}), 409
    
    if race["state"] == "finished":
        return jsonify({"error": "The race is already finished."}), 409

    if race["state"] == "setup":
        init_teams()
        race["events"] = []

    race["state"] = "running"
    race["hour_start_time"] = time.time()
    
    # Reset per-hour timers for all teams
    for team in race["teams"].values():
        team["last_time_this_hour"] = None

    add_event("start", f"🏁 Hour {race['current_hour']} started!")

    return jsonify({"success": True, "hour": race["current_hour"]})


@app.route("/api/race/status", methods=["GET"])
def race_status():
    return jsonify(build_status_response())


@app.route("/api/lap", methods=["POST"])
def record_lap():
    check_hour_state()
    
    if race["state"] != "running":
        return jsonify({"error": f"Cannot record laps. The race is currently {race['state']}."}), 409

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data provided. Send JSON with bib and runner fields."}), 400

    # --- Validate bib ---
    raw_bib = data.get("bib", "")
    try:
        bib = int(raw_bib)
    except (ValueError, TypeError):
        return jsonify({"error": f"Invalid bib number '{raw_bib}'."}), 400

    if bib not in race["teams"]:
        return jsonify({"error": f"Team {bib} does not exist."}), 404

    # --- Validate runner ---
    runner = str(data.get("runner", "")).upper().strip()
    if runner not in ("M", "F"):
        return jsonify({"error": f"Invalid runner '{runner}'."}), 400

    team = race["teams"][bib]
    hour = race["current_hour"]

    # --- Check team status ---
    if team["dnf"]:
        return jsonify({"error": f"Team {bib} is eliminated. Cannot record laps."}), 409

    # --- Check runner status ---
    if not team["runners"][runner]:
        return jsonify({"error": f"Runner {runner} of Team {bib} is marked DNF and cannot run."}), 409

    # --- Record timing ---
    now = time.time()
    clock_time = time.strftime("%H:%M:%S")

    # Lap time is calculated relative to the start of the hour or their last lap this hour
    if team["last_time_this_hour"] is None:
        lap_time = now - race["hour_start_time"]
    else:
        lap_time = now - team["last_time_this_hour"]

    max_laps = race["config"]["max_laps"]

    # --- Max laps check ---
    if hour not in team["laps"]:
        team["laps"][hour] = []

    if len(team["laps"][hour]) >= max_laps:
        return jsonify({"error": f"Team {bib} already completed all {max_laps} laps for Hour {hour}."}), 409

    # --- Record the lap ---
    lap_entry = {
        "runner": runner,
        "lap_time": round(lap_time, 1),
        "lap_time_fmt": format_time(lap_time),
        "clock_time": clock_time
    }
    team["laps"][hour].append(lap_entry)
    team["last_time_this_hour"] = now
    
    # Update total times
    team["runner_time"][runner] += lap_time
    team["total_time"] += lap_time

    lap_num = len(team["laps"][hour])
    add_event("lap", f"Team {bib} · Runner {runner} · Lap {lap_num} · {format_time(lap_time)}", bib)

    # Check if this team finishing ends the race early
    active = [b for b, t in race["teams"].items() if not t["dnf"]]
    if len(active) <= 1:
        check_hour_state()

    return jsonify({
        "success": True,
        "bib": bib,
        "runner": runner,
        "hour": hour,
        "lap_number": lap_num,
        "lap_time": format_time(lap_time),
        "laps_remaining": max_laps - lap_num
    })


@app.route("/api/dnf", methods=["POST"])
def mark_dnf():
    check_hour_state()
    
    if race["state"] == "setup":
        return jsonify({"error": "Race has not started yet."}), 409

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data provided."}), 400

    # --- Validate bib ---
    raw_bib = data.get("bib", "")
    try:
        bib = int(raw_bib)
    except (ValueError, TypeError):
        return jsonify({"error": f"Invalid bib number."}), 400

    if bib not in race["teams"]:
        return jsonify({"error": f"Team {bib} does not exist."}), 404

    # --- Validate runner ---
    runner = str(data.get("runner", "")).upper().strip()
    if runner not in ("M", "F", "BOTH"):
        return jsonify({"error": f"Invalid runner. Must be 'M', 'F', or 'BOTH'."}), 400

    team = race["teams"][bib]

    if team["dnf"]:
        return jsonify({"error": f"Team {bib} is already eliminated."}), 409

    if runner == "BOTH":
        team["runners"]["M"] = False
        team["runners"]["F"] = False
        team["dnf"] = True
        team["dnf_info"] = {"reason": "manual", "detail": "Team explicitly marked DNF"}
        add_event("elimination", f"Team {bib} manually marked DNF", bib)
        team_eliminated = True
    else:
        if not team["runners"][runner]:
            return jsonify({"error": f"Runner {runner} of Team {bib} is already marked DNF."}), 409

        # --- Mark DNF ---
        team["runners"][runner] = False
        add_event("dnf", f"Runner {runner} of Team {bib} marked DNF", bib)

        team["dnf"] = True
        team["dnf_info"] = {"reason": "manual", "detail": f"Runner {runner} DNF"}
        add_event("elimination", f"Team {bib} eliminated — Runner {runner} DNF", bib)
        team_eliminated = True

    return jsonify({
        "success": True,
        "bib": bib,
        "runner": runner,
        "team_eliminated": team_eliminated
    })


@app.route("/api/export", methods=["GET"])
def export_excel():
    if not race["teams"]:
        return jsonify({"error": "No race data to export. Start a race first."}), 400

    wb = Workbook()
    max_laps = race["config"]["max_laps"]

    # Styles
    hdr_font = Font(bold=True, color="FFFFFF", size=11)
    hdr_fill = PatternFill(start_color="2D3748", end_color="2D3748", fill_type="solid")
    dnf_fill = PatternFill(start_color="FC8181", end_color="FC8181", fill_type="solid")
    ok_fill = PatternFill(start_color="68D391", end_color="68D391", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin")
    )

    first_sheet = True
    for bib, team in race["teams"].items():
        if first_sheet:
            ws = wb.active
            first_sheet = False
        else:
            ws = wb.create_sheet()
        ws.title = f"Team_{bib}"

        # Header
        c = ws.cell(row=1, column=1, value="Lap")
        c.font = hdr_font; c.fill = hdr_fill; c.border = thin_border

        hours = sorted(team["laps"].keys()) if team["laps"] else [1]

        for col, hour in enumerate(hours, start=2):
            c = ws.cell(row=1, column=col, value=f"Hour {hour}")
            c.font = hdr_font; c.fill = hdr_fill; c.border = thin_border

        for lap_num in range(1, max_laps + 1):
            ws.cell(row=lap_num + 1, column=1, value=f"Lap {lap_num}").border = thin_border

            for col, hour in enumerate(hours, start=2):
                laps = team["laps"].get(hour, [])

                # DNF marker
                if team["dnf_info"] and isinstance(team["dnf_info"], dict):
                    if team["dnf_info"].get("reason") == "timeout":
                        dnf_hour = team["dnf_info"].get("hour")
                        dnf_laps = team["dnf_info"].get("laps_completed", 0)
                        if hour == dnf_hour and lap_num == dnf_laps + 1:
                            c = ws.cell(row=lap_num + 1, column=col, value="DNF")
                            c.fill = dnf_fill; c.border = thin_border
                            continue

                if lap_num <= len(laps):
                    lap = laps[lap_num - 1]
                    text = f"{lap['runner']} | {lap['clock_time']} | {format_time(lap['lap_time'])}"
                else:
                    text = ""

                ws.cell(row=lap_num + 1, column=col, value=text).border = thin_border

        # Runner totals
        row_s = max_laps + 3
        ws.cell(row=row_s, column=1, value="Runner M Total").font = Font(bold=True)
        ws.cell(row=row_s, column=2, value=format_time(team["runner_time"]["M"]))
        ws.cell(row=row_s + 1, column=1, value="Runner F Total").font = Font(bold=True)
        ws.cell(row=row_s + 1, column=2, value=format_time(team["runner_time"]["F"]))
        total = team["runner_time"]["M"] + team["runner_time"]["F"]
        ws.cell(row=row_s + 2, column=1, value="Team Total").font = Font(bold=True)
        ws.cell(row=row_s + 2, column=2, value=format_time(total))
        ws.cell(row=row_s + 3, column=1, value="Status").font = Font(bold=True)
        sc = ws.cell(row=row_s + 3, column=2, value="DNF" if team["dnf"] else "Active")
        sc.fill = dnf_fill if team["dnf"] else ok_fill

        ws.column_dimensions["A"].width = 18
        for ci in range(2, len(hours) + 2):
            letter = chr(64 + ci) if ci <= 26 else "A"
            ws.column_dimensions[letter].width = 30

    # ---- Leaderboard sheet ----
    ws_lb = wb.create_sheet("Leaderboard")
    hdrs = ["Rank", "Team", "Total Laps", "Total Time", "Runner M", "Runner F", "Status"]
    for ci, h in enumerate(hdrs, 1):
        c = ws_lb.cell(row=1, column=ci, value=h)
        c.font = hdr_font; c.fill = hdr_fill; c.border = thin_border

    for rank, entry in enumerate(build_leaderboard(), 1):
        ws_lb.cell(row=rank + 1, column=1, value=rank).border = thin_border
        ws_lb.cell(row=rank + 1, column=2, value=f"Team {entry['bib']}").border = thin_border
        ws_lb.cell(row=rank + 1, column=3, value=entry["laps"]).border = thin_border
        ws_lb.cell(row=rank + 1, column=4, value=entry["time_fmt"]).border = thin_border
        ws_lb.cell(row=rank + 1, column=5, value=entry["runner_m"]).border = thin_border
        ws_lb.cell(row=rank + 1, column=6, value=entry["runner_f"]).border = thin_border
        sc = ws_lb.cell(row=rank + 1, column=7, value=entry["status"])
        sc.fill = dnf_fill if entry["dnf"] else ok_fill
        sc.border = thin_border

    for letter in "ABCDEFG":
        ws_lb.column_dimensions[letter].width = 18

    # Save
    filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), "race_results.xlsx")
    wb.save(filepath)
    return send_file(filepath, as_attachment=True, download_name="race_results.xlsx")


@app.route("/api/race/reset", methods=["POST"])
def reset_race():
    race["state"] = "setup"
    race["current_hour"] = 1
    race["hour_start_time"] = None
    race["teams"] = {}
    race["events"] = []
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
