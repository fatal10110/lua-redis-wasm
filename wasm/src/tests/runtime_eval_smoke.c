#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

static uint32_t read_u32_le(const uint8_t *src) {
  return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) |
         ((uint32_t)src[3] << 24);
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

static int64_t read_i64_le(const uint8_t *src) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) {
    v = (v << 8) | src[i];
  }
  return (int64_t)v;
}

static void expect_int(const char *script, int64_t expected) {
  PtrLen reply = eval_str(script);
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  assert(reply.len == 13);
  assert(buf[0] == REPLY_INT);
  assert(read_u32_le(buf + 1) == 8);
  assert(read_i64_le(buf + 5) == expected);
  free_mem(reply.ptr);
}

static void expect_null(const char *script) {
  PtrLen reply = eval_str(script);
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  assert(reply.len == 5);
  assert(buf[0] == REPLY_NULL);
  assert(read_u32_le(buf + 1) == 0);
  free_mem(reply.ptr);
}

/* The error payload must be exactly the message: no trailing NUL terminator. */
static void expect_error(const char *script, const char *message) {
  PtrLen reply = eval_str(script);
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  uint32_t len = (uint32_t)strlen(message);
  assert(buf[0] == REPLY_ERROR);
  assert(read_u32_le(buf + 1) == len);
  assert(reply.len == 5 + len);
  assert(memcmp(buf + 5, message, len) == 0);
  free_mem(reply.ptr);
}

int main(void) {
  assert(init() == 0);

  expect_int("return 42", 42);

  /* Only the first value of a multi-value return is kept, like Redis. */
  expect_int("return 1, 2", 1);
  expect_int("return 7, 'x', {}", 7);
  expect_null("return nil, 2");

  /* No return value replies with nil. */
  expect_null("return");
  expect_null("local a = 1");

  expect_error("return function() end", "ERR unsupported Lua return type");

  set_limits(0, 8, 0);
  expect_error("return 'this reply is too long'", "ERR reply exceeds configured limit");
  set_limits(0, 0, 0);

  return 0;
}
