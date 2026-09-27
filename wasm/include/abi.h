#ifndef REDIS_LUA_WASM_ABI_H
#define REDIS_LUA_WASM_ABI_H

#include <stdint.h>

#define REDIS_LUA_WASM_ABI_VERSION 2

#ifdef __cplusplus
extern "C" {
#endif

typedef enum ReplyType {
  REPLY_NULL = 0x00,
  REPLY_INT = 0x01,
  REPLY_BULK = 0x02,
  REPLY_ARRAY = 0x03,
  REPLY_STATUS = 0x04,
  REPLY_ERROR = 0x05,
  /* Error that aborted the script (uncaught runtime error or an error that
   * propagated out of redis.call). The host decorates these with the script
   * sha / source context; plain REPLY_ERROR values returned by the script
   * (e.g. `return redis.pcall(...)`) are left undecorated. */
  REPLY_SCRIPT_ERROR = 0x06,
  REPLY_BOOL = 0x07,
  REPLY_DOUBLE = 0x08,
  REPLY_MAP = 0x09,
  REPLY_SET = 0x0a,
  REPLY_BIG_NUMBER = 0x0b,
  REPLY_VERBATIM = 0x0c
} ReplyType;

/* REPLY_SCRIPT_ERROR payload: u32le `line`, u8 `flags`, then the message.
 * `line` is the script line at the error point (0 = unknown, parse it from the
 * message's "user_script:N:" prefix). `flags` tells the host how to read the
 * message; it is set by the engine, never inferred from the message text. */
/* Engine-originated error (globals protection, a bad redis.call argument): the
 * message is "<kind>" or "<kind>:<name>", unsanitized. */
#define SCRIPT_ERROR_ENGINE 0x01u
/* The message is the `err` field of an error table, which Redis 7 sends as-is
 * ("-<err>"): its leading word is the error code only if it has one, and no
 * default code is added. Set only in the Redis 7 error model (COMPAT_TABLE_ERRORS);
 * Redis 6.2 replies "-ERR ..." for every script error. Otherwise the error was
 * a string (or another value), or the model is 6.2's: Redis sends it as
 * "-ERR <message>", so the host reports code ERR and the whole message, less
 * one leading "ERR " (the engine's own string errors carry it). */
#define SCRIPT_ERROR_FROM_TABLE 0x02u

#if defined(__GNUC__)
typedef struct __attribute__((packed)) ReplyHeader {
  uint8_t type;
  uint32_t count_or_len;
} ReplyHeader;
#else
#pragma pack(push, 1)
typedef struct ReplyHeader {
  uint8_t type;
  uint32_t count_or_len;
} ReplyHeader;
#pragma pack(pop)
#endif

typedef struct PtrLen {
  uint32_t ptr;
  uint32_t len;
} PtrLen;

/* Host imports.
 *
 * Supplied by the JS loader at instantiation time (merged into the `env`
 * import namespace), so they are declared as explicit `env` wasm imports.
 * Emscripten additionally needs them listed in a JS library
 * (wasm/src/library_host.js) to accept them as JS-provided; together this
 * lets the build keep undefined-symbol errors enabled, so any other
 * unresolved symbol is still a link error. A C definition (e.g. the
 * smoke-test stubs) takes precedence over the import when linked in. */
#if defined(__wasm__)
#define HOST_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#else
#define HOST_IMPORT(name)
#endif

HOST_IMPORT(host_redis_call) PtrLen host_redis_call(uint32_t ptr, uint32_t len);
HOST_IMPORT(host_redis_pcall) PtrLen host_redis_pcall(uint32_t ptr, uint32_t len);
/* host_redis_log and host_redis_setresp return {0,0} when the host callback
 * succeeded. When it failed, len != 0 and ptr is a malloc'd error message (or
 * 0 if the host could not allocate one); the caller frees it and raises it as
 * a Lua error, so a host exception never unwinds through WASM frames. */
HOST_IMPORT(host_redis_log) PtrLen host_redis_log(uint32_t level, uint32_t ptr, uint32_t len);
HOST_IMPORT(host_redis_setresp) PtrLen host_redis_setresp(uint32_t version);
HOST_IMPORT(host_sha1hex) PtrLen host_sha1hex(uint32_t ptr, uint32_t len);
HOST_IMPORT(host_redis_props) PtrLen host_redis_props(void);

/* WASM exports */
int32_t init(void);
int32_t reset(void);
int32_t close_vm(void);
PtrLen eval(uint32_t ptr, uint32_t len);
PtrLen eval_with_args(uint32_t script_ptr, uint32_t script_len, uint32_t args_ptr,
                      uint32_t args_len, uint32_t keys_count);
void set_limits(uint32_t max_fuel, uint32_t max_reply_bytes, uint32_t max_arg_bytes);
void set_compat(uint32_t flags);
uint32_t current_call_source(void);
int32_t current_call_line(void);
uint32_t alloc(uint32_t size);
void free_mem(uint32_t ptr);

#ifdef __cplusplus
}
#endif

#endif /* REDIS_LUA_WASM_ABI_H */
