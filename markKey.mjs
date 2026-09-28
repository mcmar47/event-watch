// event-watch's mark key: the fields that identify one event. The ONE place
// they're written down. The agent's tools (check_dedup, append_seen,
// read_calibration, the email's one-click links), server/interest-server.js,
// feed-radar's weekly mark-rate report and pi-ops' quality-lab all import
// this. They used to each spell out ["title", "date"] (five times in this
// repo alone), and if any copy drifted, every star and reject would silently
// stop matching its event, with calibration going quietly empty
// (UNIFICATION-PROS-CONS.md L1.5 step 3, done 2026-09-28).
//
// Keys are built with radar-kit's makeKeyFn(KEY_FIELDS) (trimmed, case-folded,
// whitespace-collapsed). Changing these fields orphans every existing mark.
// No imports on purpose: .opencode/ and server/ each have their own
// node_modules, and this file has to load from both. (.mjs so Node treats it
// as a module even though the repo root has no package.json.)
export const KEY_FIELDS = ["title", "date"]
