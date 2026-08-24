---
description: Search for new events across all watched categories, email a digest, and update seen-events.json
model: openrouter/deepseek/deepseek-v4-flash-0731
---

Read seen-events.json in this repository first — it's a JSON array of events already
reported in past runs, each with at least a "title" and "date" field.

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

Search the web for newly announced events in these categories:

1. Biotech & longevity — conferences, public talks, panels, or expos on biotech,
   aging/longevity research, or AI-in-biotech, especially in or near NYC, Rochester NY,
   or available virtually.
2. Literary / BookTok — book festivals, author readings/signings, literary award
   ceremonies or shortlist announcements (Booker Prize, International Booker,
   etc.), and BookTok-adjacent community events, in NYC, Rochester NY/upstate NY,
   or online.

   In addition to web search, for this category also check these specific
   event-listing pages directly and pull any qualifying future events from them:
     - https://stores.barnesandnoble.com/store/3473?view=grid
     - https://stores.barnesandnoble.com/store/2790?view=grid
     - https://thesirenandthesea.com/events
     - https://www.unreliablebooks.com/events
   For the two Barnes & Noble store pages specifically: skip any event that is a
   "storytime" or otherwise clearly aimed at children/toddlers (these pages mix
   adult author events with kids' storytime) — only include adult/general-audience
   book events from those two pages.
3. Occult & esoteric — tarot, astrology, occult book fairs, esoteric shop pop-ups
   or events, in NYC, Rochester NY, or upstate NY.
4. Retro gaming — retro gaming expos, arcade meetups, classic console/game
   conventions, regionally or nationally.
5. Wes Anderson — screenings, retrospectives, exhibits, or fan events related to
   Wes Anderson's films, anywhere in the US, prioritizing NYC.
6. Pen & stationery — pen shows, stationery expos, fountain pen meetups, or
   maker pop-ups, in NYC, Rochester NY/upstate NY, or nationally notable ones.

For each category, run separate targeted searches — don't combine them into one
query. Cap it at 2-3 targeted searches per category (plus the direct page
checks listed above for literary/BookTok): if that isn't turning up enough
candidates, move on with what you have rather than continuing to search —
extra rounds of searching multiply the token cost of the whole run because
every prior search result stays in context for the rest of it. Only surface
events with a concrete date.

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
  same data, and returns `{html, text, eventCount, categoryCount}`. It also
  writes new-events.json to the repo as a record of what's being sent — you
  don't need to write that file yourself.
- Call `validate_digest` with the returned `html`, `text` (as `body`), and the
  events list, as a final self-check before sending. `render_digest`'s output
  should already pass; if `validate_digest` reports failures anyway, that
  means the events list you built has a problem (e.g. a field that doesn't
  match what you searched) — fix the events list and re-render, don't
  hand-edit the HTML or text directly. If you can't get a clean pass after 2
  attempts, stop: do not send anything and do not modify seen-events.json.
- Once validation passes, send the email exactly ONCE using the Gmail MCP
  server's send-email tool, addressed to michael.cmar@gmail.com, with the
  `render_digest` output's `html` as `htmlBody`, its `text` as `body` (this
  tool requires `body`; it cannot be omitted or left empty), AND `mimeType`
  set explicitly to `"multipart/alternative"`. This is not optional: this
  Gmail MCP server defaults `mimeType` to `"text/plain"` when it isn't given,
  and whenever `mimeType` resolves to `"text/plain"` it discards `htmlBody`
  completely and sends only `body` as the whole email — silently, with no
  error. Never send more than one digest email in a run, and never send a
  "fixed" follow-up or duplicate if something looks off after sending — that
  makes the inbox worse, not better. If the send tool call itself errors
  (e.g. network/auth error), you may retry the identical send once; if it
  still fails, stop and report the error rather than trying alternate
  content.
- Only after the single validated send succeeds: call `append_seen_events`
  with the same events list. It appends to seen-events.json (skipping any
  exact duplicates as a final safety net) and deletes new-events.json for
  you. Then commit seen-events.json with a message like "Add N new events
  from [date] run" and push to the current branch.

If no new events are found in any category, do not send an email — just exit
without committing.
