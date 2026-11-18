import test from "node:test";
import assert from "node:assert/strict";
import { checkpoint } from "../mods/orca-projects/recovery.js";

test("only a foreground Codex client arms its pane, and returning to the same shell clears it", () => {
  const row = { root: 123, codexPid: 456 };
  assert.equal(checkpoint(row, ""), "123/456");
  assert.equal(checkpoint(row, "123/456"), null);
  assert.equal(checkpoint({ root: 123 }, "123/456"), "");
  // A replacement shell must get a chance to consume its previous checkpoint.
  assert.equal(checkpoint({ root: 789 }, "123/456"), null);
  assert.equal(checkpoint({ root: 789 }, ""), null);
});
