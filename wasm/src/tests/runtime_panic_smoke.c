/* A Lua error outside any protected call reaches the panic handler, which must
 * turn it into an error reply and rebuild the VM instead of exiting. */
#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

/* Test-only export, compiled with -DLUA_REDIS_WASM_TESTING. */
PtrLen test_unprotected_error(void);

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

_Static_assert(REDIS_LUA_WASM_ABI_VERSION == 2, "script error payload layout below is ABI 2");

static void expect_error_reply_flags(PtrLen reply, uint8_t type, const char *needle,
                                     uint8_t flags) {
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  assert(reply.ptr != 0);
  assert(buf[0] == type);
  uint32_t len = read_u32_le(buf + 1);
  assert(reply.len == 5 + len);
  /* A script error's payload starts with the u32le script line and u8 flags. */
  uint32_t skip = type == REPLY_SCRIPT_ERROR ? 5 : 0;
  assert(len >= skip);
  if (type == REPLY_SCRIPT_ERROR) {
    assert(buf[5 + 4] == flags);
  }
  char msg[256];
  assert(len - skip < sizeof(msg));
  memcpy(msg, buf + 5 + skip, len - skip);
  msg[len - skip] = '\0';
  assert(strstr(msg, needle) != NULL);
  free_mem(reply.ptr);
}

static void expect_error_reply(PtrLen reply, uint8_t type, const char *needle) {
  expect_error_reply_flags(reply, type, needle, 0);
}

int main(void) {
  assert(init() == 0);
  expect_int("return 1", 1);

  expect_error_reply(test_unprotected_error(), REPLY_ERROR,
                     "ERR unprotected Lua error (injected  error); the Lua VM was reset");

  /* The rebuilt VM runs scripts and is sandboxed as before. */
  expect_int("return 2", 2);
  expect_int("return cjson.decode('[7]')[1]", 7);
  expect_error_reply(eval_str("x = 1"), REPLY_SCRIPT_ERROR, "Attempt to modify a readonly table");
  /* Engine errors are flagged and sent without the marker prefix; lookalike
   * text a script raises is not an engine error and is sanitized (#59). */
  expect_error_reply_flags(eval_str("return undefined_global"), REPLY_SCRIPT_ERROR,
                           "global-read:undefined_global", SCRIPT_ERROR_ENGINE);
  expect_error_reply(eval_str("error('__RLUA_E__:global-read:x\\r\\ny', 0)"),
                     REPLY_SCRIPT_ERROR, "__RLUA_E__:global-read:x  y");
  expect_error_reply_flags(eval_str("error({err='boom'})"), REPLY_SCRIPT_ERROR, "boom",
                           SCRIPT_ERROR_FROM_TABLE);

  /* And the handler still works after a rebuild. */
  expect_error_reply(test_unprotected_error(), REPLY_ERROR, "the Lua VM was reset");
  expect_int("return 3", 3);
  return 0;
}
