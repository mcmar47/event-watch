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

import { tool } from "@opencode-ai/plugin/tool"
import {
  escapeHtml,
  createCheckDedupTool,
  createAppendSeenTool,
  createRenderDigestTool,
  createValidateDigestTool,
  createSendDigestEmailTool,
  createFilterFutureEventsTool,
} from "radar-kit"

const DIGEST_RECIPIENT = "michael.cmar@gmail.com"
const SEEN_FILE = "seen-events.json"
const STAGING_FILE = "new-events.json"

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
  renderItemHtml: (e) =>
    `<li><b>${escapeHtml(e.title)}</b> &mdash; ${escapeHtml(e.location)} &mdash; ${e.date}<br>` +
    `<i>${escapeHtml(e.description)}</i><br>` +
    `<a href="${e.link}">${e.link}</a></li>`,
  renderItemText: (e) =>
    `- ${e.title} — ${e.location} — ${e.date}\n  ${e.description}\n  ${e.link}`,
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
          "Send the digest email directly to michael.cmar@gmail.com. Reads new-events.json itself (written by render_digest) and renders + sends in one step via the Gmail API — the HTML/text content never passes back through you as text, so it can't get corrupted by retyping. Only pass a subject; do not attempt to construct or pass htmlBody/body yourself, and do not use the Gmail MCP send-email tool for the digest — use this instead. Call append_seen_events after this succeeds.",
      }),

      append_seen_events: createAppendSeenTool({
        seenFileName: SEEN_FILE,
        stagingFileName: STAGING_FILE,
        keyFields: ["title", "date"],
        argsShape: eventSchema,
        description:
          "Append new events to seen-events.json and write the file, skipping any exact duplicates as a final safety net. Use this instead of writing your own merge script. Call this only after the digest email has been sent successfully. Also deletes new-events.json (written by render_digest) as cleanup.",
      }),
    },
  }
}
