import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { sha1Hex } from "../src/sha1.js";

function nodeSha1(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

test("sha1Hex matches node:crypto for known vectors", () => {
  assert.strictEqual(
    sha1Hex(new Uint8Array(0)),
    "da39a3ee5e6b4b0d3255bfef95601890afd80709"
  );
  assert.strictEqual(
    sha1Hex(new TextEncoder().encode("abc")),
    "a9993e364706816aba3e25717850c26c9cd0d89d"
  );
});

test("sha1Hex matches node:crypto across sizes incl. block boundaries", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      data[i] = (i * 31 + 7) & 0xff; // arbitrary non-trivial bytes
    }
    assert.strictEqual(sha1Hex(data), nodeSha1(data), `len ${len}`);
  }
});
