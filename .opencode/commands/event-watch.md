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

CRITICAL DATE CHECK: For every candidate event, verify its date against today's
actual current date before including it anywhere. Discard any event whose date
is today or earlier — it must be strictly in the future. Search results and
cached pages frequently surface events from a past year that only look current
(e.g. a recurring annual event's last occurrence, or an old announcement page
still ranking in search). Do not trust a result just because it looks recent or
because the page was indexed recently — check the actual event date printed on
the page against today's date explicitly, and if the date is ambiguous or you
can't confirm the year, discard the event rather than guessing.

Compare every remaining (confirmed-future) event against seen-events.json by
title + date. Only keep events NOT already in that file.

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

If new events are found:
- Write the new events (title, date, category, link, location, description)
  to a temporary JSON file (e.g. new-events.json). This is the single source
  of truth for the digest — get the facts right here once, and never retype
  or paraphrase them again anywhere below.
- Generate the email body by WRITING AND RUNNING A SCRIPT (Python or Node)
  that reads that JSON and mechanically formats it into HTML, grouped by
  category:
  - A bold heading per category, optionally prefixed with a relevant emoji
    (e.g. 🧬 Biotech & Longevity, 📚 Literary / BookTok, 🔮 Occult & Esoteric,
    🕹️ Retro Gaming, 🎬 Wes Anderson, 🖋️ Pen & Stationery).
  - Each event as a bullet: bolded event name, then date, location (or
    "Virtual"), and a one-line description.
  - The source link as hyperlinked text (e.g. a "Link" or the event/venue name
    as the anchor), never a bare pasted URL.
  - Keep it concise and skimmable — short bullets, not long paragraphs.
  Do NOT hand-type the digest prose directly into the email tool call or any
  chat output — free-generating long HTML by hand is exactly what causes
  garbled words, wrong facts, and truncated/dropped sections. The script must
  copy every field verbatim from the JSON, not re-type it.
- Before sending, write and run a separate validation script that checks the
  generated HTML against new-events.json and prints either PASS or a specific
  list of failures:
  - the HTML contains a closing `</body></html>` (i.e. it isn't truncated)
  - every event's title and its exact date string both appear verbatim in the
    HTML
  - the number of category headings in the HTML equals the number of distinct
    categories present in new-events.json
  If validation fails, fix the GENERATOR SCRIPT and regenerate — never
  hand-edit the HTML output directly. Re-run validation after every
  regeneration. If you cannot get a clean PASS after 2 regeneration attempts,
  stop: do not send anything and do not modify seen-events.json. Print a clear
  summary of what failed so it's visible in the run log for manual follow-up.
- Once validation prints PASS, send the email exactly ONCE using the Gmail
  MCP server's send-email tool, addressed to michael.cmar@gmail.com, passing
  the generated HTML as the `htmlBody` field. Do NOT also pass a `body`
  (plain-text) field — some mail clients render `body` instead of `htmlBody`
  when both are present, so a `body` field turns the whole email into
  whatever placeholder or summary text you put there and hides the real
  digest. `htmlBody` alone is sufficient; do not add a plain-text version
  "just in case". Never send more than one digest email in a run, and never
  send a "fixed" follow-up or duplicate if something looks off after sending
  — that makes the inbox worse, not better. If the send tool call itself
  errors (e.g. network/auth error), you may retry the identical send once; if
  it still fails, stop and report the error rather than trying alternate
  content.
- Only after the single validated send succeeds: append the new events to
  seen-events.json (title, date, category, link, location, description) and
  commit the change with a message like "Add N new events from [date] run",
  then push to the current branch. Delete the temporary JSON file and any
  generator/validation scripts before finishing.

If no new events are found in any category, do not send an email — just exit
without committing.
