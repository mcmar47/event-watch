// Custom tools that replace the mechanical (non-judgment) steps of the
// event-watch pipeline that were previously done by freshly-authored LLM
// code or freeform LLM comparison every run. That pattern is what caused
// the missing-category bug on 2026-08-24 (a hand-written generator script
// silently dropped Pen & Stationery) — a script rewritten from scratch each
// morning has no guarantee of matching yesterday's correct behavior.
//
// These tools are fixed, tested code that the model calls with structured
// data instead of re-implementing. The model's job stays limited to what
// actually requires judgment: searching the web, deciding whether a result
// is a real/live/future event, and extracting its facts.

import { tool } from "@opencode-ai/plugin/tool"
import { readFile, writeFile, unlink } from "node:fs/promises"
import path from "node:path"

const CATEGORY_LABELS = {
  "biotech-longevity": "🧬 Biotech & Longevity",
  "literary-booktok": "📚 Literary / BookTok",
  "occult-esoteric": "🔮 Occult & Esoteric",
  "retro-gaming": "🕹️ Retro Gaming",
  "wes-anderson": "🎬 Wes Anderson",
  "pen-stationery": "🖋️ Pen & Stationery",
}
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS)

function normalizeTitle(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ")
}

function dedupKey(title, date) {
  return `${normalizeTitle(title)}|${date}`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

async function readSeenEvents(directory) {
  const raw = await readFile(path.join(directory, "seen-events.json"), "utf8")
  return JSON.parse(raw)
}

function renderDigestContent(events, asOf) {
  const byCat = {}
  for (const e of events) {
    ;(byCat[e.category] ??= []).push(e)
  }

  const htmlParts = [
    '<html><head><meta charset="utf-8"><title>Event Digest</title></head><body>',
    "<h1>Upcoming Events Digest</h1>",
    `<p>${events.length} new event(s) as of ${asOf}</p>`,
  ]
  const textParts = [
    `Upcoming Events Digest — ${events.length} new event(s) as of ${asOf}\n`,
  ]

  for (const catId of CATEGORY_ORDER) {
    const items = byCat[catId]
    if (!items || items.length === 0) continue
    const label = CATEGORY_LABELS[catId]
    htmlParts.push(`<h2>${label}</h2>`, "<ul>")
    textParts.push(`\n${label}`)
    for (const e of items) {
      htmlParts.push(
        `<li><b>${escapeHtml(e.title)}</b> &mdash; ${escapeHtml(e.location)} &mdash; ${e.date}<br>` +
          `<i>${escapeHtml(e.description)}</i><br>` +
          `<a href="${e.link}">${e.link}</a></li>`
      )
      textParts.push(
        `- ${e.title} — ${e.location} — ${e.date}\n  ${e.description}\n  ${e.link}`
      )
    }
    htmlParts.push("</ul>")
  }
  htmlParts.push("</body></html>")

  return {
    html: htmlParts.join("\n"),
    text: textParts.join("\n"),
    eventCount: events.length,
    categoryCount: Object.keys(byCat).length,
  }
}

function validateDigestContent(html, body, events) {
  const failures = []
  const trimmed = html.trim()

  if (!/<\/body>\s*<\/html>\s*$/i.test(trimmed)) {
    failures.push("HTML does not end with a closing </body></html> — it may be truncated.")
  }
  for (const e of events) {
    if (!html.includes(escapeHtml(e.title))) {
      failures.push(`Missing title in HTML: "${e.title}"`)
    }
    if (!html.includes(e.date)) {
      failures.push(`Missing date in HTML for "${e.title}": ${e.date}`)
    }
    if (!body.includes(e.title)) {
      failures.push(`Missing title in plain-text body: "${e.title}"`)
    }
  }
  const distinctCategories = new Set(events.map((e) => e.category)).size
  const headingCount = (html.match(/<h2[ >]/gi) || []).length
  if (headingCount !== distinctCategories) {
    failures.push(
      `Category heading count (${headingCount}) does not match the number ` +
        `of distinct categories in the events list (${distinctCategories}).`
    )
  }
  if (!body || body.trim().length < 100) {
    failures.push("Plain-text body is missing, empty, or too short to be a real digest.")
  }

  return { pass: failures.length === 0, failures }
}

export const EventWatchTools = async () => {
  return {
    tool: {
      check_dedup: tool({
        description:
          "Check candidate events against seen-events.json and return which are genuinely new. Use this instead of manually comparing titles/dates by eye — it does exact normalized (trimmed, case-folded) matching on title+date so nothing is missed or double-counted.",
        args: {
          candidates: tool.schema.array(
            tool.schema
              .object({ title: tool.schema.string(), date: tool.schema.string() })
              .passthrough()
          ),
        },
        execute: async ({ candidates }, context) => {
          const seen = await readSeenEvents(context.directory)
          const seenKeys = new Set(seen.map((e) => dedupKey(e.title, e.date)))
          const newOnes = []
          const duplicates = []
          for (const c of candidates) {
            if (seenKeys.has(dedupKey(c.title, c.date))) duplicates.push(c)
            else newOnes.push(c)
          }
          return JSON.stringify(
            {
              new: newOnes,
              duplicates: duplicates.map((d) => ({ title: d.title, date: d.date })),
            },
            null,
            2
          )
        },
      }),

      filter_future_events: tool({
        description:
          "Filter candidate events to only those strictly in the future, using the actual server clock — not a guessed or shell-command-derived date. Returns each candidate with keep=true/false and a reason. Discard anything with keep=false rather than second-guessing it.",
        args: {
          candidates: tool.schema.array(
            tool.schema
              .object({ title: tool.schema.string(), date: tool.schema.string() })
              .passthrough()
          ),
        },
        execute: async ({ candidates }) => {
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const results = candidates.map((c) => {
            const d = new Date(`${c.date}T00:00:00`)
            if (isNaN(d.getTime())) {
              return { ...c, keep: false, reason: "unparseable date" }
            }
            if (d.getTime() <= today.getTime()) {
              return { ...c, keep: false, reason: "date is today or in the past" }
            }
            return { ...c, keep: true, reason: null }
          })
          return JSON.stringify(
            { today: today.toISOString().slice(0, 10), results },
            null,
            2
          )
        },
      }),

      render_digest: tool({
        description:
          "Deterministically render the HTML and plain-text digest from a list of new events, grouped by category. Use this instead of writing your own generator script — it always includes every event and every category exactly once, with consistent formatting. Also writes new-events.json to the project directory as a record of what's being sent.",
        args: {
          events: tool.schema.array(
            tool.schema.object({
              title: tool.schema.string(),
              date: tool.schema.string(),
              category: tool.schema.string(),
              link: tool.schema.string(),
              location: tool.schema.string(),
              description: tool.schema.string(),
            })
          ),
        },
        execute: async ({ events }, context) => {
          const today = new Date().toISOString().slice(0, 10)
          const rendered = renderDigestContent(events, today)
          await writeFile(
            path.join(context.directory, "new-events.json"),
            JSON.stringify(events, null, 2) + "\n",
            "utf8"
          )
          return JSON.stringify(rendered, null, 2)
        },
      }),

      validate_digest: tool({
        description:
          "Validate a generated HTML+plain-text digest against the events it should contain: checks for truncation, every title/date present, and category heading count matching. Run this before sending as a final self-check (render_digest's output should already pass, but confirm before sending).",
        args: {
          html: tool.schema.string(),
          body: tool.schema.string(),
          events: tool.schema.array(
            tool.schema
              .object({
                title: tool.schema.string(),
                date: tool.schema.string(),
                category: tool.schema.string(),
              })
              .passthrough()
          ),
        },
        execute: async ({ html, body, events }) => {
          return JSON.stringify(validateDigestContent(html, body, events), null, 2)
        },
      }),

      append_seen_events: tool({
        description:
          "Append new events to seen-events.json and write the file, skipping any exact duplicates as a final safety net. Use this instead of writing your own merge script. Call this only after the digest email has been sent successfully. Also deletes new-events.json (written by render_digest) as cleanup.",
        args: {
          events: tool.schema.array(
            tool.schema.object({
              title: tool.schema.string(),
              date: tool.schema.string(),
              category: tool.schema.string(),
              link: tool.schema.string(),
              location: tool.schema.string(),
              description: tool.schema.string(),
            })
          ),
        },
        execute: async ({ events }, context) => {
          const filePath = path.join(context.directory, "seen-events.json")
          const seen = await readSeenEvents(context.directory)
          const seenKeys = new Set(seen.map((e) => dedupKey(e.title, e.date)))
          let added = 0
          for (const e of events) {
            const k = dedupKey(e.title, e.date)
            if (seenKeys.has(k)) continue
            seen.push(e)
            seenKeys.add(k)
            added++
          }
          await writeFile(filePath, JSON.stringify(seen, null, 2) + "\n", "utf8")
          try {
            await unlink(path.join(context.directory, "new-events.json"))
          } catch (err) {
            if (err.code !== "ENOENT") throw err
          }
          return JSON.stringify(
            { previousCount: seen.length - added, added, newTotal: seen.length },
            null,
            2
          )
        },
      }),
    },
  }
}
