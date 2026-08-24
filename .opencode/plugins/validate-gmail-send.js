// Blocks the event-watch digest send from repeating either blank-email
// incident on 2026-08-24. Root cause (confirmed by reading the actual
// source of the Gmail MCP server in use, @gongrzhe/server-gmail-autoauth-mcp
// dist/utl.js createEmailMessage): `mimeType` defaults to "text/plain", and
// the server only builds a multipart message containing `htmlBody` when
// `mimeType` is explicitly something other than "text/plain". Without that,
// `htmlBody` is silently discarded entirely and only `body` gets sent
// verbatim as the whole email — however empty or inadequate it is. `body`
// is also a required field for this tool; it cannot simply be omitted.
//
// This produced two different-looking failures from the same bug:
//   - 06:00 run: mimeType unset, body = a one-line placeholder -> recipient
//     saw only that placeholder line.
//   - 08:28 run: mimeType unset, body = "" -> completely blank email.
//
// This runs before the Gmail MCP tool actually executes, so it can't be
// skipped by the model forgetting or ignoring the prose instruction.
//
// It also cross-checks htmlBody against new-events.json (if still present at
// send time) because the 08:28 run's generator script silently dropped an
// entire category (Pen & Stationery, 2 events) that the skill's own
// prose-instructed validation script was supposed to catch and evidently
// didn't. Checking titles directly here is robust regardless of what
// heading tag or category-count logic the generator script used.

import { readFile } from "node:fs/promises"
import path from "node:path"

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export const ValidateGmailSend = async ({ directory } = {}) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (!/send_email/i.test(input.tool)) return

      const args = output.args ?? {}
      const html = args.htmlBody

      if (html && typeof html === "string" && html.trim() !== "") {
        if (!/<\/body>\s*<\/html>\s*$/i.test(html.trim())) {
          throw new Error(
            "Refusing to send: `htmlBody` does not end with a closing " +
              "</body></html> tag — it may be truncated."
          )
        }

        if (args.mimeType !== "multipart/alternative") {
          throw new Error(
            "Refusing to send: `htmlBody` is set but `mimeType` is not " +
              '"multipart/alternative". This Gmail MCP server defaults ' +
              'mimeType to "text/plain" and, in that case, discards ' +
              "htmlBody entirely and sends only `body` instead — silently. " +
              'Set mimeType to "multipart/alternative".'
          )
        }
      }

      const body = args.body
      if (!body || typeof body !== "string" || body.trim().length < 100) {
        throw new Error(
          "Refusing to send: `body` (the required plain-text alternative) " +
            "is missing, empty, or too short to be a real digest. This " +
            "tool requires a non-empty `body` and will send it verbatim " +
            "instead of htmlBody whenever mimeType isn't " +
            "multipart/alternative — generate a real plain-text version " +
            "from the same event JSON; don't leave it empty or use a " +
            "one-line placeholder."
        )
      }

      if (html && directory) {
        try {
          const raw = await readFile(
            path.join(directory, "new-events.json"),
            "utf8"
          )
          const events = JSON.parse(raw)
          const missing = events.filter(
            (e) => !html.includes(escapeHtml(e.title)) || !html.includes(e.date)
          )
          if (missing.length > 0) {
            throw new Error(
              "Refusing to send: htmlBody is missing " +
                `${missing.length} event(s) present in new-events.json ` +
                `(e.g. "${missing[0].title}") — the generator script likely ` +
                "dropped a category. Fix the generator and regenerate, " +
                "don't send a partial digest."
            )
          }
        } catch (err) {
          if (err.code !== "ENOENT") throw err
        }
      }
    },
  }
}
