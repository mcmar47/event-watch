// Tiny always-on write endpoint for the "interested" star on the
// event-watch calendar page (index.html). Mirrors release-radar's
// server/interest-server.js exactly in shape -- same plain node:http, no
// dependencies, same optimistic-toggle client pattern -- except keyed by
// (title, date) instead of (watch, type, title), matching event-tools.js's
// own check_dedup keyFields.
//
// interested.json lives in this repo's root, next to seen-events.json, but
// is NOT git-tracked (see ../.gitignore) and NOT touched by the scheduled
// opencode agent at all -- keeping it fully decoupled from that agent's own
// git pull/commit/push cycle avoids any chance of a click racing a
// scheduled run's git operations in the same working directory. Plain
// Pi-local state, same category as release-radar's interested.json; see
// pi-bootstrap for how it gets backed up.
//
// nginx (see pi-bootstrap's nginx/event-watch config) proxies POST /api/*
// to this process; GET requests for interested.json itself are served
// directly by nginx as a static file, same as seen-events.json -- no GET
// route needed here at all.

import { createServer } from "node:http"
import { open, readFile, rename } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.join(__dirname, "..")
const PORT = parseInt(process.env.PORT || "8013", 10)

const INTERESTED_PATH = path.join(REPO_DIR, "interested.json")

function normalizeField(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function keyOf({ title, date }) {
  return `${normalizeField(title)}|${normalizeField(date)}`
}

async function readMarks(storePath) {
  let raw
  try {
    raw = await readFile(storePath, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return {}
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    // A store left half-written by a power cut used to take this endpoint
    // down for good: the parse threw, nothing caught it, the process exited,
    // systemd restarted it, and the very next request re-read the same bad
    // bytes and died again -- with no request ever succeeding in between to
    // repair the file. Quarantine it instead, so the marks stay recoverable
    // by hand, and carry on from empty rather than staying down.
    const quarantined = `${storePath}.corrupt-${Date.now()}`
    try {
      await rename(storePath, quarantined)
    } catch {
      // Best-effort: if even the rename fails, starting from empty and
      // staying up still beats crash-looping.
    }
    console.error(
      `readMarks: ${storePath} is not valid JSON (${err.message}) -- ` +
        `moved it to ${quarantined} and starting from empty`
    )
    return {}
  }
}

// Write to a sibling temp file, flush it to disk, then rename into place.
// rename(2) is atomic within a directory, so a reader (or a power cut) sees
// either the whole old file or the whole new one, never a truncated file --
// which is what produced the crash loop readMarks() now defends against.
// The fsync matters on the Pi specifically: without it the rename can land
// while the bytes are still only in page cache.
async function writeMarks(storePath, marks) {
  const tmp = `${storePath}.tmp`
  const handle = await open(tmp, "w")
  try {
    await handle.writeFile(JSON.stringify(marks, null, 2) + "\n", "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, storePath)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

async function handleRequest(req, res) {
  if (req.method !== "POST" || req.url !== "/api/interested") {
    res.writeHead(404).end()
    return
  }

  let body
  try {
    body = await readBody(req)
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid JSON body" }))
    return
  }

  const { title, date } = body
  const value = body.interested
  if (!title || !date || typeof value !== "boolean") {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "expected {title, date, interested: boolean}" }))
    return
  }

  const marks = await readMarks(INTERESTED_PATH)
  const key = keyOf({ title, date })
  if (value) marks[key] = true
  else delete marks[key]

  await writeMarks(INTERESTED_PATH, marks)
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, interested: value }))
}

// Nothing below the handler is allowed to take the process down. An async
// handler that throws becomes an unhandled rejection, which Node turns into
// an immediate exit -- so a single bad request, or one unreadable file, used
// to kill the server outright rather than failing the one request.
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("interest-server: request failed:", err)
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" })
    }
    res.end(JSON.stringify({ error: "internal error" }))
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`interest-server listening on 127.0.0.1:${PORT}`)
})
