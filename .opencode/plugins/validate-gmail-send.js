// Blocks the event-watch digest send if it repeats the mistake from the
// 2026-08-24 run: a stray plain-text `body` field alongside `htmlBody`
// silently won out and hid the digest content, even though the skill's
// instructions said not to send one. This runs before the Gmail MCP tool
// actually executes, so it can't be skipped by the model forgetting or
// ignoring the prose instruction.

export const ValidateGmailSend = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (!/send_email/i.test(input.tool)) return

      const args = output.args ?? {}

      if ("body" in args && args.body != null && args.body !== "") {
        throw new Error(
          "Refusing to send: a plain-text `body` field is set alongside `htmlBody`. " +
            "Some mail clients render `body` instead of `htmlBody` when both are present " +
            "— that's what hid the digest content on 2026-08-24. Remove `body` and send " +
            "`htmlBody` only."
        )
      }

      const html = args.htmlBody
      if (!html || typeof html !== "string" || html.trim() === "") {
        throw new Error("Refusing to send: `htmlBody` is missing or empty.")
      }
      if (!/<\/body>\s*<\/html>\s*$/i.test(html.trim())) {
        throw new Error(
          "Refusing to send: `htmlBody` does not end with a closing </body></html> tag " +
            "— it may be truncated."
        )
      }
    },
  }
}
