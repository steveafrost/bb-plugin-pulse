import { test } from "node:test";
import assert from "node:assert/strict";
import { threadGone } from "../lib/thread-gone.ts";

test("a deleted, archived or unknown thread is gone", () => {
  assert.equal(threadGone(new Error("HTTP 404: Thread not found")), true);
  assert.equal(threadGone(new Error("HTTP 409: Thread is archived")), true);
  assert.equal(threadGone("thread not found"), true);
});

test("transient failures are not", () => {
  assert.equal(threadGone(new Error("HTTP 500: Internal error")), false);
  assert.equal(threadGone(new Error("fetch failed")), false);
  assert.equal(threadGone(undefined), false);
});
