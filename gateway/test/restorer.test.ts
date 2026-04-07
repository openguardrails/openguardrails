/**
 * Tests for the AI Security Gateway restorer module
 *
 * Covers: restore(), restoreJSON(), restoreSSELine(), StreamRestorer
 *
 * Run: tsx test/restorer.test.ts
 */

import {
  restore,
  restoreJSON,
  restoreSSELine,
  createStreamRestorer,
  StreamRestorer,
} from "../src/restorer.js";
import type { MappingTable } from "../src/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function makeMappingTable(entries: [string, string][]): MappingTable {
  return new Map(entries);
}

// ─── restore() ───────────────────────────────────────────────────────────────

section("restore() - basic string replacement");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const result = restore(
    "Contact __PII_EMAIL_ADDRESS_00000001__ for details.",
    mt,
  );
  assertEqual(
    result,
    "Contact alice@example.com for details.",
    "restores single placeholder in string",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
    ["__PII_PHONE_NUMBER_00000001__", "+1-555-0100"],
  ]);
  const result = restore(
    "Email __PII_EMAIL_ADDRESS_00000001__, phone __PII_PHONE_NUMBER_00000001__.",
    mt,
  );
  assertEqual(
    result,
    "Email alice@example.com, phone +1-555-0100.",
    "restores multiple different placeholders",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const result = restore(
    "__PII_EMAIL_ADDRESS_00000001__ and __PII_EMAIL_ADDRESS_00000001__",
    mt,
  );
  assertEqual(
    result,
    "alice@example.com and alice@example.com",
    "restores duplicate placeholders",
  );
}

{
  const mt: MappingTable = new Map();
  const result = restore("No placeholders here.", mt);
  assertEqual(result, "No placeholders here.", "empty mapping table returns input unchanged");
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const result = restore("No placeholders here.", mt);
  assertEqual(result, "No placeholders here.", "mapping table with no matching placeholders");
}

// ─── restore() - recursive structures ────────────────────────────────────────

section("restore() - nested objects and arrays");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const input = {
    role: "assistant",
    content: "Your email is __PII_EMAIL_ADDRESS_00000001__.",
  };
  const result = restore(input, mt) as typeof input;
  assertEqual(
    result.content,
    "Your email is alice@example.com.",
    "restores placeholders in object values",
  );
  assertEqual(result.role, "assistant", "non-placeholder fields unchanged");
}

{
  const mt = makeMappingTable([
    ["__PII_SSN_00000001__", "123-45-6789"],
  ]);
  const input = [
    { role: "user", content: "SSN: __PII_SSN_00000001__" },
    { role: "assistant", content: "Got it, your SSN is __PII_SSN_00000001__." },
  ];
  const result = restore(input, mt) as typeof input;
  assertEqual(
    result[0].content,
    "SSN: 123-45-6789",
    "restores in array element 0",
  );
  assertEqual(
    result[1].content,
    "Got it, your SSN is 123-45-6789.",
    "restores in array element 1",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_API_KEY_00000001__", "sk-secret123456789"],
  ]);
  const input = { a: { b: { c: "key: __PII_API_KEY_00000001__" } } };
  const result = restore(input, mt) as typeof input;
  assertEqual(
    (result as any).a.b.c,
    "key: sk-secret123456789",
    "restores in deeply nested objects",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "a@b.com"],
  ]);
  assertEqual(restore(42, mt), 42, "numbers pass through");
  assertEqual(restore(true, mt), true, "booleans pass through");
  assertEqual(restore(null, mt), null, "null passes through");
}

// ─── restore() - LLM corruption patterns ────────────────────────────────────

section("restore() - LLM corruption tolerance");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  // Missing leading underscores
  const result = restore("PII_EMAIL_ADDRESS_00000001__", mt);
  assertEqual(
    result,
    "alice@example.com",
    "tolerates missing leading underscores",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  // Missing trailing underscores
  const result = restore("__PII_EMAIL_ADDRESS_00000001", mt);
  assertEqual(
    result,
    "alice@example.com",
    "tolerates missing trailing underscores",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  // Case variation
  const result = restore("__pii_email_address_00000001__", mt);
  assertEqual(
    result,
    "alice@example.com",
    "tolerates case variation from LLM",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  // Leaked ID suffix: original value followed by serial ID
  const result = restore("alice@example.com_00000001", mt);
  assertEqual(
    result,
    "alice@example.com",
    "handles leaked ID suffix pattern",
  );
}

// ─── restoreJSON() ───────────────────────────────────────────────────────────

section("restoreJSON()");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const jsonStr = JSON.stringify({
    content: "Email: __PII_EMAIL_ADDRESS_00000001__",
  });
  const result = restoreJSON(jsonStr, mt);
  const parsed = JSON.parse(result);
  assertEqual(
    parsed.content,
    "Email: alice@example.com",
    "restores placeholders in valid JSON string",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  // Invalid JSON — falls back to plain text restoration
  const result = restoreJSON("not valid json __PII_EMAIL_ADDRESS_00000001__", mt);
  assertEqual(
    result,
    "not valid json alice@example.com",
    "falls back to text restoration for invalid JSON",
  );
}

{
  const mt: MappingTable = new Map();
  const jsonStr = '{"key":"value"}';
  const result = restoreJSON(jsonStr, mt);
  assertEqual(result, jsonStr, "empty mapping returns input unchanged");
}

// ─── restoreSSELine() ────────────────────────────────────────────────────────

section("restoreSSELine()");

{
  const mt = makeMappingTable([
    ["__PII_PHONE_NUMBER_00000001__", "+1-555-0199"],
  ]);
  const line = `data: ${JSON.stringify({
    choices: [{ delta: { content: "Call __PII_PHONE_NUMBER_00000001__" } }],
  })}`;
  const result = restoreSSELine(line, mt);
  const parsed = JSON.parse(result.slice(6));
  assertEqual(
    parsed.choices[0].delta.content,
    "Call +1-555-0199",
    "restores placeholder in SSE data line",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "x@y.com"],
  ]);
  const line = "data: [DONE]";
  const result = restoreSSELine(line, mt);
  assertEqual(result, "data: [DONE]", "[DONE] line passes through unchanged");
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "x@y.com"],
  ]);
  const line = "event: message_start";
  const result = restoreSSELine(line, mt);
  assertEqual(result, "event: message_start", "non-data lines pass through");
}

{
  const mt: MappingTable = new Map();
  const line = 'data: {"content":"hello"}';
  assertEqual(restoreSSELine(line, mt), line, "empty mapping returns SSE line unchanged");
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "x@y.com"],
  ]);
  // Invalid JSON after "data: "
  const line = "data: {broken __PII_EMAIL_ADDRESS_00000001__";
  const result = restoreSSELine(line, mt);
  assertEqual(
    result,
    "data: {broken x@y.com",
    "invalid JSON in data line falls back to text restoration",
  );
}

// ─── StreamRestorer ──────────────────────────────────────────────────────────

section("StreamRestorer - basic pass-through");

{
  const mt: MappingTable = new Map();
  const sr = createStreamRestorer(mt);
  const output = sr.process("hello world");
  assertEqual(output, "hello world", "empty mapping passes through directly");
  assertEqual(sr.finalize(), "", "finalize returns empty on no pending");
}

section("StreamRestorer - single chunk restoration");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);
  const output = sr.process("Your email: __PII_EMAIL_ADDRESS_00000001__ ok?");
  assertEqual(
    output,
    "Your email: alice@example.com ok?",
    "restores complete placeholder in one chunk",
  );
  assertEqual(sr.finalize(), "", "nothing pending after full match");
}

section("StreamRestorer - placeholder split across chunks");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  // Simulate placeholder split across many chunks
  output += sr.process("Hello ");
  output += sr.process("__PII_EMAIL");
  output += sr.process("_ADDRESS_0000");
  output += sr.process("0001__ bye");
  output += sr.finalize();

  assertEqual(
    output,
    "Hello alice@example.com bye",
    "restores placeholder split across 4 chunks",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_SSN_00000001__", "123-45-6789"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  // Split right at the __ boundary
  output += sr.process("SSN: _");
  output += sr.process("_PII_SSN_00000001__");
  output += sr.finalize();

  assertEqual(
    output,
    "SSN: 123-45-6789",
    "restores when split exactly at __ boundary",
  );
}

section("StreamRestorer - multiple placeholders");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
    ["__PII_PHONE_NUMBER_00000001__", "+1-555-0100"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  output += sr.process("Email: __PII_EMAIL_ADDRESS_00000001__, ");
  output += sr.process("Phone: __PII_PHONE_NUMBER_00000001__");
  output += sr.finalize();

  assertEqual(
    output,
    "Email: alice@example.com, Phone: +1-555-0100",
    "restores multiple different placeholders in sequence",
  );
}

section("StreamRestorer - double underscores that are NOT placeholders");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  // Python dunder method - not a placeholder
  output += sr.process("Use __init__ to set up the class.");
  output += sr.finalize();

  // Should pass through (not a PII placeholder pattern)
  assert(
    output.includes("__init__"),
    "__init__ dunder passes through (not a placeholder)",
  );
}

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  // Markdown bold with double underscores
  output += sr.process("This is __bold text__ in markdown.");
  output += sr.finalize();

  assert(
    output.includes("__bold text__"),
    "markdown bold __ passes through (not a placeholder)",
  );
}

section("StreamRestorer - hasPendingData");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  assert(!sr.hasPendingData(), "no pending data initially");

  sr.process("hello __PII");
  assert(sr.hasPendingData(), "pending data while buffering partial placeholder");

  sr.process("_EMAIL_ADDRESS_00000001__ done");
  // After processing the rest, buffer should be empty or minimal
  const final = sr.finalize();
  assert(!sr.hasPendingData(), "no pending data after finalize");
}

section("StreamRestorer - character-by-character streaming");

{
  const mt = makeMappingTable([
    ["__PII_SSN_00000001__", "123-45-6789"],
  ]);
  const sr = createStreamRestorer(mt);

  const input = "SSN: __PII_SSN_00000001__ end";
  let output = "";
  for (const ch of input) {
    output += sr.process(ch);
  }
  output += sr.finalize();

  assertEqual(
    output,
    "SSN: 123-45-6789 end",
    "restores correctly with character-by-character input",
  );
}

section("StreamRestorer - no placeholder text with underscores");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  output += sr.process("some_variable_name = 42");
  output += sr.finalize();

  assertEqual(
    output,
    "some_variable_name = 42",
    "single underscores in identifiers pass through",
  );
}

section("StreamRestorer - long non-placeholder __ prefix");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  // A string starting with __ but way too long to be a placeholder
  // StreamRestorer should flush it after MAX_PLACEHOLDER_LENGTH
  const longStr = "__" + "X".repeat(60) + " done";
  let output = "";
  output += sr.process(longStr);
  output += sr.finalize();

  assert(
    output.includes("done"),
    "long non-placeholder __ prefix gets flushed",
  );
  assert(
    output.startsWith("__"),
    "non-placeholder __ prefix is preserved",
  );
}

section("StreamRestorer - empty chunks");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  output += sr.process("");
  output += sr.process("__PII_EMAIL_ADDRESS_00000001__");
  output += sr.process("");
  output += sr.finalize();

  assertEqual(
    output,
    "alice@example.com",
    "empty chunks don't break restoration",
  );
}

section("StreamRestorer - placeholder at very end of stream");

{
  const mt = makeMappingTable([
    ["__PII_CREDIT_CARD_00000001__", "4111-1111-1111-1111"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  output += sr.process("Card: __PII_CREDIT_CARD_00000001__");
  output += sr.finalize();

  assertEqual(
    output,
    "Card: 4111-1111-1111-1111",
    "placeholder at end of stream is restored via finalize",
  );
}

section("StreamRestorer - incomplete placeholder at end of stream");

{
  const mt = makeMappingTable([
    ["__PII_EMAIL_ADDRESS_00000001__", "alice@example.com"],
  ]);
  const sr = createStreamRestorer(mt);

  let output = "";
  output += sr.process("Trailing __PII_EMAIL");
  // Stream ends without completing the placeholder
  output += sr.finalize();

  // Should output the partial text as-is (finalize flushes buffer)
  assert(
    output.includes("__PII_EMAIL") || output.includes("PII_EMAIL"),
    "incomplete placeholder is flushed as text on finalize",
  );
}

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nSome tests failed!");
  process.exit(1);
} else {
  console.log("\nAll tests passed! ✓");
}
