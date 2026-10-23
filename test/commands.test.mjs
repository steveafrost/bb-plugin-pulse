import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPACT_BYTES, ackedIds, applyPending, dropAcked, enqueue, mirrorPaths, pendingFor, readPending,
} from "../lib/commands.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pulse-cmd-"));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ack = (dir, id) => fs.appendFileSync(mirrorPaths(dir).ack, JSON.stringify({ id }) + "\n");

// ---- The exact wire line --------------------------------------------------

test("a command is exactly the contract's six keys, in order", () => {
  const dir = tmp();
  const at = "2026-10-23T18:20:00.000Z";
  const { command, queued } = enqueue({ op: "done", itemId: "calendar:event:ABC-123" }, { dir, at });
  assert.equal(queued, true);
  assert.deepEqual(Object.keys(command), ["id", "at", "op", "itemId", "until", "reason"]);
  assert.match(command.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(command.at, at);
  assert.equal(command.op, "done");
  assert.equal(command.itemId, "calendar:event:ABC-123");
  assert.equal(command.until, null);
  assert.equal(command.reason, null);

  // The file holds that same object as one line, and nothing else was written.
  const [line] = lines(mirrorPaths(dir).commands);
  assert.deepEqual(line, command);
  assert.equal(fs.readFileSync(mirrorPaths(dir).commands, "utf8").trim().split("\n").length, 1);
});

test("snooze carries an ISO until; the others force until/reason null", () => {
  const dir = tmp();
  const until = "2026-10-24T09:00:00.000Z";
  const { command } = enqueue({ op: "snooze", itemId: "gmail:message:1", until, reason: "later" }, { dir });
  assert.equal(command.op, "snooze");
  assert.equal(command.until, until);
  assert.equal(command.reason, "later");

  const reopen = enqueue({ op: "reopen", itemId: "gmail:message:1", until, reason: "back" }, { dir }).command;
  assert.equal(reopen.until, null, "until only applies to snooze");
  assert.equal(reopen.reason, "back");
});

test("an unknown op or a snooze without until is refused and writes nothing", () => {
  const dir = tmp();
  assert.throws(() => enqueue({ op: "complete", itemId: "x:1" }, { dir }), /unknown op/);
  assert.throws(() => enqueue({ op: "snooze", itemId: "x:1" }, { dir }), /until/);
  assert.throws(() => enqueue({ op: "done", itemId: "" }, { dir }), /itemId/);
  assert.equal(lines(mirrorPaths(dir).commands).length, 0);
});

// ---- De-duplication -------------------------------------------------------

test("the same action is not queued twice while pending", () => {
  const dir = tmp();
  assert.equal(enqueue({ op: "done", itemId: "x:1" }, { dir }).queued, true);
  const again = enqueue({ op: "done", itemId: "x:1" }, { dir });
  assert.equal(again.queued, false);
  assert.equal(again.command, null);
  assert.equal(lines(mirrorPaths(dir).commands).length, 1);

  // A different op on the same item is a different action.
  assert.equal(enqueue({ op: "dismiss", itemId: "x:1" }, { dir }).queued, true);
  // Same op on a different item too.
  assert.equal(enqueue({ op: "done", itemId: "x:2" }, { dir }).queued, true);
});

test("a snooze with a different until is queued, the same one is not", () => {
  const dir = tmp();
  const one = "2026-10-24T09:00:00.000Z";
  const two = "2026-10-25T09:00:00.000Z";
  assert.equal(enqueue({ op: "snooze", itemId: "x:1", until: one }, { dir }).queued, true);
  assert.equal(enqueue({ op: "snooze", itemId: "x:1", until: one }, { dir }).queued, false);
  assert.equal(enqueue({ op: "snooze", itemId: "x:1", until: two }, { dir }).queued, true);
  assert.equal(lines(mirrorPaths(dir).commands).length, 2);
});

// ---- Ack pruning ----------------------------------------------------------

test("an acked id leaves the pending set and is never re-queued", () => {
  const dir = tmp();
  const { command } = enqueue({ op: "done", itemId: "x:1" }, { dir });
  assert.equal(readPending(dir).length, 1);

  ack(dir, command.id);
  assert.ok(ackedIds(dir).has(command.id));
  const result = dropAcked({ dir });
  assert.equal(result.removed, 1);
  assert.equal(result.compacted, true, "every line was acked, so the log compacts");
  assert.deepEqual(readPending(dir), []);
  assert.equal(lines(mirrorPaths(dir).commands).length, 0);
  assert.deepEqual(pendingFor("x:1", { dir }), []);

  // The action can be taken again once the first one is done.
  assert.equal(enqueue({ op: "done", itemId: "x:1" }, { dir }).queued, true);
});

test("dropAcked keeps unacked lines verbatim and only removes acked ones", () => {
  const dir = tmp();
  const a = enqueue({ op: "done", itemId: "x:1" }, { dir, at: "2026-10-23T10:00:00.000Z" }).command;
  const b = enqueue({ op: "dismiss", itemId: "x:2" }, { dir, at: "2026-10-23T10:01:00.000Z" }).command;
  ack(dir, a.id);
  const result = dropAcked({ dir });
  assert.equal(result.removed, 1);
  // Not all acked, and well under the size cap: no compaction, so the acked line
  // stays in the log (iOS tolerates re-reading it) and the unacked one is intact.
  assert.equal(result.compacted, false);
  const kept = lines(mirrorPaths(dir).commands);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept[1], b);
});

test("the log compacts once it exceeds 5 MB", () => {
  const dir = tmp();
  // One real pending line, then pad the file past the cap with acked lines.
  const live = enqueue({ op: "done", itemId: "x:live" }, { dir }).command;
  const filler = "x".repeat(COMPACT_BYTES + 1024);
  const pad = JSON.stringify({ id: "pad-1", padding: filler });
  fs.appendFileSync(mirrorPaths(dir).commands, pad + "\n");
  ack(dir, "pad-1");
  assert.ok(fs.statSync(mirrorPaths(dir).commands).size > COMPACT_BYTES);

  const result = dropAcked({ dir });
  assert.equal(result.compacted, true);
  const kept = lines(mirrorPaths(dir).commands);
  assert.deepEqual(kept, [live]);
  assert.equal(result.removed, 0, "the pending line was never acked");
});

test("acks are removed from the pending file even before a compaction", () => {
  const dir = tmp();
  const { command } = enqueue({ op: "snooze", itemId: "x:1", until: "2026-10-24T09:00:00.000Z" }, { dir });
  ack(dir, command.id);
  // Manually leave the log un-compacted to prove the pending file is independent.
  fs.writeFileSync(mirrorPaths(dir).commands, "");
  assert.deepEqual(readPending(dir), [command]);
  dropAcked({ dir });
  assert.deepEqual(readPending(dir), []);
});

// ---- The optimistic view --------------------------------------------------

test("applyPending overlays the pending transition without touching the item", () => {
  const item = { id: "x:1", status: "open", snoozedUntil: null };
  assert.deepEqual(applyPending(item, []), item);
  assert.equal(item.status, "open", "the input is not mutated");

  assert.deepEqual(applyPending(item, [{ op: "done" }]), { ...item, status: "done", pending: true });
  assert.deepEqual(applyPending(item, [{ op: "dismiss" }]), { ...item, status: "dismissed", pending: true });
  assert.deepEqual(applyPending(item, [{ op: "reopen" }]), { ...item, status: "open", snoozedUntil: null, pending: true });
  assert.deepEqual(
    applyPending(item, [{ op: "snooze", until: "2026-10-24T09:00:00.000Z" }]),
    { ...item, status: "snoozed", snoozedUntil: "2026-10-24T09:00:00.000Z", pending: true },
  );
});

test("pendingFor only returns the item's unacked commands", () => {
  const dir = tmp();
  const done = enqueue({ op: "done", itemId: "x:1" }, { dir }).command;
  enqueue({ op: "dismiss", itemId: "x:2" }, { dir });
  assert.deepEqual(pendingFor("x:1", { dir }).map((c) => c.id), [done.id]);
  ack(dir, done.id);
  assert.deepEqual(pendingFor("x:1", { dir }), []);
});
