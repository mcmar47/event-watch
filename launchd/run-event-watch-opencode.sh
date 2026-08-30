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

# Not `exec`'d (unlike before pi-ops/README.md's heartbeat mechanism existed)
# because a heartbeat needs to be written after opencode exits, whatever its
# exit code — see https://github.com/mcmar47/pi-ops for why. The `if` guards
# capturing a non-zero exit code from tripping `set -e` above.
if "$OPENCODE_BIN" run -m "$MODEL" --auto "$PROMPT"; then
  EXIT_CODE=0
  STATUS="success"
else
  EXIT_CODE=$?
  STATUS="failure"
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

mkdir -p "$REPO_DIR/logs"
printf '{"timestamp": "%s", "exit_code": %s, "status": "%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXIT_CODE" "$STATUS" \
  > "$REPO_DIR/logs/last-run.json"

exit "$EXIT_CODE"
