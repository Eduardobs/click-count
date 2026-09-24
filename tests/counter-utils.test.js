import test from "node:test";
import assert from "node:assert/strict";
import {
  compareCounters,
  counterSize,
  formatCounter,
  normalizeCounter,
} from "../counter-utils.js";

test("formats digit groups without using Number", () => {
  assert.equal(formatCounter("123456789012345678901"), "123.456.789.012.345.678.901");
});

test("normalizes valid non-negative integers", () => {
  assert.equal(normalizeCounter(0), "0");
  assert.equal(normalizeCounter(9007199254740993n), "9007199254740993");
  assert.equal(normalizeCounter("9007199254740993"), "9007199254740993");
});

test("rejects malformed API responses", () => {
  for (const value of [
    "",
    "01",
    "-1",
    "1.5",
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
  ]) {
    assert.throws(() => normalizeCounter(value), TypeError);
  }
});

test("selects display sizes by digit count", () => {
  assert.equal(counterSize("123"), "normal");
  assert.equal(counterSize("12345678901"), "long");
  assert.equal(counterSize("1234567890123456789012345"), "very-long");
});

test("compares counters without losing precision", () => {
  assert.equal(compareCounters("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareCounters("999", "1000"), -1);
  assert.equal(compareCounters("42", "42"), 0);
});

test("handles values far beyond PostgreSQL bigint", () => {
  const twoHundredDigits = "9".repeat(200);
  assert.equal(normalizeCounter(twoHundredDigits), twoHundredDigits);
  assert.equal(compareCounters(`1${"0".repeat(200)}`, twoHundredDigits), 1);
  assert.equal(formatCounter(twoHundredDigits).replaceAll(".", ""), twoHundredDigits);
});
