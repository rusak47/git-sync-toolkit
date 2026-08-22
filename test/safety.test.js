import test from "node:test";
import assert from "node:assert/strict";
import { assertPushRemote, assertValidatedState } from "../lib.js";

test("push guard rejects upstream", () => {
  assert.throws(() => assertPushRemote("upstream"), /forbidden/);
  assert.equal(assertPushRemote("origin"), "origin");
});

test("validated publish state rejects remote and local drift", () => {
  const state = { remote: "origin", branch: "master", expectedRemote: "abc", validatedHead: "def" };
  assert.doesNotThrow(() => assertValidatedState(state, state));
  assert.throws(
    () => assertValidatedState(state, { ...state, expectedRemote: "changed" }),
    /Remote changed/,
  );
  assert.throws(
    () => assertValidatedState(state, { ...state, validatedHead: "changed" }),
    /Local HEAD changed/,
  );
});
