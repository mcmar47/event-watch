// Tiny always-on write endpoint for the star / reject marks on the
// event-watch calendar page (index.html) and in the digest email.
//
// Two things arrived here on 2026-08-30, both closing the same gap. The
// star had been collecting for weeks and the count was zero: 264 events
// tracked, not one marked, because the page is somewhere you have to decide
// to visit. feed-radar put the same controls in the digest email and had 11
// marks within days. So:
//
//   1. GET /api/mark, the one-click link the email carries. The route
//      itself is radar-kit's (src/oneClickMark.js) -- shared with
//      release-radar and feed-radar rather than written out a third time.
//   2. An `ignored` store, which this repo never had a writer for even
//      though it always had a reader: radar-kit's createCalibrationTool
//      defaults to reading ignored.json, and weights a rejection more
//      heavily than any unstarred item. Without somewhere to write one,
//      half the calibration signal was unreachable.
//
// The two stores are exclusive, so clicking one clears the other.
//
// The plumbing — atomic writes, the corrupt-store quarantine, JSON body
// parsing, and the catch-all that stops one bad request taking the process
// down — now lives in radar-kit (src/markStore.js and src/interestServer.js)
// rather than being maintained in triplicate here, in release-radar and in
// feed-radar. What stays in this file is the only thing that was ever
// specific to event-watch: the (title, date) key, matching event-tools.js's
// own check_dedup keyFields, and this endpoint's request schema.
//
// interested.json and ignored.json live in this repo's root, next to
// seen-events.json, but are NOT git-tracked (see ../.gitignore) and NOT
// touched by the scheduled
// opencode agent at all -- keeping it fully decoupled from that agent's own
// git pull/commit/push cycle avoids any chance of a click racing a
// scheduled run's git operations in the same working directory. Plain
// Pi-local state; see pi-bootstrap for how it gets backed up.
//
// nginx (see pi-bootstrap's nginx/event-watch config) proxies /api/* to
// this process for every method, so the GET route below needed no config
// change. GET requests for the JSON files themselves are still served
// directly by nginx as static files, same as seen-events.json.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { createInterestServer, sendJson } from "radar-kit/server"
import { createMarkStore } from "radar-kit/markStore"
import { createOneClickMarkRoute } from "radar-kit/oneClickMark"
import { makeKeyFn } from "radar-kit/seenStore"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.join(__dirname, "..")
const PORT = parseInt(process.env.PORT || "8013", 10)

// Same normalization as seen-events.json's own dedup, so a mark survives an
// event's title casing or whitespace changing slightly between runs. This is
// also the key read_calibration joins with (event-tools.js passes the same
// keyFields) -- if the two ever diverge, every mark written here becomes
// invisible to the agent and the calibration block silently stays empty.
const keyOf = makeKeyFn(["title", "date"])

const marks = createMarkStore({
  paths: {
    interested: path.join(REPO_DIR, "interested.json"),
    ignored: path.join(REPO_DIR, "ignored.json"),
  },
  // An event cannot be both starred and rejected: that would feed the
  // scorer contradictory calibration examples.
  exclusive: true,
})

// The two routes differ only in which store they write and which body field
// carries the boolean, so they're built from one description -- the same
// shape release-radar's server uses.
//
// /api/ignored closes the last gap left by the 2026-08-30 change above. That
// change gave this repo an `ignored` store and a reader for it, but the only
// writer was the digest email's one-click link: a rejection could be recorded
// from the inbox and never from a client. That asymmetry was also a trap,
// because the stores are exclusive -- starring something cleared an `ignored`
// mark that no client could see or set back.
function toggleRoute(store) {
  return {
    method: "POST",
    path: `/api/${store}`,
    body: true,
    handler: async ({ res, body }) => {
      const { title, date } = body
      const value = body[store]
      if (!title || !date || typeof value !== "boolean") {
        sendJson(res, 400, { error: `expected {title, date, ${store}: boolean}` })
        return
      }

      await marks.set({ store, key: keyOf({ title, date }), value })
      sendJson(res, 200, { ok: true, [store]: value })
    },
  }
}

createInterestServer({
  name: "event-watch interest-server",
  port: PORT,
  routes: [
    // One-click links from the digest email.
    createOneClickMarkRoute({
      marks,
      fields: ["title", "date"],
      keyOf,
    }),

    // The page's own star toggle. Request shape is unchanged from when this
    // was written out inline, so index.html needed no edit -- and it still
    // clears an `ignored` mark, since the stores are exclusive.
    toggleRoute("interested"),
    toggleRoute("ignored"),
  ],
}).listen()
