---
description: Search for new events across all watched categories, email a digest, and update seen-events.json
model: openrouter/z-ai/glm-5.3-flash
---

Read seen-events.json in this repository first — it's a JSON array of events already
reported in past runs, each with at least a "title" and "date" field.

Then call `read_calibration`. It reads `interested.json` (events starred on the web page)
and joins each mark back to its full record in seen-events.json, returning the events that
were actually wanted. Treat those as strong positives when deciding what to surface: they
are what someone clicked, as opposed to what this prompt predicts they would like.

The block is explicit that an unmarked event carries **no** signal — an event that was
delivered and never starred is not a rejection, especially while marks are still sparse.

BACKFILL PASS: Check every existing event in seen-events.json for a missing or
empty "location" or "description" field (older entries, or ones added when a
different execution environment couldn't reach a source page, may be missing
one or both). For each event with a gap, look up its source link (or search
the web using its title/date/category if the link can't be fetched) and fill
in the missing field(s) directly in seen-events.json, using the same "City, ST"
/ "Virtual" format for location and the same one-line factual style for
description described below. If you find events with gaps, edit the file and
commit that as its own small change — e.g. "Backfill missing fields for N
existing events" — then push, before moving on to the search below. If nothing
is missing, skip this step entirely and don't commit anything for it.

Before searching, determine today's actual current date (do not assume or guess —
check the current date as part of this run, e.g. via the `date` shell command). Use
that as your reference point for "future" in everything below.

Search the web for newly announced events in these categories. Each category
lists its exact `category` field value (the slug used in seen-events.json and
recognized by the render_digest tool) — use that slug verbatim for every event
you assign to it; never invent or guess a slug, even one that looks obviously
derived from the category name.

1. Biotech & longevity (slug: `biotech-longevity`) — conferences, public talks,
   panels, or expos on biotech, aging/longevity research, or AI-in-biotech,
   especially in or near Rochester NY, upstate NY, or NYC, or available
   virtually.
2. Literary / BookTok (slug: `literary-booktok`) — book festivals, author
   readings/signings, literary award ceremonies or shortlist announcements
   (Booker Prize, International Booker, etc.), and BookTok-adjacent community
   events, in Rochester NY/upstate NY, NYC, or online.

   Four Rochester-area bookstore sources are handled by a pre-fetch step
   instead of web search: the wrapper runs `scripts/fetch-venues.mjs` at the
   start of every run and writes `venue-events.json`. Read that file. Its
   `events` array (already trimmed to roughly the next few months) covers:
     - Barnes & Noble Pittsford and Barnes & Noble Eastview Mall (Victor, NY)
     - The Siren and the Sea (South Wedge, Rochester, NY)
     - The Unreliable Narrator (N. Goodman St, Rochester, NY)
   Treat each event there as a candidate — mostly `literary-booktok`, but
   assign the slug by what the event actually is (e.g. an occult-themed book
   club goes to `occult-esoteric`), and use `categoryHint` only as a loose
   hint. Run `filter_future_events` and `check_dedup` on them exactly as for
   any other candidate. Each carries title, date, time, venue, location,
   link, and description — base the one-line description on that text. Skip
   any event with `isChildrens: true` (kids' storytime).

   Fallback: if `venue-events.json` is missing, or its `venues` map shows
   `ok: false` for one of the four, run one targeted name search for that
   venue ("Barnes & Noble Pittsford NY author event 2026", "Unreliable
   Narrator Rochester NY event", etc.) — budgeted on top of, not counted
   against, the per-category search cap.
3. Occult & esoteric (slug: `occult-esoteric`) — tarot, astrology, occult book
   fairs, esoteric shop pop-ups or events, in Rochester NY, upstate NY, or NYC.
4. Retro gaming (slug: `retro-gaming`) — retro gaming expos, arcade meetups,
   classic console/game conventions, regionally or nationally.
5. Wes Anderson (slug: `wes-anderson`) — screenings, retrospectives, exhibits,
   or fan events related to Wes Anderson's films, anywhere in the US,
   prioritizing Rochester NY/upstate NY and NYC.
6. Pen & stationery (slug: `pen-stationery`) — pen shows, stationery expos,
   fountain pen meetups, or maker pop-ups, in Rochester NY/upstate NY, NYC, or
   nationally notable ones.
7. Fall / Autumn (slug: `fall-autumn`) — fall festivals, apple/pumpkin picking
   events, corn mazes, foliage tours, harvest fairs, and other autumn-season
   events, ONLY in Rochester NY or upstate NY (unlike the other categories
   above, do not surface NYC or virtual events for this one — skip a candidate
   entirely if it's outside Rochester/upstate NY).
8. Paranormal events (slug: `paranormal-events`) — ghost tours, haunted
   history walks, UFO/cryptid conventions, psychic or mediumship
   demonstrations, and other paranormal-themed events, in Rochester NY,
   upstate NY, NYC, or available virtually.

Rochester NY and upstate NY are the priority region across every category
above that lists more than one location — weight the search process toward
it, not just the category text. For each such category, spend your first 1-2
searches on a Rochester/upstate-NY-specific query (e.g. "<topic> Rochester NY
2026", "<topic> upstate NY 2026") before broader NYC/national/virtual
queries. If those don't turn up a Rochester/upstate NY candidate, it's worth
one extra targeted search beyond the per-category cap below specifically to
chase that region down before falling back to the other locations.

For each category, run separate targeted searches — don't combine them into one
query. Cap it at 3-4 targeted searches per category (plus any venue fallback
search from the literary/BookTok note above, and the extra Rochester/upstate
NY search allowed above): if that isn't turning up enough candidates, move on
with what you have rather than continuing to search — extra rounds of
searching multiply the token cost of the whole run because every prior search
result stays in context for the rest of it. Only surface events with a
concrete date.

CRITICAL DATE CHECK: search results and cached pages frequently surface events
from a past year that only look current (e.g. a recurring annual event's last
occurrence, or an old announcement page still ranking in search). For every
candidate, extract the actual event date printed on the source page — do not
trust a result just because it looks recent or was indexed recently, and if
the date is ambiguous or you can't confirm the year, extract nothing (you'll
still discard it below since an unparseable date fails the future check).
Once you have a candidate list with dates for a category, call the
`filter_future_events` tool with all of them — it checks each against the
actual server clock (not a shell command or your own arithmetic) and returns
keep=true/false with a reason. Drop every candidate it returns keep=false for.

Call the `check_dedup` tool with the remaining (confirmed-future) candidates
for a category — it compares against seen-events.json by normalized title+date
and returns which are genuinely new. Only keep the ones it returns as new; it
already handles whitespace/case differences, so don't second-guess its result
by eye.

For each new event, also determine its location: a short "City, ST" (or
"City, Country" outside the US) for in-person events, or the literal string
"Virtual" for online-only events. Keep this value short and consistently
formatted — it feeds a location filter on a website, so avoid free-form
descriptions, venue addresses, or neighborhood-level detail. If a specific
city truly cannot be determined after checking the event page, use "Unknown".

Also write a one-line description for each new event: one factual sentence
(roughly 8-20 words, no marketing fluff) stating what the event actually is
— e.g. "Annual expo for vintage video games, arcade cabinets, and pinball,
with tournaments and vendor booths." or "Book signing and talk with novelist
Barbara Kingsolver for her new novel Partita." This is the same description
you use in the email digest bullet below — write it once and reuse it in
both places.

If new events are found, assemble the final list (title, date, category, link,
location, description for each) and use the following tools rather than
hand-writing scripts or prose for any of these steps — they're fixed,
deterministic code, not something to reimplement:

- Call `render_digest` with the full events list. It groups by category in a
  fixed order, generates both the HTML and the plain-text version from the
  same data, writes new-events.json to the repo (the source of truth for what
  gets sent), and returns `{html, text, eventCount, categoryCount}` for your
  own review. Use `validate_digest` on that returned output if you want an
  explicit self-check, but its result isn't load-bearing — `send_digest_email`
  (below) re-validates from new-events.json itself regardless.
- Call `send_digest_email` with just a `subject` string — nothing else. It
  reads new-events.json itself, renders and validates internally, and sends
  over Gmail SMTP, all in one step. Do NOT construct or pass
  `htmlBody`/`body` yourself, and do NOT hand-send the digest any other way —
  use `send_digest_email`. This exists
  specifically because retyping a long HTML digest into a second tool call is
  what caused corrupted/blank sends in past runs — passing only a short
  subject removes that risk entirely. Never call `send_digest_email` more
  than once in a run, and never send a "fixed" follow-up or duplicate if
  something looks off after sending — that makes the inbox worse, not
  better. If it errors (e.g. network/auth error), you may retry once; if it
  still fails, stop and report the error rather than trying alternate
  content.
- Only after the single send succeeds: call `append_seen_events` with the
  same events list. It appends to seen-events.json (skipping any exact
  duplicates as a final safety net) and deletes new-events.json for you.
  Then commit seen-events.json with a message like "Add N new events from
  [date] run" and push to the current branch.

If no new events are found in any category, do not send an email — just skip
straight to the FINAL STEP below without committing.

FINAL STEP — always do this, and do it last, on every run that reaches a
conclusion. Call `record_outcome` exactly once:

- After a digest was sent (i.e. after `append_seen_events` and the commit/push):
  `record_outcome` with `sent: true`, `eventCount` = the number of events sent,
  and a one-line `note`.
- After a run that found nothing new in any category and correctly sent nothing:
  `record_outcome` with `sent: false`, `eventCount: 0`, and a `note` saying so.

Do NOT call `record_outcome` if you are stopping early because a step failed —
e.g. `send_digest_email` errored twice and you are aborting per the instructions
above. In that case just report the error and stop. The scheduler treats a run
that exits without a fresh `record_outcome` as abandoned and fires an alert;
calling it on a failed run would suppress the alert that should fire.
