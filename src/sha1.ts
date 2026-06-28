/**
 * @fileoverview Dependency-free synchronous SHA-1.
 *
 * EVALSHA digests must be computed synchronously inside the WASM host callback,
 * and identically in Node and the browser. `node:crypto` is sync but Node-only
 * (and drags a heavy polyfill into browser bundles); Web Crypto is browser-safe
 * but async. A small pure-JS implementation satisfies both — scripts are short,
 * so this is never on a hot path.
 *
 * @module sha1
 */

/** Compute the SHA-1 digest of `bytes` as a 40-character lowercase hex string. */
export function sha1Hex(bytes: Uint8Array): string {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const bitLen = bytes.length * 8;
  // Pad: append 0x80, then zeros to 56 mod 64, then the 64-bit big-endian length.
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  // 64-bit length; bitLen < 2^53 so the high word is derived via division.
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(withPad.length - 4, bitLen >>> 0);

  const w = new Uint32Array(80);
  for (let chunk = 0; chunk < withPad.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(chunk + i * 4);
    }
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (v << 1) | (v >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return (
    hex8(h0) + hex8(h1) + hex8(h2) + hex8(h3) + hex8(h4)
  );
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}
