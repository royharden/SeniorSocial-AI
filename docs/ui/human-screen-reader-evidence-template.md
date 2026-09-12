# WP-031 human screen-reader evidence record

Copy this file once per `coverageRuns[].id`. Do not overwrite the canonical JSON template. Initial status is `not_run`; delete bracketed guidance only after entering a human observation.

## Run identity

| Field | Value |
|---|---|
| Run ID | `[RUN-…]` |
| Result | `not_run` (`pass`, `fail`, or `blocker` only after execution) |
| Sealed candidate SHA | `c379d2b69a162d8fab46409bdb5ed9af1373b3da` |
| Local base URL | `http://127.0.0.1:3100` |
| Candidate state | `post_repair_sealed` |
| Bound by | `0184_Codex_GPT56-SOL_Integrator` |
| Bound at UTC | `2026-09-12T03:43:26Z` |
| Tester | `[name/callsign]` |
| Started UTC | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Completed UTC | `[YYYY-MM-DDTHH:MM:SSZ]` |
| Operating system + version/build | `[exact]` |
| Browser + version | `[exact]` |
| Assistive technology + version | `[exact]` |
| Locale | `[en or es]` |
| Display mode | `[standard or easy]` |
| Synthetic fixture IDs (no credentials) | `[exact]` |
| Sighted assistance used? | `no` (`yes` forces `blocker`) |

## Step observations

Add one row for every required journey step and every status action. Never leave a started row blank.

| Journey ID | Step ID | Route | Action ID | Result | Exact keystrokes | Observed accessible name / role / states | Verbatim AT transcript and live announcement | UTC time | Evidence files | Defect ID |
|---|---|---|---|---|---|---|---|---|---|---|
| `[JOURNEY-…]` | `[STEP-…]` | `[/route]` | `[ACTION-… or n/a]` | `not_run` | `[literal keys in order]` | `[name; role; pressed/checked/expanded/disabled/busy]` | `[verbatim, including silence as “no announcement”]` | `[timestamp]` | `[screenshot/recording name or none]` | `[WP031-HUMAN-NNN or none]` |

For `JOURNEY-ALL-ROUTES`, include one row per route even though the step ID repeats; the route plus step ID is the observation identity. For `STEP-STATUS-01`, include one row per action ID.

## Defect records

Create one section per fail/blocker.

### `[WP031-HUMAN-NNN] [short summary]`

- Result: `[fail or blocker]`
- Severity: `[critical | high | medium | low]`
- Success criterion: `[one testable sentence]`
- Journey / step / action: `[IDs]`
- Route, locale, mode: `[exact]`
- Reproduction keystrokes: `[literal sequence from direct navigation]`
- Expected accessible name, role, state, announcement: `[exact]`
- Actual verbatim transcript: `[exact; write “no announcement” for silence]`
- UTC timestamp: `[exact]`
- Evidence files: `[names and checksums if stored outside version control]`
- Sighted assistance: `[none; otherwise why it was required and result blocker]`
- Data/privacy confirmation: `[synthetic only; no credentials or personal data captured]`
- Disposition: `[open | repaired-awaiting-rerun | accepted-risk with named authority and reason]`
- Owner and target: `[name/callsign, repair commit or planned candidate]`
- Rerun linkage: `[run ID and sealed SHA, or pending]`

## Run decision

- Required route rows completed: `[count]/12`
- Required status actions completed: `[count]/19`
- Passed: `[count]`
- Failed: `[count]`
- Blocked: `[count]`
- Not run: `[count]`
- Defect IDs: `[list or none]`
- Final run result: `[pass | fail | blocker; never pass with any fail/blocker/not_run]`
- Tester signature and UTC time: `[name/callsign, timestamp]`
- Independent notes: `[Do not claim certification, VPAT, conformance, or user-study evidence.]`
