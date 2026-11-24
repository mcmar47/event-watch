import { test } from "node:test"
import assert from "node:assert/strict"
import { trimSearchOutput } from "../src/searchTrim.mjs"

const block = (n, body) => `Title: Result ${n}\nURL: https://example.com/${n}\nPublished: 2026-09-13T15:57:30.000Z\nAuthor: N/A\nHighlights:\n${body}`

test("keeps the first results, caps each highlight, notes what was omitted", () => {
  const big = "word ".repeat(1000)
  const text = Array.from({ length: 9 }, (_, i) => block(i + 1, big)).join("\n\n---\n\n")
  const out = trimSearchOutput(text)
  assert.ok(out.length < text.length / 4, `${out.length} vs ${text.length}`)
  assert.equal((out.match(/^Title:/gm) || []).length, 6)
  assert.match(out, /Title: Result 1\nURL: https:\/\/example.com\/1\nPublished: 2026-09-13/)
  assert.match(out, /\[3 lower-ranked result\(s\) omitted\]/)
  assert.doesNotMatch(out, /Result 7/)
})

test("a short result passes through intact (gap markers and blank runs collapse)", () => {
  const text = block(1, "Out 2 September 2025.\n\n...\n\n\n\nNext: TBA") + "\n\n---\n\n" + block(2, "Second.")
  const out = trimSearchOutput(text)
  assert.match(out, /Out 2 September 2025\.\nNext: TBA/)
  assert.match(out, /Title: Result 2/)
  assert.doesNotMatch(out, /omitted/)
})

test("text that is not the expected shape is only hard-capped, never reshaped", () => {
  assert.equal(trimSearchOutput("No results found."), "No results found.")
  const long = "x".repeat(10000)
  const out = trimSearchOutput(long)
  assert.ok(out.startsWith("xxxx") && out.length < 6100 && /truncated/.test(out))
  assert.equal(trimSearchOutput(undefined), undefined)
})

test("the date line survives the cut (the model cites it)", () => {
  const out = trimSearchOutput(block(1, "a ".repeat(2000)))
  assert.match(out, /Published: 2026-09-13/)
  assert.ok(out.includes("…"))
})
