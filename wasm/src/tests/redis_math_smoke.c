/* math.random / math.randomseed use Redis's PRNG (vendor/valkey/src/rand.c).
 *
 * The expected values were read from real servers (x86-64 Docker images):
 * redis 7.0 / 7.4 / 8.0 and valkey 8.0 / 9.0 all start a fresh process with
 * 396465, 840486, ... for math.random(1,1000000) and continue the sequence
 * across scripts; redis 6.2 reseeds with 0 before every script, so every
 * script's first math.random(1,1000000) is 170829. */
#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

#define COMPAT_OS 0x2u
#define COMPAT_RESEED_RANDOM 0x8u

static uint32_t read_u32_le(const uint8_t *src) {
  return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) |
         ((uint32_t)src[3] << 24);
}

static int64_t read_i64_le(const uint8_t *src) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) {
    v = (v << 8) | src[i];
  }
  return (int64_t)v;
}

static PtrLen eval_str(const char *script) {
  uint32_t len = (uint32_t)strlen(script);
  uint32_t ptr = alloc(len);
  memcpy((void *)(uintptr_t)ptr, script, len);
  PtrLen reply = eval(ptr, len);
  free_mem(ptr);
  assert(reply.ptr != 0);
  assert(reply.len >= 5);
  return reply;
}

static void expect_int(const char *script, int64_t expected) {
  PtrLen reply = eval_str(script);
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  assert(reply.len == 13);
  assert(buf[0] == REPLY_INT);
  assert(read_i64_le(buf + 5) == expected);
  free_mem(reply.ptr);
}

static void expect_bulk(const char *script, const char *expected) {
  PtrLen reply = eval_str(script);
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  uint32_t len = (uint32_t)strlen(expected);
  assert(buf[0] == REPLY_BULK);
  assert(read_u32_le(buf + 1) == len);
  assert(memcmp(buf + 5, expected, len) == 0);
  free_mem(reply.ptr);
}

int main(void) {
  /* Default profile (Redis 7.0+ / Valkey): no reseed between scripts. */
  assert(init() == 0);
  expect_int("return math.random(1,1000000)", 396465);
  expect_int("return math.random(1,1000000)", 840486);
  expect_bulk("return tostring(math.random())", "0.35333609737146");
  /* A seed set by one script carries over to the next. */
  expect_int("math.randomseed(10); return math.random(1,1000000)", 878852);
  expect_int("return math.random(1,1000000)", 795807);
  expect_bulk("return tostring(math.random())", "0.48082728100979");

  /* Lua 5.1's argument handling, unchanged. */
  expect_bulk("local ok, e = pcall(math.random, 1, 2, 3) return e", "wrong number of arguments");
  expect_bulk("local ok, e = pcall(math.random, 3, 1) return e",
              "bad argument #2 to '?' (interval is empty)");
  expect_bulk("local ok, e = pcall(math.randomseed) return e",
              "bad argument #1 to '?' (number expected, got no value)");
  expect_int("local r = math.random(5) return (r >= 1 and r <= 5) and 1 or 0", 1);

  /* Redis 6.2 profile: reseeded with 0 before every script. */
  set_compat(COMPAT_OS | COMPAT_RESEED_RANDOM);
  assert(reset() == 0);
  expect_int("return math.random(1,1000000)", 170829);
  expect_int("return math.random(1,1000000)", 170829);
  expect_bulk("return tostring(math.random())", "0.17082803611217");
  expect_int("math.randomseed(10); return math.random(1,1000000)", 878852);
  expect_int("return math.random(1,1000000)", 170829);
  return 0;
}
