#!/bin/bash
# Run wrapper for event-watch, called by event-watch.service (systemd on the
# Pi; the launchd/ directory name is historical). Daily, 06:00.
#
# Why a wrapper at all: `opencode run` doesn't resolve custom slash commands
# (upstream bug, confirmed as of opencode 1.17.20), so the model and prompt
# are read out of .opencode/commands/event-watch.md here and passed directly.
#
# The shared plumbing (PATH, git pull, command parsing, cost logging, the
# timeout, the completion guards, the heartbeat pi-ops reads) lives in
# radar-kit's scripts/agent-run.sh since 2026-09-28; this file keeps only
# what's specific to event-watch.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_DIR/.opencode/node_modules/radar-kit/scripts/agent-run.sh" \
  || { echo "event-watch: radar-kit's scripts/agent-run.sh is missing -- run pi-ops/update-radar-kit.sh" >&2; exit 1; }

rk_init event-watch
# opencode's built-in Exa web search/fetch: exported here, not only in the
# unit, so a manual terminal run searches too.
export OPENCODE_ENABLE_EXA=true
rk_pull

# The four Rochester bookstore calendars are fetched by script, not searched
# for: the agent reads venue-events.json. Removed first so a failed fetch
# can't leave yesterday's file looking current; a failure is non-fatal (the
# prompt falls back to one targeted search per venue).
rm -f "$REPO_DIR/venue-events.json"
if command -v node >/dev/null; then
  node "$REPO_DIR/scripts/fetch-venues.mjs" \
    || echo "event-watch: venue pre-fetch failed (non-fatal) — agent falls back to search." >&2
else
  echo "event-watch: node not on PATH — skipping venue pre-fetch." >&2
fi

rk_load_command "$REPO_DIR/.opencode/commands/event-watch.md"

# The silent-stall guard: record_outcome writes this as the run's last step,
# on both the sent and the nothing-new paths.
OUTCOME_FILE="$REPO_DIR/logs/run-outcome.json"
rm -f "$OUTCOME_FILE"

rk_cost_begin
rk_run_opencode 45m "$MODEL" "$PROMPT"
rk_fail_if_exists "$REPO_DIR/new-events.json" \
  "new-events.json was left behind -- render_digest ran but append_seen_events did not, so the digest was not sent (or seen-events.json not advanced)."
rk_fail_unless_exists "$OUTCOME_FILE" \
  "logs/run-outcome.json was not written -- the model never called record_outcome, so the run stopped before the digest pipeline completed."
rk_cost_record
rk_heartbeat
exit "$EXIT_CODE"
