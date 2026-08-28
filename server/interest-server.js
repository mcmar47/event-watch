// Tiny always-on write endpoint for the "interested" star on the
// event-watch calendar page (index.html).
//
// The plumbing — atomic writes, the corrupt-store quarantine, JSON body
// parsing, and the catch-all that stops one bad request taking the process
// down — now lives in radar-kit (src/markStore.js and src/interestServer.js)
// rather than being maintained in triplicate here, in release-radar and in
// feed-radar. What stays in this file is the only thing that was ever
// specific to event-watch: the (title, date) key, matching event-tools.js's
// own check_dedup keyFields, and this endpoint's request schema.
//
// interested.json lives in this repo's root, next to seen-events.json, but
// is NOT git-tracked (see ../.gitignore) and NOT touched by the scheduled
// opencode agent at all -- keeping it fully decoupled from that agent's own
// git pull/commit/push cycle avoids any chance of a click racing a
// scheduled run's git operations in the same working directory. Plain
// Pi-local state; see pi-bootstrap for how it gets backed up.
//
// nginx (see pi-bootstrap's nginx/event-watch config) proxies POST /api/*
// to this process; GET requests for interested.json itself are served
// directly by nginx as a static file, same as seen-events.json -- no GET
// route needed here at all.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { createInterestServer, sendJson } from "radar-kit/server"
import { createMarkStore } from "radar-kit/markStore"
import { makeKeyFn } from "radar-kit/seenStore"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.join(__dirname, "..")
const PORT = parseInt(process.env.PORT || "8013", 10)

// Same normalization as seen-events.json's own dedup, so a mark survives an
// event's title casing or whitespace changing slightly between runs.
const keyOf = makeKeyFn(["title", "date"])

const marks = createMarkStore({
  paths: { interested: path.join(REPO_DIR, "interested.json") },
})

createInterestServer({
  name: "event-watch interest-server",
  port: PORT,
  routes: [
    {
      method: "POST",
      path: "/api/interested",
      body: true,
      handler: async ({ res, body }) => {
        const { title, date } = body
        const value = body.interested
        if (!title || !date || typeof value !== "boolean") {
          sendJson(res, 400, { error: "expected {title, date, interested: boolean}" })
          return
        }

        await marks.set({ store: "interested", key: keyOf({ title, date }), value })
        sendJson(res, 200, { ok: true, interested: value })
      },
    },
  ],
}).listen()
