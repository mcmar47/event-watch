// Copy of release-radar/src/searchTrim.js (2026-11-24); keep the two in step.
// Trim a websearch tool result before the model sees it (plugin hook
// tool.execute.after in .opencode/plugins/release-tools.js).
//
// Why: a release-radar run is ~50 searches, each returning up to ~21 KB, and
// every later turn re-sends all of them. On 2026-11-23 the weekly run's search
// results alone were ~118K tokens of a context that grew to ~264K, so each
// extra search made every remaining turn dearer. The first passage of each
// result is the one the search engine picked as most relevant, and the
// title/URL/date header is what the model actually cites, so keep those and
// cap the rest.
//
// Result shape (opencode's websearch): blocks separated by a line of "---":
//   Title: ...\nURL: ...\nPublished: ...\nAuthor: ...\nHighlights:\n<text>
//
// Pure: text in, text out. Anything that doesn't look like that shape is only
// hard-capped, never mangled.

export const DEFAULTS = { maxResults: 6, maxHighlightChars: 1000, fallbackChars: 6000 }

const SEPARATOR = /\n---\s*\n/

function trimBlock(block, maxHighlightChars) {
  const i = block.indexOf("Highlights:")
  if (i === -1) return block.length > maxHighlightChars + 400 ? block.slice(0, maxHighlightChars + 400) + " …" : block
  const head = block.slice(0, i + "Highlights:".length)
  // Collapse runs of blank lines and the "..." gap markers the engine inserts
  // between passages; they carry no information.
  let body = block
    .slice(i + "Highlights:".length)
    .replace(/\n\s*\.\.\.\s*\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (body.length > maxHighlightChars) body = body.slice(0, maxHighlightChars).replace(/\s+\S*$/, "") + " …"
  return `${head}\n${body}`
}

export function trimSearchOutput(text, opts = {}) {
  const { maxResults, maxHighlightChars, fallbackChars } = { ...DEFAULTS, ...opts }
  if (typeof text !== "string") return text
  const blocks = text.split(SEPARATOR).map((b) => b.trim()).filter(Boolean)
  const looksRight = blocks.length > 0 && blocks.every((b) => /^Title:/m.test(b))
  if (!looksRight) {
    return text.length > fallbackChars ? text.slice(0, fallbackChars) + "\n[search output truncated]" : text
  }
  const kept = blocks.slice(0, maxResults).map((b) => trimBlock(b, maxHighlightChars))
  const omitted = blocks.length - kept.length
  const tail = omitted > 0 ? `\n\n[${omitted} lower-ranked result(s) omitted]` : ""
  return kept.join("\n\n---\n\n") + tail
}
