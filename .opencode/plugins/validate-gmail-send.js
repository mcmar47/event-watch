// See radar-kit's src/validateGmailSendPlugin.js for the actual guardrail
// logic and why it exists (the 2026-08-24 blank-email incidents).
import { createValidateGmailSendPlugin } from "radar-kit"

export const ValidateGmailSend = createValidateGmailSendPlugin({
  stagingFileName: "new-events.json",
  matchFields: [
    { key: "title", escape: true },
    { key: "date", escape: false },
  ],
})
