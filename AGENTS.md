# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## What this repo is

A scheduled agent: search the web for newly announced events across eight watched categories
(biotech/longevity, literary/BookTok, occult/esoteric, retro gaming, Wes Anderson, pen/stationery,
fall/autumn, paranormal), dedup against `seen-events.json`, email an HTML digest of what's new, and
update the store. This is the repo `job-radar` and `release-radar` are modeled on (same shape:
scheduled run, JSON store, emailed digest) — read this one first if working across the fleet, since
its own README is intentionally just a title and this file plus `.opencode/commands/event-watch.md`
are the real documentation. `radar-kit` (`../radar-kit`) holds the plugin code this repo's own
`.opencode/plugins/event-tools.js` builds on.

## Commands

No build/lint/test tooling — the only "command" is the agent itself.

- **Run manually (opencode path, primary):** `./launchd/run-event-watch-opencode.sh` — always
  through this wrapper, never a bare `opencode run "/event-watch"`, which does not resolve custom
  slash commands (upstream opencode bug; see the comment block at the top of the script).
- **Run manually (Claude Code path, fallback):** `claude -p "/event-watch" --model haiku`

## Architecture — three parallel runners, opencode is primary

Unusually for the fleet, this repo has **three** copies of essentially the same prompt, not two:

- **`.opencode/commands/event-watch.md`** (primary, day-to-day) — the richer version. It calls
  `radar-kit`-backed tools (`read_calibration`, `filter_future_events`, `check_dedup`,
  `render_digest`, `send_digest_email`, `append_seen_events`) instead of doing search-result
  filtering, dedup, and digest assembly by hand, and includes search-budget caps and a
  Rochester/upstate-NY-first search order that the other two copies don't have.
- **`.claude/commands/event-watch.md`** (fallback) — the same behavioral intent, done by hand
  where the opencode copy uses a tool: no `read_calibration` tool, so the interested/ignored join
  is described as a manual step; no `filter_future_events`/`check_dedup` tools, so the date-check
  and dedup logic is spelled out inline instead of delegated.
- **`.agents/skills/source-command-event-watch/SKILL.md`** — a Codex-runnable copy migrated from
  the Claude Code version, used when Codex is the active runner. If you change the search/filter/
  dedup/email logic, all three need to move together, or a fallback run behaves differently from
  the primary one.
- **`launchd/run-event-watch-opencode.sh`** exists only because `opencode run` doesn't resolve
  custom slash commands (upstream bug, confirmed as of opencode 1.17.20) — it parses the model and
  prompt body out of `.opencode/commands/event-watch.md`'s frontmatter itself and passes them
  directly via `-m`/argv. `OPENCODE_ENABLE_EXA` is exported inside this script (not just the
  launchd/systemd unit's environment), specifically so a manual terminal run gets web search too,
  not just the scheduled one.
- **The wrapper enforces a stronger success check than opencode's own exit code.** `opencode run`
  exits 0 even when the model abandons a run partway through with no error, so the wrapper adds
  three guards, any of which forces a non-zero exit and fires `OnFailure=agent-alert@`:
  1. **Render-but-no-send** (confirmed 2026-08-30: `send_digest_email` failed twice on an expired
     Gmail token, the agent gave up, digest built but never sent). `render_digest` writes
     `new-events.json` as staging; `append_seen_events` deletes it only after a successful send.
     `new-events.json` still present after a clean exit means the pipeline stopped between render
     and finalize.
  2. **Stall-before-render** (confirmed 2026-09-01: the LLM stream just stopped at an internal
     step, opencode exited 0, nothing staged — indistinguishable from a legitimate "nothing new"
     run). The `record_outcome` tool writes `logs/run-outcome.json` as the final action of every
     run that reaches a real conclusion (digest sent *or* nothing new), and never on an aborted
     one; the wrapper deletes it before the run and fails the run if it's absent after a clean
     exit. This is why the prompt's FINAL STEP is load-bearing, not bookkeeping — and why
     `record_outcome` is opencode-only: it backs a check that only the opencode wrapper runs, so
     the `.claude` copy writes the same file by hand instead and the Codex copy needn't bother.
  3. **Hang**: the opencode invocation is wrapped in `timeout 45m` (skipped if `timeout(1)` is
     absent), since `Type=oneshot` has no default start timeout and a wedged run would otherwise
     hold the unit open forever with no alert.
- **The wrapper pre-fetches four bookstore sources the agent can't read via a plain web fetch.**
  `scripts/fetch-venues.mjs` (Node, no deps) pulls B&N Pittsford + Eastview (their calendar is
  embedded in a Next.js RSC payload that WebFetch's markdown conversion discards) and The Siren
  and the Sea + The Unreliable Narrator (JS SPAs backed by Bookmanager's `session/get` →
  `event/v2/list` API), and writes `venue-events.json` (gitignored, regenerated every run). All
  three prompt copies read that file for the literary/BookTok venues instead of name-searching;
  the `.claude`/Codex copies run the script themselves since they don't go through the wrapper.
  Non-fatal — every copy falls back to a per-venue name search if the file is missing or a venue
  shows `ok: false`. B&N 403s `curl` (Akamai TLS/HTTP2 fingerprinting) but not Node's `fetch`, so
  this can't be reduced to a shell one-liner.
- **Category slugs are a closed, verbatim set** — see either command file for the current eight and
  their exact `category` field values. Never invent or guess a slug; an unrecognized one breaks
  `render_digest`.
- **`interest-server.js`** (in `server/`) serves `interested.json`/`ignored.json`, written only by
  the web page and only ever read by the agent (via `read_calibration` on the opencode path). Never
  have the agent write them.

## Things that are easy to get wrong

- The `launchd/` directory does not mean launchd — nothing is scheduled on the Mac. The wrapper
  inside it is live and called by the Pi's systemd. See `pi-ops/FLEET.md`'s "Traps".
- The digest must be sent with **one** `send_digest_email`/Gmail call, never a "corrected" resend.
- If nothing new is found across every category, send no email and commit nothing — don't force a
  digest just because the run executed.
- CRITICAL DATE CHECK is not optional busywork: search results and cached pages routinely surface a
  recurring event's *past* occurrence looking current. Discard, don't guess, when a date is
  ambiguous.
