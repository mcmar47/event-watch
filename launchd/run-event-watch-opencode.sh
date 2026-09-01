#!/bin/bash
# Wrapper for the scheduler (launchd on macOS, systemd on Linux/the Raspberry Pi),
# needed because `opencode run` does not resolve custom slash commands (open
# upstream bug, confirmed as of opencode 1.17.20 —
# https://github.com/anomalyco/opencode/issues/7345): passing "/event-watch" as
# the prompt just forwards that literal text to the model instead of loading
# .opencode/commands/event-watch.md.
#
# Workaround: pull the model and prompt body out of that command file's
# frontmatter ourselves and pass them directly via -m/argv, so this file is the
# only place that needs to change if the invocation trick stops being necessary
# (once upstream fixes it, this can go back to a plain
# `opencode run --auto "/event-watch"`).
#
# Host-portable on purpose: REPO_DIR/OPENCODE_BIN are derived rather than
# hardcoded, and PATH/OPENCODE_ENABLE_EXA are exported here so this same file
# runs unmodified from either machine's scheduler AND from a manual terminal
# run on either machine, with no environment gaps between them.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND_FILE="$REPO_DIR/.opencode/commands/event-watch.md"

export PATH="$HOME/.opencode/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
OPENCODE_BIN="$(command -v opencode || echo "$HOME/.opencode/bin/opencode")"

# Turns on opencode's built-in Exa-hosted web search/fetch tools. This used to
# live only in the launchd plist's EnvironmentVariables block, which meant a
# manual run of this script from a terminal (no launchd involved) silently
# lost web search entirely and fell back to hand-fetching known URLs or
# scraping search engine result pages directly (which mostly just get
# blocked). Setting it here makes it work the same way regardless of how this
# script is invoked.
export OPENCODE_ENABLE_EXA=true

cd "$REPO_DIR"

# This repo is the sync channel between edits made elsewhere (e.g. on the Mac)
# and execution here — without this, a scheduled runner's checkout goes stale
# the first time someone edits a prompt/tool file and pushes from another
# machine.
git pull --ff-only origin main

MODEL=$(sed -n 's/^model: *//p' "$COMMAND_FILE" | head -1)
# `c>=2; /^---$/{c++}` rather than `/^---$/{c++; next} c>=2`: the old form
# skipped EVERY line matching ^---$, not just the two frontmatter fences, so a
# horizontal rule (or a nested YAML block) anywhere in the prompt body was
# silently dropped from what the model actually received. Printing before
# incrementing keeps the two fences out and everything after them in.
PROMPT=$(awk 'c>=2; /^---$/{c++}' "$COMMAND_FILE")

if [ -z "$MODEL" ] || [ -z "$PROMPT" ]; then
  echo "Failed to extract model/prompt from $COMMAND_FILE — aborting." >&2
  exit 1
fi

mkdir -p "$REPO_DIR/logs"

# record_outcome (an .opencode/plugins/event-tools.js tool) writes this on
# the way out of every run that reaches a real conclusion — digest sent OR
# nothing new found. Clear any stale copy now so the post-run check below is
# a plain "did this run produce one" test, with no timestamp arithmetic (and
# so no `date -r` / `stat` portability split between macOS and the Pi).
OUTCOME_FILE="$REPO_DIR/logs/run-outcome.json"
rm -f "$OUTCOME_FILE"

# Upper bound on a single run. Real runs finish in 3–25 min; one still going
# at 45 is hung (a wedged LLM stream that never returns), not slow. Without
# this a hang holds the systemd unit open indefinitely — `Type=oneshot` has
# no default start timeout — and no alert ever fires. `timeout` exits 124
# when it trips; handled below. Skipped gracefully if timeout(1) isn't on
# PATH (some macOS setups).
TIMEOUT_BIN="$(command -v timeout || true)"
RUN_CMD=("$OPENCODE_BIN" run -m "$MODEL" --auto "$PROMPT")
if [ -n "$TIMEOUT_BIN" ]; then
  RUN_CMD=("$TIMEOUT_BIN" --kill-after=2m 45m "${RUN_CMD[@]}")
fi

# Not `exec`'d (unlike before pi-ops/README.md's heartbeat mechanism existed)
# because a heartbeat needs to be written after opencode exits, whatever its
# exit code — see https://github.com/mcmar47/pi-ops for why. The `if` guards
# capturing a non-zero exit code from tripping `set -e` above.
if "${RUN_CMD[@]}"; then
  EXIT_CODE=0
  STATUS="success"
else
  EXIT_CODE=$?
  STATUS="failure"
  if [ "$EXIT_CODE" -eq 124 ]; then
    echo "event-watch: opencode run exceeded the 45m timeout and was killed" \
      "-- treating as a hung run." >&2
    STATUS="timeout"
  fi
fi

# `opencode run` exits 0 even when the model abandons a run partway through
# without raising an error. 2026-08-30: send_digest_email failed twice on an
# expired Gmail token, the agent gave up, and opencode still exited clean --
# so `OnFailure=` never fired and no alert went out, even though the digest
# was built and never sent. (feed-radar grew the equivalent guard a day
# earlier, keyed on its state.json; this repo has no such timestamp, so it
# keys on the staging file instead.)
#
# render_digest writes new-events.json; append_seen_events deletes it only
# after the digest has actually been sent and seen-events.json advanced. A
# run that finds nothing new never calls render_digest, so the file is
# absent then too. new-events.json still sitting here after a clean exit
# therefore means the pipeline stopped between render and finalize -- force a
# non-zero exit so agent-alert@event-watch.service fires.
if [ "$EXIT_CODE" -eq 0 ] && [ -e "$REPO_DIR/new-events.json" ]; then
  echo "event-watch: opencode exited 0 but new-events.json was left behind" \
    "-- render_digest ran but append_seen_events did not, so the digest was" \
    "not sent (or seen-events.json not advanced). Treating as a failed run." >&2
  EXIT_CODE=1
  STATUS="incomplete"
fi

# Second silent-failure mode (2026-09-01): the model stalls mid-run — the LLM
# stream just stops — and `opencode run` still exits 0 without ever reaching
# render_digest. Nothing is left in new-events.json, so the guard above can't
# see it, and it's indistinguishable from a legitimate "nothing new today"
# run. record_outcome is the tie-breaker: the prompt calls it as the final
# action of BOTH clean paths and never on an aborted one, and we cleared any
# stale copy before the run. So a clean exit with no run-outcome.json means
# the run stopped before finishing — force a non-zero exit so
# agent-alert@event-watch.service fires.
if [ "$EXIT_CODE" -eq 0 ] && [ ! -e "$OUTCOME_FILE" ]; then
  echo "event-watch: opencode exited 0 but logs/run-outcome.json was not" \
    "written -- the model never called record_outcome, so the run stopped" \
    "before the digest pipeline completed. Treating as a failed run." >&2
  EXIT_CODE=1
  STATUS="incomplete"
fi

printf '{"timestamp": "%s", "exit_code": %s, "status": "%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXIT_CODE" "$STATUS" \
  > "$REPO_DIR/logs/last-run.json"

exit "$EXIT_CODE"
