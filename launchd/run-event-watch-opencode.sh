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

# Turns on opencode's built-in Exa-hosted web search/fetch tools. This used to
# live only in the launchd plist's EnvironmentVariables block, which meant a
# manual run of this script from a terminal (no launchd involved) silently
# lost web search entirely and fell back to hand-fetching known URLs or
# scraping search engine result pages directly (which mostly just get
# blocked). Setting it here makes it work the same way regardless of how this
# script is invoked.
export OPENCODE_ENABLE_EXA=true

cd "$REPO_DIR"

MODEL=$(sed -n 's/^model: *//p' "$COMMAND_FILE" | head -1)
PROMPT=$(awk '/^---$/{c++; next} c>=2' "$COMMAND_FILE")

if [ -z "$MODEL" ] || [ -z "$PROMPT" ]; then
  echo "Failed to extract model/prompt from $COMMAND_FILE — aborting." >&2
  exit 1
fi

exec "$OPENCODE_BIN" run -m "$MODEL" --auto "$PROMPT"
