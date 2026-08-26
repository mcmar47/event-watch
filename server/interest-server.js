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
import { readFile, writeFile } from "node:fs/promises"
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
  try {
    return JSON.parse(await readFile(storePath, "utf8"))
  } catch (err) {
    if (err.code === "ENOENT") return {}
    throw err
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

const server = createServer(async (req, res) => {
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

  await writeFile(INTERESTED_PATH, JSON.stringify(marks, null, 2) + "\n", "utf8")
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, interested: value }))
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`interest-server listening on 127.0.0.1:${PORT}`)
})
