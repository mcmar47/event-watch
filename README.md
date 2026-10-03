# event-watch

A daily digest of newly announced events worth knowing about, weighted toward Rochester and
upstate New York. Every morning at 06:00 an agent on the Pi searches the web across ten
categories, drops anything already reported or already past, and emails what's new. The first
of the fleet's radars: `job-radar`, `release-radar` and the rest copied this shape.

## What you get

- **The 06:00 digest email**, grouped by category, with one-click ★ / ✕ links on every event. A
  star or a reject is the only feedback the agent learns from (see "Marks" below).
- **A calendar page** at `http://continuum.tail54385e.ts.net:8010` (Tailscale only), showing
  every event found so far, with category filters and the same star/reject controls.
- **The Continuum app's Events tab**, reading the same files, plus an opt-in mirror of chosen
  events into a "Continuum" calendar.
- **At most one push notification** after a digest, only when exactly one of that morning's
  events starts within 3 days.

No email on a day with nothing new. That's normal, not a failure.

## The categories

Biotech & longevity · Literary / BookTok · Occult & esoteric · Retro gaming · Wes Anderson ·
Pen & stationery · Fall / autumn · Paranormal events · Rochester venues · Theatre.

Each has its own search rules (some are Rochester/upstate-only, some take NYC or virtual events
too), written in the prompt, `.opencode/commands/event-watch.md`. Two sources are read directly
rather than searched:

- **Four Rochester bookstores** (Barnes & Noble Pittsford and Eastview, The Siren and the Sea,
  The Unreliable Narrator): `scripts/fetch-venues.mjs` pulls their calendars before each run,
  because their pages don't survive a normal web fetch.
- **The Dryden Theatre and Writers & Books** (the "Rochester venues" category, since 2026-09-28):
  one targeted search each per run, for special programming only, capped at 5 events.
- **Theatre** (since 2026-10-03): one targeted search each per run for the Stratford and Shaw
  festivals (Ontario; passport), Geva Theatre Center, Shakespeare in Delaware Park and NT Live /
  RSC Live screenings at the Little Theatre. Season and production announcements only (one event per
  production, dated its opening night), capped at 5 events.

## How a run works

1. `event-watch.timer` fires `launchd/run-event-watch-opencode.sh` on the Pi (the `launchd/`
   name is historical; nothing runs on a Mac).
2. The wrapper pulls this repo, pre-fetches the bookstore calendars, and starts `opencode` with
   the prompt and model from `.opencode/commands/event-watch.md`.
3. The agent searches each category, checks every candidate's date against the source page (old
   announcements often look current), and runs the tools in `.opencode/plugins/event-tools.js`:
   `filter_future_events`, `check_dedup` against `seen-events.json`, `read_calibration` for your
   marks, then `render_digest` → `send_digest_email` → `append_seen_events`, and finally
   `record_outcome`.
4. The wrapper checks the run really finished (no staging file left behind, an outcome file
   written, no timeout) and writes `logs/last-run.json`, which pi-ops' watchdog reads. Anything
   short of that fires an alert.

## Marks (★ / ✕)

`server/interest-server.js` (`event-watch-interest-server`, port 8013 behind nginx's 8010) is
the only writer of `interested.json` and `ignored.json`. The page, the app and the email's
one-click links all go through it. The agent only reads them: `read_calibration` shows it your
recent stars and rejects as examples before it picks anything. An event is identified by its
title and date, defined once in `markKey.mjs`. The same server keeps `reviewed.json` (the app's
"already seen in the Inbox" set, never read by the agent).

## Files

| Path | What it is |
|---|---|
| `.opencode/commands/event-watch.md` | The prompt: categories, search rules, pipeline. The real spec. |
| `.opencode/plugins/event-tools.js` | The agent's tools, built on `radar-kit` |
| `.claude/commands/`, `.agents/skills/` | Fallback copies of the prompt for Claude Code and Codex; keep all three in step |
| `launchd/run-event-watch-opencode.sh` | The run wrapper (plumbing from radar-kit's `scripts/agent-run.sh`) |
| `scripts/fetch-venues.mjs` | Bookstore calendar pre-fetch → `venue-events.json` (regenerated every run, gitignored) |
| `seen-events.json` | Every event ever reported, committed by each run |
| `server/` | The marks server |
| `markKey.mjs` | The one definition of what identifies an event |
| `index.html` | The calendar page |

## Running it

- **By hand, on the Pi:** `./launchd/run-event-watch-opencode.sh`. Always through the wrapper;
  a bare `opencode run "/event-watch"` doesn't load the command. It's a real, paid run and sends
  a real digest.
- **Early, from anywhere on the tailnet:**
  `curl -X POST -H 'content-type: application/json' http://continuum.tail54385e.ts.net:8010/api/run`
  starts today's run now (refused while one is running, or within 30 minutes of the last trigger).
- **Deploying a change:** push `main`, then `ssh continuum '~/Projects/pi-ops/deploy.sh'`.

More detail (why each guard exists, the incidents behind them) is in `CLAUDE.md`, and how this
fits the rest of the fleet is in `pi-ops/FLEET.md`.
