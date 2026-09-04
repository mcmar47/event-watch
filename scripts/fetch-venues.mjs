#!/usr/bin/env node
// Pre-fetch for the four Rochester bookstore sources that the agent can't get
// at with a plain web fetch. Writes venue-events.json (a normalized candidate
// list) next to seen-events.json; the event-watch prompt reads that file
// instead of running blind name-searches for these venues.
//
// Why this exists / what changed (investigated live 2026-09-04):
//   - The two Barnes & Noble stores are NOT hard-403'd. That was the old
//     `?view=grid` URL specifically. The current scheme,
//     `?calYear=YYYY&calMonth=M`, returns a normal HTML document whose
//     Next.js RSC payload embeds a `monthEvents` array. A plain fetch that
//     keeps the <script> bytes (i.e. not WebFetch's markdown conversion) has
//     the data. One request per calendar month.
//   - The Siren and the Sea and The Unreliable Narrator both run on
//     Bookmanager (bookmanager.com). withfriends.co is only their checkout
//     widget, not the event source. Bookmanager has a public read API that
//     works with an anonymous session: session/get -> event/v2/list.
//
// Design: no dependencies (Node >=20 global fetch), every venue in its own
// try/catch, always writes the file (partial is fine), always exits 0 unless
// it can't write at all. The agent still runs `filter_future_events` and
// `check_dedup` on whatever this produces — this script is a fetch shim, not
// a source of truth.
//
// GOTCHA: B&N is behind Akamai and 403s a `curl` request even with a browser
// User-Agent (TLS/HTTP2 fingerprint). Node's undici `fetch` is NOT blocked
// and returns 200 reliably. So this stays a Node script — do not "simplify"
// the B&N fetch into a curl call in the wrapper.
//
// Usage:
//   node scripts/fetch-venues.mjs            # write venue-events.json
//   node scripts/fetch-venues.mjs --stdout   # also print the JSON to stdout
//   node scripts/fetch-venues.mjs --months 4 # B&N look-ahead window (default 3)

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT_FILE = path.join(REPO_DIR, "venue-events.json")

const args = process.argv.slice(2)
const alsoStdout = args.includes("--stdout")
const monthsAhead = (() => {
  const i = args.indexOf("--months")
  const n = i >= 0 ? Number(args[i + 1]) : NaN
  return Number.isFinite(n) && n >= 1 && n <= 12 ? Math.floor(n) : 3
})()

// A browser-ish UA. B&N sits behind Akamai; a default Node/undici UA is the
// kind of thing bot rules single out, and this costs nothing.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

const REQ_TIMEOUT_MS = 20_000

async function httpFetch(url, opts = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...opts,
      signal: ac.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        ...(opts.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

// --- date helpers -----------------------------------------------------------

// keep anything from yesterday onward; the agent's filter_future_events makes
// the real cut against the server clock, this is just to keep the file small
const CUTOFF = (() => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
})()

// forward horizon: end of the last month the B&N calendar fetch covers. B&N is
// naturally bounded by which months we request; this applies the same bound to
// the Bookmanager feeds, which return every future occurrence of a recurring
// event (e.g. a monthly book club scheduled a year out) in one response.
const HORIZON = (() => {
  const d = new Date()
  d.setMonth(d.getMonth() + monthsAhead, 0) // day 0 => last day of prior month
  return d.toISOString().slice(0, 10)
})()

// "20260908" -> "2026-09-08"
function normBookmanagerDate(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s || "")
}

// "18:00:00" -> "6:00 PM"
function fmtTime(hms) {
  const m = String(hms || "").match(/^(\d{1,2}):(\d{2})/)
  if (!m) return ""
  let h = Number(m[1])
  const min = m[2]
  const ap = h >= 12 ? "PM" : "AM"
  h = h % 12 || 12
  return min === "00" ? `${h}:00 ${ap}` : `${h}:${min} ${ap}`
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&(?:rsquo|lsquo|#8217|#8216);/g, "'")
    .replace(/&(?:quot|ldquo|rdquo|#8220|#8221);/g, '"')
    .replace(/&(?:mdash|#8212);/g, "—")
    .replace(/&(?:ndash|#8211);/g, "–")
    .replace(/&hellip;|&#8230;/g, "…")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&") // last: avoids turning a literal "&amp;lt;" into "<"
    .replace(/\s+/g, " ")
    .trim()
}

const isChildrensTitle = (t) => /story\s*time|toddler|baby|preschool/i.test(t || "")
const isVirtualTitle = (t) => /\bvirtual(ly)?\b/i.test(t || "")

// --- Barnes & Noble --------------------------------------------------------

// Pull the `monthEvents` array out of the RSC streaming payload embedded in
// the store page HTML. The payload escapes JSON for a JS string literal, so we
// bracket-match the array text and unescape \" and \\ before parsing.
//
// This deliberately reads ONLY `monthEvents` (the store's own calendar). The
// payload also has a "Featured Events" block of `isNationalEvent`/
// `isVirtualEvent` items — B&N's corporate online events (Poured Over
// tapings, Waterstones co-events) that render identically on every store
// page. Those aren't Rochester-venue events, their descriptions are streamed
// as separate RSC chunk refs (fragile to resolve), and the agent's normal
// search already reaches the nationally notable ones. If you ever want them,
// they carry an `eventbriteEventId` you can turn into a registration link.
function extractMonthEvents(html) {
  const key = '\\"monthEvents\\":'
  const start = html.indexOf(key)
  if (start === -1) return null
  const arrStart = start + key.length
  let depth = 0
  let inStr = false
  let esc = false
  let i = arrStart
  for (; i < html.length; i++) {
    const c = html[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  const raw = html
    .slice(arrStart, i)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
  return JSON.parse(raw)
}

const BN_STORES = {
  "bn-pittsford": {
    storeId: 2790,
    venue: "Barnes & Noble Pittsford",
    location: "Rochester, NY",
  },
  "bn-eastview": {
    storeId: 3473,
    venue: "Barnes & Noble Eastview Mall",
    location: "Victor, NY",
  },
}

async function fetchBarnesNoble(source, cfg) {
  const now = new Date()
  const months = []
  for (let k = 0; k < monthsAhead; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1)
    months.push([d.getFullYear(), d.getMonth() + 1])
  }

  const byKey = new Map()
  let monthsParsed = 0
  for (const [year, month] of months) {
    const url = `https://stores.barnesandnoble.com/store/${cfg.storeId}?calYear=${year}&calMonth=${month}`
    const res = await httpFetch(url)
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
    const html = await res.text()
    const monthEvents = extractMonthEvents(html)
    if (!monthEvents) {
      // A real calendar month always renders the monthEvents block (empty
      // array when nothing is on). Its total absence means the page shape
      // changed or the store id resolved to a "not found" page — B&N serves
      // that with HTTP 200, so res.ok didn't catch it.
      continue
    }
    monthsParsed++
    for (const week of monthEvents) {
      for (const wk of week.weekEvents || []) {
        for (const ev of wk.dayEvents || []) {
          if (!ev || !ev.date || !ev.name) continue
          if (ev.date < CUTOFF || ev.date > HORIZON) continue
          const key = `${ev.name}::${ev.date}`
          if (byKey.has(key)) continue
          byKey.set(key, {
            title: String(ev.name).trim(),
            date: ev.date,
            time: ev.time || "",
            venue: cfg.venue,
            location: isVirtualTitle(ev.name) ? "Virtual" : cfg.location,
            link: ev.eventId
              ? `https://stores.barnesandnoble.com/event/${ev.eventId}`
              : `https://stores.barnesandnoble.com/store/${cfg.storeId}`,
            description: stripHtml(ev.descriptionText).slice(0, 600),
            isChildrens: isChildrensTitle(ev.name),
            categoryHint: "",
            source,
          })
        }
      }
    }
  }
  if (monthsParsed === 0) {
    throw new Error(
      `no monthEvents block in any of ${months.length} months for store ${cfg.storeId} — page shape changed or store id invalid`,
    )
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// --- Bookmanager (Siren and the Sea, Unreliable Narrator) -----------------

const BOOKMANAGER_STORES = {
  "unreliable-narrator": {
    cb: 9949267,
    storeId: 1728779,
    venue: "The Unreliable Narrator",
    location: "Rochester, NY",
  },
  "siren-and-the-sea": {
    cb: 9940626,
    storeId: 1413666,
    venue: "The Siren and the Sea",
    location: "Rochester, NY",
  },
}

async function fetchBookmanager(source, cfg) {
  const post = async (endpoint, body) => {
    const res = await httpFetch(
      `https://api.bookmanager.com/customer/${endpoint}?_cb=${cfg.cb}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`)
    const json = await res.json()
    if (json && json.error) throw new Error(`${endpoint} -> ${json.error}`)
    return json
  }

  const session = await post("session/get", { store_id: cfg.storeId })
  const sessionId = session && session.session_id
  if (!sessionId) throw new Error("session/get returned no session_id")

  const list = await post("event/v2/list", {
    store_id: cfg.storeId,
    session_id: sessionId,
  })
  const rows = (list && list.rows) || []

  return rows
    .map((r) => {
      const date = normBookmanagerDate(r.date)
      const books = Array.isArray(r.books)
        ? r.books.map((b) => b.title || b.name).filter(Boolean)
        : []
      const catName =
        r.category && typeof r.category === "object" ? r.category.name : ""
      const desc =
        stripHtml(r.summary).slice(0, 600) ||
        stripHtml(r.description).slice(0, 600)
      return {
        title: String(r.title || "").trim(),
        date,
        time: fmtTime(r.start_time),
        venue: cfg.venue,
        location: cfg.location,
        link:
          source === "unreliable-narrator"
            ? "https://www.unreliablebooks.com/events"
            : "https://thesirenandthesea.com/events",
        description: desc,
        isChildrens: isChildrensTitle(r.title),
        categoryHint: catName || "",
        books,
        source,
      }
    })
    .filter((e) => e.title && e.date && e.date >= CUTOFF && e.date <= HORIZON)
    .sort((a, b) => a.date.localeCompare(b.date))
}

// --- main ----------------------------------------------------------------

async function run() {
  const venues = {}
  const allEvents = []

  const jobs = [
    ...Object.entries(BN_STORES).map(([source, cfg]) => ({
      source,
      fn: () => fetchBarnesNoble(source, cfg),
    })),
    ...Object.entries(BOOKMANAGER_STORES).map(([source, cfg]) => ({
      source,
      fn: () => fetchBookmanager(source, cfg),
    })),
  ]

  await Promise.all(
    jobs.map(async ({ source, fn }) => {
      try {
        const events = await fn()
        venues[source] = { ok: true, count: events.length }
        allEvents.push(...events)
      } catch (err) {
        venues[source] = { ok: false, error: String(err && err.message || err) }
        process.stderr.write(`fetch-venues: ${source} FAILED: ${venues[source].error}\n`)
      }
    }),
  )

  allEvents.sort(
    (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title),
  )

  const out = {
    generatedAt: new Date().toISOString(),
    cutoffDate: CUTOFF,
    horizonDate: HORIZON,
    monthsAhead,
    note:
      "Pre-fetched candidates from the four Rochester bookstore sources. Still " +
      "run filter_future_events and check_dedup on these. categoryHint is a raw " +
      "label from the source, not a category slug — assign the slug yourself. " +
      "Skip events with isChildrens: true (kids' storytime).",
    venues,
    events: allEvents,
  }

  await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n")

  const okCount = Object.values(venues).filter((v) => v.ok).length
  process.stderr.write(
    `fetch-venues: wrote ${allEvents.length} events from ${okCount}/${jobs.length} venues -> ${OUT_FILE}\n`,
  )
  for (const [source, v] of Object.entries(venues)) {
    process.stderr.write(
      `  ${source}: ${v.ok ? `${v.count} events` : `FAILED (${v.error})`}\n`,
    )
  }

  if (alsoStdout) process.stdout.write(JSON.stringify(out, null, 2) + "\n")
}

run().catch((err) => {
  // only reached if writeFile itself failed or something outside the per-venue
  // guards threw — the wrapper treats a non-zero here as "skip venue prefetch,
  // continue the run"
  process.stderr.write(`fetch-venues: fatal: ${err && err.stack || err}\n`)
  process.exit(1)
})
