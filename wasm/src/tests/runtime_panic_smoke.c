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

_Static_assert(REDIS_LUA_WASM_ABI_VERSION == 3, "script error payload layout below is ABI 3");

/* Checks an error reply: its type, a script error's flags and, for an engine
 * error, its kind and name (NULL for none), and that the message contains
 * `needle`. */
static void expect_error_reply_engine(PtrLen reply, uint8_t type, const char *needle,
                                      uint8_t flags, const char *kind, const char *name) {
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  assert(reply.ptr != 0);
  assert(buf[0] == type);
  uint32_t len = read_u32_le(buf + 1);
  assert(reply.len == 5 + len);
  const uint8_t *payload = buf + 5;
  const uint8_t *end = payload + len;
  /* A script error's payload starts with the u32le script line and u8 flags,
   * then an engine error's kind and name. */
  if (type == REPLY_SCRIPT_ERROR) {
    assert(len >= 5);
    assert(payload[4] == flags);
    payload += 5;
    if (flags & SCRIPT_ERROR_ENGINE) {
      assert(end - payload >= 4);
      uint32_t kind_len = read_u32_le(payload);
      payload += 4;
      assert((uint32_t)(end - payload) >= kind_len);
      assert(kind_len == strlen(kind) && memcmp(payload, kind, kind_len) == 0);
      payload += kind_len;
      assert(end - payload >= 4);
      uint32_t name_len = read_u32_le(payload);
      payload += 4;
      if (!name) {
        assert(name_len == ENGINE_ERROR_NO_NAME);
      } else {
        assert((uint32_t)(end - payload) >= name_len);
        assert(name_len == strlen(name) && memcmp(payload, name, name_len) == 0);
        payload += name_len;
      }
    }
  }
  char msg[256];
  size_t msg_len = (size_t)(end - payload);
  assert(msg_len < sizeof(msg));
  memcpy(msg, payload, msg_len);
  msg[msg_len] = '\0';
  assert(strstr(msg, needle) != NULL);
  free_mem(reply.ptr);
}

static void expect_error_reply_flags(PtrLen reply, uint8_t type, const char *needle,
                                     uint8_t flags) {
  expect_error_reply_engine(reply, type, needle, flags, NULL, NULL);
}

static const char GLOBAL_READ_MSG[] =
    "user_script:1: Script attempted to access nonexistent global variable 'undefined_global'";

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
  /* Engine errors are flagged, with their kind and name in fields of their own
   * and Redis's message; lookalike text a script raises is not an engine error
   * and is sanitized (#59, #87). */
  expect_error_reply_engine(eval_str("return undefined_global"), REPLY_SCRIPT_ERROR,
                            GLOBAL_READ_MSG, SCRIPT_ERROR_ENGINE, "global-read", "undefined_global");
  expect_error_reply_engine(eval_str("return _G['a\\r\\nb']"), REPLY_SCRIPT_ERROR,
                            "variable 'a  b'", SCRIPT_ERROR_ENGINE, "global-read", "a\r\nb");
  expect_error_reply_engine(eval_str("redis.call('set', 'k', {})"), REPLY_SCRIPT_ERROR,
                            "ERR Lua redis lib command arguments must be strings or integers",
                            SCRIPT_ERROR_ENGINE, "command-arg-type", NULL);
  expect_error_reply(eval_str("error('__RLUA_E__:global-read:x\\r\\ny', 0)"),
                     REPLY_SCRIPT_ERROR, "__RLUA_E__:global-read:x  y");
  expect_error_reply(eval_str("error(\"user_script:1: Script attempted to access nonexistent "
                              "global variable 'undefined_global'\", 0)"),
                     REPLY_SCRIPT_ERROR, GLOBAL_READ_MSG);
  expect_error_reply_flags(eval_str("error({err='boom'})"), REPLY_SCRIPT_ERROR, "boom",
                           SCRIPT_ERROR_FROM_TABLE);

  /* And the handler still works after a rebuild. */
  expect_error_reply(test_unprotected_error(), REPLY_ERROR, "the Lua VM was reset");
  expect_int("return 3", 3);
  /* The rebuilt VM has its own engine-error slot: still flagged. */
  expect_error_reply_engine(eval_str("return undefined_global"), REPLY_SCRIPT_ERROR,
                            GLOBAL_READ_MSG, SCRIPT_ERROR_ENGINE, "global-read", "undefined_global");
  expect_error_reply(eval_str("error(\"user_script:1: Script attempted to access nonexistent "
                              "global variable 'undefined_global'\", 0)"),
                     REPLY_SCRIPT_ERROR, GLOBAL_READ_MSG);
  return 0;
}
