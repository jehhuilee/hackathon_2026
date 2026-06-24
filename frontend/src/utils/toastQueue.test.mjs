// Unit tests for the toast queue overflow rule (max 3 visible, FIFO).
import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowKeys, MAX_VISIBLE_TOASTS } from "./toastQueue.js";

const t = (key, leaving = false) => ({ key, message: key, level: "info", leaving });

test("within cap returns no overflow", () => {
  assert.deepEqual(overflowKeys([t("a"), t("b"), t("c")]), []);
  assert.deepEqual(overflowKeys([]), []);
});

test("4th active toast pushes out the oldest active one (FIFO)", () => {
  assert.deepEqual(overflowKeys([t("a"), t("b"), t("c"), t("d")]), ["a"]);
});

test("multiple overflow returns oldest-first", () => {
  assert.deepEqual(overflowKeys([t("a"), t("b"), t("c"), t("d"), t("e")]), ["a", "b"]);
});

test("leaving toasts do not count toward the visible cap", () => {
  // 3 active (b,c,d) + 1 leaving (a) => no overflow
  assert.deepEqual(overflowKeys([t("a", true), t("b"), t("c"), t("d")]), []);
});

test("default cap is 3 and is configurable", () => {
  assert.equal(MAX_VISIBLE_TOASTS, 3);
  assert.deepEqual(overflowKeys([t("a"), t("b"), t("c")], 2), ["a"]);
});

test("non-array input is tolerated", () => {
  assert.deepEqual(overflowKeys(null), []);
  assert.deepEqual(overflowKeys(undefined), []);
});
