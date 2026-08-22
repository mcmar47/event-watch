#!/bin/bash
# Wrapper for the launchd job, needed because `opencode run` does not
# resolve custom slash commands (open upstream bug, confirmed as of
# opencode 1.17.20 — https://github.com/anomalyco/opencode/issues/7345):
# passing "/event-watch" as the prompt just forwards that literal text to
# the model instead of loading .opencode/commands/event-watch.md.
#
# Workaround: pull the model and prompt body out of that command file's
# frontmatter ourselves and pass them directly via -m/argv, so this file
# is the only place that needs to change if the invocation trick stops
# being necessary (once upstream fixes it, this can go back to a plain
# `opencode run --auto "/event-watch"`).
set -euo pipefail

REPO_DIR="/Users/michaelcmar/Projects/event-watch"
COMMAND_FILE="$REPO_DIR/.opencode/commands/event-watch.md"
OPENCODE_BIN="/Users/michaelcmar/.opencode/bin/opencode"

cd "$REPO_DIR"

MODEL=$(sed -n 's/^model: *//p' "$COMMAND_FILE" | head -1)
PROMPT=$(awk '/^---$/{c++; next} c>=2' "$COMMAND_FILE")

if [ -z "$MODEL" ] || [ -z "$PROMPT" ]; then
  echo "Failed to extract model/prompt from $COMMAND_FILE — aborting." >&2
  exit 1
fi

exec "$OPENCODE_BIN" run -m "$MODEL" --auto "$PROMPT"
