// Custom tools that replace the mechanical (non-judgment) steps of the
// event-watch pipeline that were previously done by freshly-authored LLM
// code or freeform LLM comparison every run. That pattern is what caused
// the missing-category bug on 2026-08-24 (a hand-written generator script
// silently dropped Pen & Stationery) — a script rewritten from scratch each
// morning has no guarantee of matching yesterday's correct behavior.
//
// The actual tool logic (Gmail send, digest render/validate, dedup) now
// lives in radar-kit (github.com/mcmar47/radar-kit), shared with job-radar
// and release-radar — this file only supplies event-watch's own data shape:
// the category grouping, per-item HTML, and which fields matter for dedup
// and validation. See that package's README for why each piece is or isn't
// shared.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tool } from "@opencode-ai/plugin/tool"
import {
  escapeHtml,
  safeUrl,
  createCheckDedupTool,
  createAppendSeenTool,
  createRenderDigestTool,
  createValidateDigestTool,
  createSendDigestEmailTool,
  createFilterFutureEventsTool,
  createCalibrationTool,
  markUrls,
} from "radar-kit"

const DIGEST_RECIPIENT = "michael.cmar@gmail.com"
const SEEN_FILE = "seen-events.json"
const STAGING_FILE = "new-events.json"

// Base URL for the one-click star/reject links in the digest email. This is
// the nginx vhost (port 8010), which proxies /api/ to interest-server.js --
// NOT the interest-server's own port, which listens on 127.0.0.1 only.
// Tailscale-only, so these links work from a phone on the tailnet and are
// unreachable from the public internet. Pinned to the Pi's Tailscale IP
// rather than its hostname so a host rename can't break the email's links;
// override with EVENT_WATCH_BASE_URL if the address ever changes.
//
// Putting the feedback controls in the EMAIL rather than only on the web
// page is the whole point. This repo had the star on index.html for weeks
// and collected exactly 0 marks against 264 tracked events, because the
// page is a place you have to decide to visit. feed-radar shipped the same
// controls in its digest and had 11 marks within days. read_calibration is
// the only training signal this agent has, so the controls have to live
// where the reading happens. See radar-kit/src/oneClickMark.js.
const FEEDBACK_BASE = process.env.EVENT_WATCH_BASE_URL || "http://100.79.18.117:8010"

// The key fields here MUST stay in step with the interest-server's keyOf and
// with read_calibration's keyFields below -- all three are ["title", "date"].
const linksFor = (e) =>
  markUrls({ baseUrl: FEEDBACK_BASE, params: { title: e.title, date: e.date } })

const CATEGORY_LABELS = {
  "biotech-longevity": "🧬 Biotech & Longevity",
  "literary-booktok": "📚 Literary / BookTok",
  "occult-esoteric": "🔮 Occult & Esoteric",
  "retro-gaming": "🕹️ Retro Gaming",
  "wes-anderson": "🎬 Wes Anderson",
  "pen-stationery": "🖋️ Pen & Stationery",
  "fall-autumn": "🍂 Fall / Autumn",
  "paranormal-events": "👻 Paranormal Events",
}
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS)

const digestConfig = {
  pageTitle: "Upcoming Events Digest",
  unitLabel: "event",
  groupKey: (e) => e.category,
  groupOrder: CATEGORY_ORDER,
  groupLabel: (id) => CATEGORY_LABELS[id],
  renderItemHtml: (e) => {
    const links = linksFor(e)
    return (
      `<li><b>${escapeHtml(e.title)}</b> &mdash; ${escapeHtml(e.location)} &mdash; ${e.date}<br>` +
      `<i>${escapeHtml(e.description)}</i><br>` +
      `<a href="${escapeHtml(safeUrl(e.link))}">${escapeHtml(e.link)}</a><br>` +
      // escapeHtml on the mark URLs is not optional: they carry the event
      // title as a query param, so the URL itself contains & separators and
      // any & from the title's own percent-encoding.
      `<small><a href="${escapeHtml(links.interested)}">&#9733; more like this</a> &nbsp;·&nbsp; ` +
      `<a href="${escapeHtml(links.ignored)}">&#10005; not for me</a></small></li>`
    )
  },
  renderItemText: (e) => {
    const links = linksFor(e)
    return (
      `- ${e.title} — ${e.location} — ${e.date}\n  ${e.description}\n  ${e.link}\n` +
      `  more like this: ${links.interested}\n` +
      `  not for me:     ${links.ignored}`
    )
  },
  matchFields: [
    { key: "title", escape: true },
    { key: "date", escape: false },
  ],
}

const candidateSchema = tool.schema
  .object({ title: tool.schema.string(), date: tool.schema.string() })
  .passthrough()

const eventSchema = tool.schema.object({
  title: tool.schema.string(),
  date: tool.schema.string(),
  category: tool.schema.string(),
  link: tool.schema.string(),
  location: tool.schema.string(),
  description: tool.schema.string(),
})

const validateItemSchema = tool.schema
  .object({
    title: tool.schema.string(),
    date: tool.schema.string(),
    category: tool.schema.string(),
  })
  .passthrough()

export const EventWatchTools = async () => {
  return {
    tool: {
      check_dedup: createCheckDedupTool({
        seenFileName: SEEN_FILE,
        keyFields: ["title", "date"],
        argsShape: candidateSchema,
        description:
          "Check candidate events against seen-events.json and return which are genuinely new. Use this instead of manually comparing titles/dates by eye — it does exact normalized (trimmed, case-folded) matching on title+date so nothing is missed or double-counted.",
      }),

      filter_future_events: createFilterFutureEventsTool(),

      // Keyed the same way as check_dedup above and as
      // server/interest-server.js writes marks. If those three ever
      // disagree, the join finds nothing and every run reports an empty
      // calibration block rather than failing loudly — so change them
      // together.
      read_calibration: createCalibrationTool({
        seenFileName: SEEN_FILE,
        keyFields: ["title", "date"],
        describe: (e) =>
          `[${CATEGORY_LABELS[e.category] ?? e.category}] ${e.title}` +
          (e.location ? ` (${e.location})` : "") +
          (e.description ? ` — ${e.description}` : ""),
      }),

      render_digest: createRenderDigestTool({
        digestConfig,
        stagingFileName: STAGING_FILE,
        argsShape: eventSchema,
        description:
          "Deterministically render the HTML and plain-text digest from a list of new events, grouped by category. Use this instead of writing your own generator script — it always includes every event and every category exactly once, with consistent formatting. Also writes new-events.json to the project directory as a record of what's being sent.",
      }),

      validate_digest: createValidateDigestTool({
        digestConfig,
        argsShape: validateItemSchema,
        description:
          "Validate a generated HTML+plain-text digest against the events it should contain: checks for truncation, every title/date present, and category heading count matching. Run this before sending as a final self-check (render_digest's output should already pass, but confirm before sending).",
      }),

      send_digest_email: createSendDigestEmailTool({
        digestConfig,
        stagingFileName: STAGING_FILE,
        digestRecipient: DIGEST_RECIPIENT,
        extraResultFields: (events) => ({
          categoryCount: new Set(events.map((e) => e.category)).size,
        }),
        description:
          "Send the digest email directly to michael.cmar@gmail.com. Reads new-events.json itself (written by render_digest) and renders + sends in one step over Gmail SMTP — the HTML/text content never passes back through you as text, so it can't get corrupted by retyping. Only pass a subject; do not attempt to construct or pass htmlBody/body yourself. Call append_seen_events after this succeeds.",
      }),

      append_seen_events: createAppendSeenTool({
        seenFileName: SEEN_FILE,
        stagingFileName: STAGING_FILE,
        keyFields: ["title", "date"],
        argsShape: eventSchema,
        description:
          "Append new events to seen-events.json and write the file, skipping any exact duplicates as a final safety net. Use this instead of writing your own merge script. Call this only after the digest email has been sent successfully. Also deletes new-events.json (written by render_digest) as cleanup.",
      }),

      // Closes the silent-stall gap (2026-09-01): `opencode run` exits 0 even
      // when the model abandons a run mid-pipeline — the LLM stream just
      // stops before render_digest is ever reached. No new-events.json is
      // left behind, so the wrapper's other guard can't see it, and it looks
      // identical to a legitimate "nothing new today" run. The wrapper
      // (launchd/run-event-watch-opencode.sh) deletes logs/run-outcome.json
      // before each run and fails the run — firing agent-alert@ — if it's
      // still absent after a clean exit. So this MUST be the last thing every
      // completed run does, on both the digest-sent and nothing-new paths,
      // and must NOT be called on a path that aborted because a step failed.
      record_outcome: tool({
        description:
          "Record that this run reached a definite conclusion. Call exactly once, as the final action, on BOTH clean paths: after append_seen_events and the commit when a digest was sent, or at the very end of a run that found no new events and correctly sent nothing. Do NOT call it if you are stopping early because a step failed (e.g. send_digest_email errored twice) — an uncalled record_outcome is exactly how the scheduler detects an abandoned run and fires its alert.",
        args: {
          sent: tool.schema.boolean(),
          eventCount: tool.schema.number(),
          note: tool.schema.string(),
        },
        execute: async ({ sent, eventCount, note }, context) => {
          const record = {
            timestamp: new Date().toISOString(),
            sent,
            eventCount,
            note,
          }
          await mkdir(path.join(context.directory, "logs"), { recursive: true })
          await writeFile(
            path.join(context.directory, "logs", "run-outcome.json"),
            JSON.stringify(record, null, 2) + "\n",
            "utf8"
          )
          return `Outcome recorded: ${JSON.stringify(record)}`
        },
      }),
    },
  }
}
