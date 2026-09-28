// Tiny always-on write endpoint for the star / reject marks on the
// event-watch calendar page (index.html), the Continuum app, and the digest
// email's one-click links. Since 2026-09-28 the whole server is radar-kit's
// createMarkServer (src/markServer.js). This file used to be ~150 lines that
// were the same as release-radar's and job-radar's modulo the key, and what's
// left here is the only part that was ever specific to event-watch.
//
// Routes (all under /api/, which nginx proxies here for every method):
//   POST /api/interested, /api/ignored  { title, date, <store>: bool, via? }
//   GET  /api/mark                      the email's one-click links
//   POST /api/reviewed                  the Continuum app's Inbox "seen" set
//   GET  /api/health                    pi-ops' watchdog probe
//   POST /api/run                       start today's run now (radar-kit runRoute)
//
// History worth keeping: the star sat at zero marks for weeks while it lived
// only on the page (264 events tracked, not one marked), which is why the
// email carries one-click links; and the ignored store had a reader
// (read_calibration) long before it had any writer.
//
// interested.json, ignored.json and reviewed.json live at the repo root but
// are NOT git-tracked and NOT written by the scheduled agent, which only
// reads the first two. Plain Pi-local state; pi-bootstrap backs them up.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { createMarkServer } from "radar-kit/markServer"
import { KEY_FIELDS } from "../markKey.mjs"

const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

createMarkServer({
  name: "event-watch interest-server",
  port: parseInt(process.env.PORT || "8013", 10),
  repoDir: REPO_DIR,
  // The same fields the agent's check_dedup and read_calibration key by: if
  // they ever diverged, every mark written here would become invisible to it.
  keyFields: KEY_FIELDS,
  runUnit: "event-watch.service",
}).listen()
