/* Lua VM setup, sandboxing and script execution for lua-redis-wasm.
 *
 * Portions derived from Valkey / Redis 7.2.4 (BSD-3-Clause, see
 * THIRD_PARTY_NOTICES.md), mainly Valkey 8.0's src/script_lua.c and src/eval.c:
 * the globals allow/deny lists and table protection, the error handler, and the
 * Lua -> RESP reply conversion. */
#include "../include/abi.h"
#include "redis_api.h"
#include "redis_math.h"
#include <lauxlib.h>
#include <lstate.h> /* lua_State internals: errfunc, see fuel_hook */
#include <lua.h>
#include <lualib.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_FUEL_LIMIT 10000000
#define FUEL_HOOK_STEP 1000

/* Why a ReplyBuffer write failed (ReplyBuffer.status). */
#define RB_OK 0
#define RB_NO_MEMORY 1  /* the heap could not grow the buffer */
#define RB_OVER_LIMIT 2 /* the write would take the reply past `limit` */

typedef struct ReplyBuffer {
  uint8_t *data;
  size_t len;
  size_t cap;
  /* Maximum size of the encoded reply in bytes, 0 for none. Enforced on every
   * write, so an oversized reply fails as soon as it crosses the limit instead
   * of being built in full first. */
  size_t limit;
  int status;
} ReplyBuffer;

static lua_State *g_state = NULL;
static int64_t g_fuel_remaining = DEFAULT_FUEL_LIMIT;
static int64_t g_fuel_limit = DEFAULT_FUEL_LIMIT;
static uint32_t g_max_reply_bytes = 0;
static uint32_t g_max_arg_bytes = 0;
/* Script line captured by script_error_handler at the last error point. */
static uint32_t g_error_line = 0;
/* Set by script_error_handler when the error object was a table, so its
 * message is that table's `err` field (see SCRIPT_ERROR_FROM_TABLE). */
static int g_error_from_table = 0;

/* Registry references to the C functions the eval path calls in protected
 * mode. Pushing a C function creates a closure, which allocates and so can
 * raise a memory error; outside any protected call that error would reach the
 * panic handler. These closures are created once per VM, inside the protected
 * setup_state_body, so the eval path only fetches them (lua_rawgeti does not
 * allocate) before lua_pcall. */
static int g_error_handler_ref = LUA_NOREF;
static int g_encode_reply_ref = LUA_NOREF;
static int g_collect_garbage_ref = LUA_NOREF;
/* Registry slot holding the message of the last engine-originated error raised
 * in the current eval (see redis_mark_engine_error), or false. Created once per
 * VM so marking an error overwrites an existing slot and never allocates. */
static int g_engine_error_ref = LUA_NOREF;

static void write_u32_le(uint8_t *dst, uint32_t value) {
  dst[0] = (uint8_t)(value & 0xFF);
  dst[1] = (uint8_t)((value >> 8) & 0xFF);
  dst[2] = (uint8_t)((value >> 16) & 0xFF);
  dst[3] = (uint8_t)((value >> 24) & 0xFF);
}

static void write_i64_le(uint8_t *dst, int64_t value) {
  uint64_t uvalue = (uint64_t)value;
  dst[0] = (uint8_t)(uvalue & 0xFF);
  dst[1] = (uint8_t)((uvalue >> 8) & 0xFF);
  dst[2] = (uint8_t)((uvalue >> 16) & 0xFF);
  dst[3] = (uint8_t)((uvalue >> 24) & 0xFF);
  dst[4] = (uint8_t)((uvalue >> 32) & 0xFF);
  dst[5] = (uint8_t)((uvalue >> 40) & 0xFF);
  dst[6] = (uint8_t)((uvalue >> 48) & 0xFF);
  dst[7] = (uint8_t)((uvalue >> 56) & 0xFF);
}

static void write_f64_le(uint8_t *dst, double value) {
  memcpy(dst, &value, sizeof(value)); /* wasm is little-endian */
}

static void rb_init(ReplyBuffer *rb) {
  rb->data = NULL;
  rb->len = 0;
  rb->cap = 0;
  rb->limit = 0;
  rb->status = RB_OK;
}

// Makes room for `extra` more bytes. Fails (-1, reason in rb->status) when the
// heap is exhausted or when the reply would exceed rb->limit; the capacity
// never grows past the limit.
static int rb_reserve(ReplyBuffer *rb, size_t extra) {
  if (extra > SIZE_MAX - rb->len) {
    rb->status = RB_NO_MEMORY;
    return -1;
  }
  size_t needed = rb->len + extra;
  if (rb->limit > 0 && needed > rb->limit) {
    rb->status = RB_OVER_LIMIT;
    return -1;
  }
  if (needed <= rb->cap) {
    return 0;
  }
  size_t new_cap = rb->cap == 0 ? 256 : rb->cap;
  while (new_cap < needed) {
    new_cap = new_cap > SIZE_MAX / 2 ? needed : new_cap * 2;
  }
  if (rb->limit > 0 && new_cap > rb->limit) {
    new_cap = rb->limit;
  }
  uint8_t *next = (uint8_t *)realloc(rb->data, new_cap);
  if (!next) {
    rb->status = RB_NO_MEMORY;
    return -1;
  }
  rb->data = next;
  rb->cap = new_cap;
  return 0;
}

static int rb_append(ReplyBuffer *rb, const void *data, size_t len) {
  if (rb_reserve(rb, len) != 0) {
    return -1;
  }
  memcpy(rb->data + rb->len, data, len);
  rb->len += len;
  return 0;
}

static int rb_write_header(ReplyBuffer *rb, uint8_t type, uint32_t count_or_len) {
  uint8_t header[5];
  header[0] = type;
  write_u32_le(header + 1, count_or_len);
  return rb_append(rb, header, sizeof(header));
}

// Hands the encoded reply to the caller (released with free_mem) and leaves rb
// empty. The buffer itself is handed over rather than copied, so a large reply
// never needs twice its size on the fixed heap; spare capacity is given back
// with a shrinking realloc. With nothing encoded, any buffer is freed and
// {0, 0} is returned.
static PtrLen rb_finalize(ReplyBuffer *rb) {
  PtrLen out = {0, 0};
  uint8_t *mem = rb->data;
  size_t len = rb->len;
  size_t cap = rb->cap;
  rb_init(rb);
  if (!mem || len == 0) {
    free(mem);
    return out;
  }
  if (len < cap) {
    uint8_t *shrunk = (uint8_t *)realloc(mem, len);
    if (shrunk) {
      mem = shrunk;
    }
  }
  out.ptr = (uint32_t)(uintptr_t)mem;
  out.len = (uint32_t)len;
  return out;
}

// Appends a reply string, mapping "\r\n" to spaces like Redis so the value can
// never break RESP framing.
static int rb_append_single_line(ReplyBuffer *rb, const char *str, size_t len) {
  size_t start = rb->len;
  if (rb_append(rb, str, len) != 0) {
    return -1;
  }
  for (size_t i = start; i < rb->len; i++) {
    if (rb->data[i] == '\r' || rb->data[i] == '\n') {
      rb->data[i] = ' ';
    }
  }
  return 0;
}

static int rb_write_single_line(ReplyBuffer *rb, uint8_t type, const char *str, size_t len) {
  if (rb_write_header(rb, type, (uint32_t)len) != 0) {
    return -1;
  }
  return rb_append_single_line(rb, str, len);
}

// Length of an error message as Redis sends it: read as a C string (cut at the
// first NUL), trailing "\r\n" trimmed (addReplyErrorFormatEx's sdstrim).
static size_t error_len(const char *msg) {
  size_t len = strlen(msg);
  while (len > 0 && (msg[len - 1] == '\r' || msg[len - 1] == '\n')) {
    len--;
  }
  return len;
}

/* Prefix of the messages redis_mark_engine_error is used for, as scripts see
 * them (e.g. through pcall). reply_script_error strips it. */
#define ENGINE_ERROR_PREFIX "__RLUA_E__:"

static PtrLen reply_error(const char *msg, size_t len) {
  ReplyBuffer rb;
  rb_init(&rb);
  if (rb_write_header(&rb, REPLY_ERROR, (uint32_t)len) != 0) {
    return (PtrLen){0, 0};
  }
  if (rb_append(&rb, msg, len) != 0) {
    free(rb.data);
    return (PtrLen){0, 0};
  }
  return rb_finalize(&rb);
}

// reply_error for a string literal; the length excludes the NUL terminator.
#define REPLY_ERROR_LIT(lit) reply_error((lit), sizeof(lit) - 1)

/* Like reply_error, but tags the reply as a script-aborting error so the host
 * decorates it with the script sha / source context. Used for load and runtime
 * (lua_pcall) failures, including errors that propagated out of redis.call.
 *
 * The payload is prefixed with a u32le `line` (the script line at the error
 * point, or 0 if unknown) and a u8 `flags` (SCRIPT_ERROR_*, see abi.h).
 * Command errors propagated out of redis.call carry no `user_script:N:` text
 * prefix, so the line cannot be recovered from the message alone; the host
 * reads it from this field. 0 means "parse from the message prefix"
 * (load/syntax errors, which never run the error handler). */
static PtrLen reply_script_error(const char *msg, uint32_t line, uint8_t flags) {
  // Goes beyond Redis, which sends these raw (addReplyErrorSdsEx): sanitized
  // like a returned {err=} so a host can put it straight into RESP. Engine
  // errors are left intact: their name is structured data, and the host
  // replaces the message text anyway. Only the flag, which the engine sets
  // when it raised the error itself, selects that: the text is not trusted,
  // since scripts and host command errors control it (#59).
  int engine = (flags & SCRIPT_ERROR_ENGINE) != 0;
  if (engine && strncmp(msg, ENGINE_ERROR_PREFIX, sizeof(ENGINE_ERROR_PREFIX) - 1) == 0) {
    msg += sizeof(ENGINE_ERROR_PREFIX) - 1;
  }
  size_t len = engine ? strlen(msg) : error_len(msg);
  ReplyBuffer rb;
  rb_init(&rb);
  if (rb_write_header(&rb, REPLY_SCRIPT_ERROR, (uint32_t)(len + 5)) != 0) {
    return (PtrLen){0, 0};
  }
  uint8_t prefix[5];
  write_u32_le(prefix, line);
  prefix[4] = flags;
  if (rb_append(&rb, prefix, sizeof(prefix)) != 0) {
    free(rb.data);
    return (PtrLen){0, 0};
  }
  int rc = engine ? rb_append(&rb, msg, len) : rb_append_single_line(&rb, msg, len);
  if (rc != 0) {
    free(rb.data);
    return (PtrLen){0, 0};
  }
  return rb_finalize(&rb);
}

/* lua_pcall message handler, run at the error point before the stack unwinds.
 * Mirrors Redis's `__redis__err__handler` (src/eval.c): it records the script
 * line where the error occurred, skipping C frames (e.g. the redis.call binding)
 * so the reported line is the script's call site, not the C boundary.
 *
 * It also turns the error object into the message run_script replies with, in
 * protected mode (a conversion may allocate):
 * - a table is a Redis 7 error object ({err=...}, as raised by redis.call or
 *   error(redis.error_reply(...))): its `err` field, like
 *   luaExtractErrorInformation, or "ERR unknown error" when that is not a
 *   string (that fallback is derived from luaExtractErrorInformation in
 *   Valkey 8.0's src/script_lua.c, valkey-io/valkey#2229, BSD-3-Clause). Its
 *   `source`/`line` fields are not read: Redis's handler overwrites both with
 *   the error point, which is the line recorded here (#37);
 * - a number becomes its string form;
 * - anything else becomes what Lua's tostring gives ("nil", "true", ...), which
 *   Redis's handler turns into "ERR <tostring(err)>" (the host adds the code).
 * A table's message is flagged (g_error_from_table, SCRIPT_ERROR_FROM_TABLE):
 * Redis replies "-<err>" for it as-is, with no ERR code added (luaCallFunction
 * in Valkey 8.0's src/script_lua.c, same in Redis 7.2.4) (#76). */
static int script_error_handler(lua_State *L) {
  lua_Debug ar;
  g_error_line = 0;
  g_error_from_table = 0;
  for (int level = 1; lua_getstack(L, level, &ar); level++) {
    if (lua_getinfo(L, "Sl", &ar) && ar.currentline > 0) {
      g_error_line = (uint32_t)ar.currentline;
      break;
    }
  }
  switch (lua_type(L, 1)) {
    case LUA_TSTRING:
      break;
    case LUA_TNUMBER:
      lua_tostring(L, 1); /* converts in place */
      break;
    case LUA_TTABLE:
      lua_getfield(L, 1, "err");
      if (!lua_isstring(L, -1)) {
        lua_pushliteral(L, "ERR unknown error");
      }
      lua_tostring(L, -1); /* a numeric err converts in place */
      g_error_from_table = 1;
      break;
    case LUA_TNIL:
      lua_pushliteral(L, "nil");
      break;
    case LUA_TBOOLEAN:
      lua_pushstring(L, lua_toboolean(L, 1) ? "true" : "false");
      break;
    default:
      lua_pushfstring(L, "%s: %p", luaL_typename(L, 1), lua_topointer(L, 1));
      break;
  }
  return 1;
}

/* Encoder failure codes. ENCODE_STACK_LIMIT is turned into a
 * "reached lua stack limit" error reply by encode_lua_value. */
#define ENCODE_FAILED -1
#define ENCODE_STACK_LIMIT -2

static int encode_value(lua_State *L, int idx, ReplyBuffer *rb, int depth);

static size_t table_pair_count(lua_State *L, int idx) {
  size_t count = 0;
  lua_pushnil(L);
  while (lua_next(L, idx) != 0) {
    count++;
    lua_pop(L, 1);
  }
  return count;
}

static int encode_map(lua_State *L, int idx, ReplyBuffer *rb, int depth) {
  size_t count = table_pair_count(L, idx);
  if (rb_write_header(rb, REPLY_MAP, (uint32_t)count) != 0) {
    return ENCODE_FAILED;
  }
  lua_pushnil(L);
  while (lua_next(L, idx) != 0) {
    int rc = encode_value(L, -2, rb, depth + 1);
    if (rc == 0) {
      rc = encode_value(L, -1, rb, depth + 1);
    }
    if (rc != 0) {
      lua_pop(L, 2);
      return rc;
    }
    lua_pop(L, 1);
  }
  return 0;
}

static int encode_set(lua_State *L, int idx, ReplyBuffer *rb, int depth) {
  size_t count = table_pair_count(L, idx);
  if (rb_write_header(rb, REPLY_SET, (uint32_t)count) != 0) {
    return ENCODE_FAILED;
  }
  lua_pushnil(L);
  while (lua_next(L, idx) != 0) {
    int rc = encode_value(L, -2, rb, depth + 1);
    if (rc != 0) {
      lua_pop(L, 2);
      return rc;
    }
    lua_pop(L, 1);
  }
  return 0;
}

// Typed reply tables: {double=}, {big_number=}, {verbatim_string=}, {map=},
// {set=}. Mirrors luaReplyToRedisReply in Redis: raw lookups (no __index) and
// exact type checks (no string<->number coercion).
static int rawget_field(lua_State *L, int idx, const char *key) {
  if (idx < 0) {
    idx = lua_gettop(L) + idx + 1;
  }
  lua_pushstring(L, key);
  lua_rawget(L, idx);
  return lua_type(L, -1);
}

static int encode_typed_table(lua_State *L, int idx, ReplyBuffer *rb, int depth) {
  if (rawget_field(L, idx, "double") == LUA_TNUMBER) {
    double value = (double)lua_tonumber(L, -1);
    uint8_t payload[8];
    write_f64_le(payload, value);
    lua_pop(L, 1);
    if (rb_write_header(rb, REPLY_DOUBLE, sizeof(payload)) != 0) {
      return -1;
    }
    return rb_append(rb, payload, sizeof(payload));
  }
  lua_pop(L, 1);

  if (rawget_field(L, idx, "big_number") == LUA_TSTRING) {
    size_t len = 0;
    const char *str = lua_tolstring(L, -1, &len);
    lua_pop(L, 1);
    return rb_write_single_line(rb, REPLY_BIG_NUMBER, str, len);
  }
  lua_pop(L, 1);

  if (rawget_field(L, idx, "verbatim_string") == LUA_TTABLE) {
    int vt = lua_gettop(L);
    if (rawget_field(L, vt, "format") == LUA_TSTRING &&
        rawget_field(L, vt, "string") == LUA_TSTRING) {
      // Redis addReplyVerbatim writes exactly 3 format bytes: the format is read
      // as a C string, truncated to 3 and padded with spaces.
      const char *ext = lua_tostring(L, -2);
      char format[3];
      for (int i = 0; i < 3; i++) {
        format[i] = *ext ? *ext++ : ' ';
      }
      size_t format_len = sizeof(format);
      size_t string_len = 0;
      const char *string = lua_tolstring(L, -1, &string_len);
      uint8_t format_header[4];
      write_u32_le(format_header, (uint32_t)format_len);
      int rc = rb_write_header(rb, REPLY_VERBATIM,
                               (uint32_t)(sizeof(format_header) + format_len + string_len));
      if (rc == 0) {
        rc = rb_append(rb, format_header, sizeof(format_header));
      }
      if (rc == 0) {
        rc = rb_append(rb, format, format_len);
      }
      if (rc == 0) {
        rc = rb_append(rb, string, string_len);
      }
      lua_settop(L, vt - 1);
      return rc;
    }
    lua_settop(L, vt - 1);
  } else {
    lua_pop(L, 1);
  }

  if (rawget_field(L, idx, "map") == LUA_TTABLE) {
    int abs = lua_gettop(L);
    int rc = encode_map(L, abs, rb, depth);
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

  if (rawget_field(L, idx, "set") == LUA_TTABLE) {
    int abs = lua_gettop(L);
    int rc = encode_set(L, abs, rb, depth);
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

  return 1;
}

static int encode_table(lua_State *L, int idx, ReplyBuffer *rb, int depth) {
  if (idx < 0) {
    idx = lua_gettop(L) + idx + 1;
  }
  // Redis checks `err` before `ok`: a table carrying both fields is an error.
  // Both are read as C strings (cut at the first NUL) and CRLF-mapped; Redis
  // also trims trailing CRLF from errors, but not from status replies.
  if (rawget_field(L, idx, "err") == LUA_TSTRING) {
    const char *msg = lua_tostring(L, -1);
    int rc = rb_write_single_line(rb, REPLY_ERROR, msg, error_len(msg));
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

  if (rawget_field(L, idx, "ok") == LUA_TSTRING) {
    const char *msg = lua_tostring(L, -1);
    int rc = rb_write_single_line(rb, REPLY_STATUS, msg, strlen(msg));
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

  // Typed tables convert at any script protocol level, like real Redis. Only
  // booleans depend on redis.setresp(3).
  int typed = encode_typed_table(L, idx, rb, depth);
  if (typed != 1) {
    return typed;
  }

  // Array reply: iterate from index 1 and stop at the first nil, like Redis.
  size_t count = 0;
  for (;;) {
    lua_rawgeti(L, idx, (int)count + 1);
    int is_nil = lua_isnil(L, -1);
    lua_pop(L, 1);
    if (is_nil) {
      break;
    }
    count++;
  }
  if (rb_write_header(rb, REPLY_ARRAY, (uint32_t)count) != 0) {
    return -1;
  }
  for (size_t i = 1; i <= count; i++) {
    lua_rawgeti(L, idx, (int)i);
    int rc = encode_value(L, -1, rb, depth + 1);
    lua_pop(L, 1);
    if (rc != 0) {
      return rc;
    }
  }
  return 0;
}

/* Lua number -> integer reply, as Redis's `(long long)lua_tonumber(...)` does
 * on x86-64: the fractional part is truncated (`return 3.7` -> 3), and NaN,
 * +/-inf and anything outside the int64 range become INT64_MIN (cvttsd2si's
 * "integer indefinite" value). A plain C cast is undefined for those inputs and
 * saturates in WASM, so the out-of-range case is spelled out. */
static int64_t lua_number_to_reply_int(lua_Number num) {
  if (num >= -9223372036854775808.0 && num < 9223372036854775808.0) {
    return (int64_t)num;
  }
  return INT64_MIN;
}

static int encode_value(lua_State *L, int idx, ReplyBuffer *rb, int depth) {
  // Like Redis's luaReplyToRedisReply: make room for the (at most 4) slots a
  // table conversion pushes before recursing, instead of writing past the end
  // of the Lua stack. Deep or cyclic tables hit this (or the depth cap, see
  // REDIS_REPLY_MAX_DEPTH) and fail with "reached lua stack limit" rather than
  // hanging the host.
  if (depth > REDIS_REPLY_MAX_DEPTH || !lua_checkstack(L, 4)) {
    return ENCODE_STACK_LIMIT;
  }
  int type = lua_type(L, idx);
  switch (type) {
    case LUA_TNIL:
      return rb_write_header(rb, REPLY_NULL, 0);
    case LUA_TNUMBER: {
      lua_Number num = lua_tonumber(L, idx);
      if (rb_write_header(rb, REPLY_INT, 8) != 0) {
        return ENCODE_FAILED;
      }
      uint8_t payload[8];
      write_i64_le(payload, lua_number_to_reply_int(num));
      return rb_append(rb, payload, sizeof(payload));
    }
    case LUA_TBOOLEAN:
      if (redis_resp_version() == 3) {
        uint8_t payload = lua_toboolean(L, idx) ? 1 : 0;
        if (rb_write_header(rb, REPLY_BOOL, sizeof(payload)) != 0) {
          return -1;
        }
        return rb_append(rb, &payload, sizeof(payload));
      }
      if (lua_toboolean(L, idx)) {
        if (rb_write_header(rb, REPLY_INT, 8) != 0) {
          return -1;
        }
        uint8_t payload[8];
        write_i64_le(payload, 1);
        return rb_append(rb, payload, sizeof(payload));
      }
      return rb_write_header(rb, REPLY_NULL, 0);
    case LUA_TSTRING: {
      size_t len = 0;
      const char *str = lua_tolstring(L, idx, &len);
      if (!str) {
        return -1;
      }
      if (rb_write_header(rb, REPLY_BULK, (uint32_t)len) != 0) {
        return -1;
      }
      return rb_append(rb, str, len);
    }
    case LUA_TTABLE:
      return encode_table(L, idx, rb, depth);
    default:
      // Functions, coroutines and (light) userdata such as cjson.null have no
      // reply mapping: like Redis (luaReplyToRedisReply's addReplyNull), they
      // reply nil in place, at any depth, and the rest of the reply is kept.
      return rb_write_header(rb, REPLY_NULL, 0);
  }
}

/* Encodes the script's return value. Every Lua value converts (unsupported
 * types reply nil), so a non-zero return only means the reply buffer could not
 * be allocated. A reply nested beyond the Lua stack limit (deep or
 * cyclic tables) is not a conversion failure: like Redis, it replies with a
 * "reached lua stack limit" error. Redis writes that error in place of the
 * too-deep element, which here would hand the host a reply thousands of levels
 * deep, so the whole reply is replaced with the error instead. */
static int encode_lua_value(lua_State *L, int idx, ReplyBuffer *rb) {
  static const char stack_limit_msg[] = "ERR reached lua stack limit";
  if (idx < 0) {
    idx = lua_gettop(L) + idx + 1;
  }
  int top = lua_gettop(L);
  int rc = encode_value(L, idx, rb, 0);
  lua_settop(L, top);
  if (rc != ENCODE_STACK_LIMIT) {
    return rc;
  }
  rb->len = 0;
  return rb_write_single_line(rb, REPLY_ERROR, stack_limit_msg, sizeof(stack_limit_msg) - 1);
}

static void remove_global(lua_State *L, const char *name) {
  lua_pushnil(L);
  lua_setglobal(L, name);
}

static void remove_package_entry(lua_State *L, const char *name) {
  lua_getglobal(L, "package");
  if (!lua_istable(L, -1)) {
    lua_pop(L, 1);
    return;
  }
  lua_getfield(L, -1, "loaded");
  if (lua_istable(L, -1)) {
    lua_pushnil(L);
    lua_setfield(L, -2, name);
  }
  lua_pop(L, 2);
}

// Compatibility profile flags (set via set_compat() before init/reset). Each
// flag toggles one of the behaviors that actually differ across Redis
// 6.2-8.x and Valkey; everything else is constant. Default reproduces the
// historical behavior (os loaded, `server` alias present, print stripped),
// which matches Valkey 8.0/8.1 except for the redis.log arity error, which
// keeps the Redis wording ("redis.log() requires ...", no COMPAT_SERVER_LOG_NAME).
#define COMPAT_PRINT 0x1u        // keep Lua `print` (Redis 6.2 only)
#define COMPAT_OS 0x2u           // expose `os` lib (Redis 7.4+, Valkey 8.0+)
#define COMPAT_SERVER_ALIAS 0x4u // `server` aliases `redis` (Valkey 8.0+)
#define COMPAT_RESEED_RANDOM 0x8u // reseed math.random with 0 per script (Redis 6.2 only)
// {err=...} error tables + unwrapping pcall (Redis 7.0+); also error_reply's code
// derivation and the ERR code on redis.log / redis.setresp errors (off: Redis 6.2's
// unchanged error_reply string and code-less errors).
#define COMPAT_TABLE_ERRORS 0x10u
// Error wording only, set from the profile (no CompatOverrides field):
#define COMPAT_LOG_DEBUG_LEVEL 0x20u // redis.log: "Invalid debug level." (Redis 6.2-7.2)
#define COMPAT_SERVER_LOG_NAME 0x40u // redis.log: "server.log() requires ..." (Valkey 8.0+)
static uint32_t g_compat_flags = COMPAT_OS | COMPAT_SERVER_ALIAS | COMPAT_TABLE_ERRORS;

void set_compat(uint32_t flags) { g_compat_flags = flags; }

int compat_table_errors(void) { return (g_compat_flags & COMPAT_TABLE_ERRORS) != 0; }

int compat_log_debug_level(void) { return (g_compat_flags & COMPAT_LOG_DEBUG_LEVEL) != 0; }

int compat_server_log_name(void) { return (g_compat_flags & COMPAT_SERVER_LOG_NAME) != 0; }

// Mirror Redis's allow/deny arrays (src/script_lua.c) rather than a hand-rolled
// deny set. Redis exposes loadstring/load/collectgarbage/gcinfo (lua_builtins_
// allow_list) and a sandboxed os (libraries_allow_list); we keep those. We only
// strip what Redis strips: its deny_list (dofile/loadfile/print), the libs it
// never loads (io/debug/package/require), and lua_builtins_deprecated. `print`
// is stripped unless COMPAT_PRINT is set (Redis 6.2 kept it).
static void disable_non_determinism(lua_State *L, uint32_t flags) {
  remove_global(L, "io");
  remove_global(L, "debug");
  remove_global(L, "package");
  remove_global(L, "require");
  remove_global(L, "dofile");
  remove_global(L, "loadfile");
  if (!(flags & COMPAT_PRINT)) {
    remove_global(L, "print");
  }
  remove_global(L, "newproxy");
  // Sandbox-escape vectors: setfenv swaps the running function's environment
  // for a writable table and getfenv(0) reaches the real global table,
  // bypassing globals protection. Valkey removes these too (lua_builtins_deprecated
  // in src/script_lua.c).
  remove_global(L, "setfenv");
  remove_global(L, "getfenv");
  remove_package_entry(L, "io");
  remove_package_entry(L, "debug");
  remove_package_entry(L, "package");
}

// Globals protection: mirror real Redis exactly.
//
// READ of a nonexistent global -> a metatable __index handler (this function)
// raises, matching Redis's luaSetErrorMetatable. It raises the coded marker
// `__RLUA_E__:global-read:<name>` and records it as an engine error
// (redis_mark_engine_error), which is what makes run_script report it as one;
// the TS layer forwards { kind, name } and the host picks the wording. `name`
// is the __index key (stack index 2).
//
// WRITE of any global (creation or reassignment of an existing one) -> the
// patched Lua's native readonly flag (lua_enablereadonlytable), enabled in
// enable_globals_protection below. The VM raises "Attempt to modify a readonly
// table" itself; that string is Redis's own (vendored), so it passes through
// untouched. The flag blocks every write, including reassigning an existing
// global -- which a __newindex metatable would miss.
static int protect_globals_index(lua_State *L) {
  const char *name = lua_tostring(L, 2);
  /* luaL_error's position prefix is empty here (level 1 is this C function). */
  lua_pushfstring(L, ENGINE_ERROR_PREFIX "global-read:%s", name ? name : "?");
  redis_mark_engine_error(L, -1);
  return lua_error(L);
}

/* Records the string at idx as the engine-originated error of this eval. The
 * error run_script replies with is reported as an engine error
 * (SCRIPT_ERROR_ENGINE) only if its message is this exact string: a later,
 * different error, or a script raising a lookalike marker text, is not (#59).
 * A script that catches the engine error and rethrows it unchanged still gets
 * it reported as one, like rethrowing Redis's own error table. */
void redis_mark_engine_error(lua_State *L, int idx) {
  lua_pushvalue(L, idx);
  lua_rawseti(L, LUA_REGISTRYINDEX, g_engine_error_ref);
}

static void clear_engine_error(lua_State *L) {
  lua_pushboolean(L, 0);
  lua_rawseti(L, LUA_REGISTRYINDEX, g_engine_error_ref);
}

/* Whether the value at idx is the message recorded by redis_mark_engine_error. */
static int is_engine_error(lua_State *L, int idx) {
  if (idx < 0) {
    idx = lua_gettop(L) + idx + 1;
  }
  lua_rawgeti(L, LUA_REGISTRYINDEX, g_engine_error_ref);
  int equal = lua_type(L, idx) == LUA_TSTRING && lua_rawequal(L, idx, -1);
  lua_pop(L, 1);
  return equal;
}

// Recursively set the native readonly flag on the table at the top of the stack
// and every table reachable from it (values and metatables). Mirrors Redis's
// luaSetTableProtectionRecursively. The readonly check both guards against cycles
// (e.g. _G._G points back at globals) and stops re-walking shared tables.
static void protect_table_recursively(lua_State *L) {
  if (lua_isreadonlytable(L, -1)) {
    return;
  }
  lua_enablereadonlytable(L, -1, 1);

  lua_checkstack(L, 2);
  lua_pushnil(L);
  while (lua_next(L, -2)) {
    // Stack: table, key, value
    if (lua_istable(L, -1)) {
      protect_table_recursively(L);
    }
    lua_pop(L, 1); // pop value, keep key for the next iteration
  }

  if (lua_getmetatable(L, -1)) {
    protect_table_recursively(L);
    lua_pop(L, 1);
  }
}

// Lock the metatables of basic types so a script cannot escape the sandbox by
// mutating e.g. the shared string metatable. Mirrors
// luaSetTableProtectionForBasicTypes in Valkey 8.0's src/script_lua.c
// (BSD-licensed in Valkey 7.2.11+ / 8.0.6+ and Redis 7.2.11+).
static void protect_basic_type_metatables(lua_State *L) {
  static const int types[] = {LUA_TSTRING,   LUA_TNUMBER, LUA_TBOOLEAN, LUA_TNIL,
                              LUA_TFUNCTION,  LUA_TTHREAD, LUA_TLIGHTUSERDATA};
  for (size_t i = 0; i < sizeof(types) / sizeof(types[0]); i++) {
    switch (types[i]) {
      case LUA_TSTRING: lua_pushstring(L, ""); break;
      case LUA_TNUMBER: lua_pushnumber(L, 0); break;
      case LUA_TBOOLEAN: lua_pushboolean(L, 0); break;
      case LUA_TNIL: lua_pushnil(L); break;
      case LUA_TFUNCTION: lua_pushcfunction(L, NULL); break;
      case LUA_TTHREAD: lua_newthread(L); break;
      case LUA_TLIGHTUSERDATA: lua_pushlightuserdata(L, (void *)L); break;
    }
    if (lua_getmetatable(L, -1)) {
      protect_table_recursively(L);
      lua_pop(L, 1); // pop metatable
    }
    lua_pop(L, 1); // pop dummy value
  }
}

static void enable_globals_protection(lua_State *L) {
  // Read protection: __index handler raises on reads of a nonexistent global.
  lua_pushvalue(L, LUA_GLOBALSINDEX);
  lua_newtable(L);
  lua_pushcfunction(L, protect_globals_index);
  lua_setfield(L, -2, "__index");
  lua_setmetatable(L, -2);

  // Write protection: recursively lock the globals table and everything reachable
  // from it (redis, cjson, string, math, ... and the metatable just set), matching
  // real Redis. Must come after all engine setup (libs, redis API); raw_setglobal
  // toggles the globals flag off for KEYS/ARGV injection at eval time.
  protect_table_recursively(L);
  lua_pop(L, 1);
  protect_basic_type_metatables(L);
}

// Set a global by raw assignment, bypassing write protection. Value to assign
// must be on top of the stack; it is popped. Toggles the native readonly flag
// off around the write and restores it (matching Redis's setup sequence).
static void raw_setglobal(lua_State *L, const char *name) {
  int was_ro = lua_isreadonlytable(L, LUA_GLOBALSINDEX);
  if (was_ro) {
    lua_enablereadonlytable(L, LUA_GLOBALSINDEX, 0);
  }
  lua_pushvalue(L, LUA_GLOBALSINDEX); // [.., value, G]
  lua_insert(L, -2);                  // [.., G, value]
  lua_pushstring(L, name);            // [.., G, value, name]
  lua_insert(L, -2);                  // [.., G, name, value]
  lua_rawset(L, -3);                  // G[name] = value; pops name, value -> [.., G]
  lua_pop(L, 1);                      // [..]
  if (was_ro) {
    lua_enablereadonlytable(L, LUA_GLOBALSINDEX, 1);
  }
}

// lua_call is unprotected by itself; this only runs inside setup_state_body,
// under setup_state's lua_cpcall, so a failing library load (e.g. out of
// memory) fails the setup instead of reaching the panic handler.
static void luaLoadLib(lua_State *L, const char *name, lua_CFunction func) {
  lua_pushcfunction(L, func);
  lua_pushstring(L, name);
  lua_call(L, 1, 0);
}

LUALIB_API int luaopen_cjson(lua_State *L);
LUALIB_API int luaopen_struct(lua_State *L);
LUALIB_API int luaopen_cmsgpack(lua_State *L);
LUALIB_API int luaopen_bit(lua_State *L);

static void load_redis_modules(lua_State *L) {
  luaLoadLib(L, "cjson", luaopen_cjson);
  luaLoadLib(L, "struct", luaopen_struct);
  luaLoadLib(L, "cmsgpack", luaopen_cmsgpack);
  luaLoadLib(L, "bit", luaopen_bit);
}

static void open_allowed_libs(lua_State *L, uint32_t flags) {
  // luaopen_base pushes TWO tables (the globals table and the coroutine table);
  // the rest push one. Clear the stack afterwards so no library table is left
  // behind to masquerade as a script return value.
  luaopen_base(L);
  luaopen_table(L);
  luaopen_string(L);
  luaopen_math(L);
  // Redis exposes os via libraries_allow_list; the vendored loslib.c sandboxes
  // it to only os.clock (sandbox_syslib), so opening it here is safe. Skipped
  // unless COMPAT_OS is set (Redis < 7.4 / Valkey 7.2 had no os); when skipped,
  // reading `os` hits the globals-protection __index handler and raises.
  if (flags & COMPAT_OS) {
    luaopen_os(L);
  }
  lua_settop(L, 0);
  disable_non_determinism(L, flags);
  load_redis_modules(L);
}

#define FUEL_KILL_MASK (LUA_MASKLINE | LUA_MASKCOUNT)
#define FUEL_KILL_MSG "ERR Script killed by fuel limit"

/* Set once the budget is spent; cleared by reset_fuel. run_script then replies
 * with the kill whatever the script did afterwards, e.g. a coroutine.resume
 * that returned the kill as a value. g_fuel_kill_line is the script line at
 * the kill point. */
static int g_fuel_killed = 0;
static uint32_t g_fuel_kill_line = 0;

/* Line of the innermost Lua frame of L (0 if none): the running function,
 * as a hook runs without a frame of its own. */
static uint32_t current_script_line(lua_State *L) {
  lua_Debug ar;
  for (int level = 0; lua_getstack(L, level, &ar); level++) {
    if (lua_getinfo(L, "Sl", &ar) && ar.currentline > 0) {
      return (uint32_t)ar.currentline;
    }
  }
  return 0;
}

/* Charges FUEL_HOOK_STEP instructions per call and kills the script once the
 * budget is spent. Like Redis's luaMaskCountHook after SCRIPT KILL, the kill
 * then re-hooks the thread to fire on every instruction and line, so the error
 * is raised again right after any pcall that catches it and keeps propagating
 * until it escapes every pcall. Raised only every FUEL_HOOK_STEP instructions,
 * it would always land inside a pcall'd loop and be caught there forever
 * (#38). A coroutine has a hook of its own: when one runs out, the main thread
 * is switched too, so it stops as soon as it resumes. reset_fuel restores the
 * counting hook before the next script.
 *
 * No message handler runs for the kill (errfunc is cleared; luaD_pcall
 * restores it on unwind): xpcall just returns false, and the next instruction
 * raises again. A handler would run with hooks disabled (an error raised from
 * a hook keeps them off until it is caught), so it could loop forever, and
 * run_script's own handler is not needed as the kill line is recorded here. */
static void fuel_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  if (!g_fuel_killed) {
    g_fuel_remaining -= FUEL_HOOK_STEP;
    if (g_fuel_remaining > 0) {
      return;
    }
    g_fuel_killed = 1;
    g_fuel_kill_line = current_script_line(L);
  }
  if (lua_gethookmask(L) != FUEL_KILL_MASK || lua_gethookcount(L) != 1) {
    lua_sethook(L, fuel_hook, FUEL_KILL_MASK, 1);
  }
  if (L != g_state) {
    lua_sethook(g_state, fuel_hook, FUEL_KILL_MASK, 1);
  }
  L->errfunc = 0;
  redis_raise_error(L, FUEL_KILL_MSG);
}

static void reset_fuel(void) {
  g_fuel_remaining = g_fuel_limit;
  g_fuel_killed = 0;
  g_fuel_kill_line = 0;
  if (g_state) {
    lua_sethook(g_state, fuel_hook, LUA_MASKCOUNT, FUEL_HOOK_STEP);
  }
}

void set_limits(uint32_t max_fuel, uint32_t max_reply_bytes, uint32_t max_arg_bytes) {
  if (max_fuel > 0) {
    g_fuel_limit = (int64_t)max_fuel;
  }
  g_max_reply_bytes = max_reply_bytes;
  g_max_arg_bytes = max_arg_bytes;
}

static int set_keys_argv(lua_State *L, const uint8_t *buf, size_t len, uint32_t keys_count) {
  if (len < 4) {
    return -1;
  }
  uint32_t count = (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) | ((uint32_t)buf[2] << 16) |
                   ((uint32_t)buf[3] << 24);
  if (keys_count > count) {
    return -1;
  }

  lua_createtable(L, (int)keys_count, 0);
  lua_createtable(L, (int)(count - keys_count), 0);

  size_t offset = 4;
  for (uint32_t i = 0; i < count; i++) {
    if (offset + 4 > len) {
      return -1;
    }
    uint32_t item_len = (uint32_t)buf[offset] | ((uint32_t)buf[offset + 1] << 8) |
                        ((uint32_t)buf[offset + 2] << 16) |
                        ((uint32_t)buf[offset + 3] << 24);
    offset += 4;
    if (offset + item_len > len) {
      return -1;
    }
    lua_pushlstring(L, (const char *)(buf + offset), item_len);
    if (i < keys_count) {
      lua_rawseti(L, -3, (int)i + 1);
    } else {
      lua_rawseti(L, -2, (int)(i - keys_count) + 1);
    }
    offset += item_len;
  }

  raw_setglobal(L, "ARGV");
  raw_setglobal(L, "KEYS");
  return 0;
}

static void set_empty_keys_argv(lua_State *L) {
  lua_createtable(L, 0, 0);
  raw_setglobal(L, "KEYS");
  lua_createtable(L, 0, 0);
  raw_setglobal(L, "ARGV");
}

typedef struct KeysArgvCtx {
  int has_args;
  const uint8_t *args;
  size_t args_len;
  uint32_t keys_count;
  int rc; /* set_keys_argv's result: -1 on a malformed encoding */
} KeysArgvCtx;

/* lua_cpcall body for set_script_keys_argv. */
static int set_keys_argv_body(lua_State *L) {
  KeysArgvCtx *ctx = (KeysArgvCtx *)lua_touserdata(L, 1);
  if (ctx->has_args) {
    ctx->rc = set_keys_argv(L, ctx->args, ctx->args_len, ctx->keys_count);
  } else {
    set_empty_keys_argv(L);
  }
  return 0;
}

/* Sets KEYS/ARGV in protected mode: the tables and strings are allocated here,
 * before the script's lua_pcall, and a huge ARGV can exhaust the heap. Returns
 * NULL on success, else the error reply to send. */
static const char *set_script_keys_argv(lua_State *L, KeysArgvCtx *ctx) {
  int status = lua_cpcall(L, set_keys_argv_body, ctx);
  if (status != 0) {
    /* The error may have hit raw_setglobal between unlocking the globals table
     * and locking it again. */
    lua_enablereadonlytable(L, LUA_GLOBALSINDEX, 1);
    lua_settop(L, 0);
    return status == LUA_ERRMEM ? "ERR not enough memory to set KEYS/ARGV"
                                : "ERR invalid KEYS/ARGV encoding";
  }
  return ctx->rc != 0 ? "ERR invalid KEYS/ARGV encoding" : NULL;
}

typedef struct EncodeReplyCtx {
  ReplyBuffer *rb;
  int rc;
} EncodeReplyCtx;

/* Protected body of encode_reply: encodes the value at index 1. */
static int encode_reply_body(lua_State *L) {
  EncodeReplyCtx *ctx = (EncodeReplyCtx *)lua_touserdata(L, 2);
  ctx->rc = encode_lua_value(L, 1, ctx->rb);
  return 0;
}

/* encode_lua_value in protected mode. The encoder pushes Lua strings and grows
 * the Lua stack, which raise a memory error when the heap is exhausted; that
 * fails the encoding like a reply buffer that cannot grow. */
static int encode_reply(lua_State *L, int idx, ReplyBuffer *rb) {
  if (idx < 0) {
    idx = lua_gettop(L) + idx + 1;
  }
  EncodeReplyCtx ctx = {rb, ENCODE_FAILED};
  lua_rawgeti(L, LUA_REGISTRYINDEX, g_encode_reply_ref);
  lua_pushvalue(L, idx);
  lua_pushlightuserdata(L, &ctx);
  if (lua_pcall(L, 2, 0, 0) != 0) {
    lua_pop(L, 1);
    return ENCODE_FAILED;
  }
  return ctx.rc;
}

/* Protected body of collect_if_heap_high. */
static int collect_garbage(lua_State *L) {
  lua_gc(L, LUA_GCCOLLECT, 0);
  return 0;
}

/* Error reply for an unprotected Lua error; see vm_panic. */
static char g_panic_msg[128];
static jmp_buf g_panic_jmp;
static int g_panic_armed = 0;

/* Set while an eval runs. A host callback (redis.call) may call back into the
 * module; a nested eval, init or reset would then replace KEYS/ARGV, clear the
 * Lua stack or even close the VM under the running script, so they are
 * refused. */
static int g_eval_active = 0;

/* Status of the collection run_script ran after the script (see
 * collect_if_heap_high), or -1 if it returned before running one. */
static int g_script_gc_status = -1;

/* lua_atpanic handler. Lua calls it for an error raised outside any protected
 * call, then calls exit() if it returns. Every Lua call on the eval path runs
 * protected (setup, KEYS/ARGV, script, reply encoding, collection), so this is
 * a backstop. While run_guarded is active it jumps back there, which discards
 * the VM (the C code that was interrupted may have left it half-updated, e.g.
 * with the globals table unlocked) and builds a new one; the eval then replies
 * with an error. Anywhere else there is nothing safe to return to, so it
 * aborts, which the JS engine reports as a fault. */
static int vm_panic(lua_State *L) {
  if (!g_panic_armed) {
    abort();
  }
  g_panic_armed = 0;
  /* Only read a string: converting another value could allocate and fail. */
  const char *msg = lua_type(L, -1) == LUA_TSTRING ? lua_tostring(L, -1) : "unknown error";
  snprintf(g_panic_msg, sizeof(g_panic_msg), "%s", msg);
  for (char *p = g_panic_msg; *p; p++) {
    if (*p == '\r' || *p == '\n') {
      *p = ' ';
    }
  }
  longjmp(g_panic_jmp, 1);
  return 0;
}

typedef struct SetupCtx {
  const uint8_t *props;
  size_t props_len;
  int props_rc;
} SetupCtx;

static int store_cfunction(lua_State *L, lua_CFunction fn) {
  lua_pushcfunction(L, fn);
  return luaL_ref(L, LUA_REGISTRYINDEX);
}

/* lua_cpcall body of setup_state: everything that builds the sandbox. */
static int setup_state_body(lua_State *L) {
  SetupCtx *ctx = (SetupCtx *)lua_touserdata(L, 1);
  lua_settop(L, 0);
  open_allowed_libs(L, g_compat_flags);
  register_redis_math(L);
  register_redis_api(L);
  if (ctx->props && apply_redis_props(L, ctx->props, ctx->props_len) != 0) {
    ctx->props_rc = -1;
    return 0;
  }
  /* Valkey 8.0+ exposes `server` as an alias of `redis` (same table reference so
   * both share the host-injected props). Must run before protection locks them.
   * Redis keeps `redis` only -- gated on COMPAT_SERVER_ALIAS. */
  if (g_compat_flags & COMPAT_SERVER_ALIAS) {
    lua_getglobal(L, "redis");
    lua_setglobal(L, "server");
  }
  lua_pushboolean(L, 0);
  g_engine_error_ref = luaL_ref(L, LUA_REGISTRYINDEX);
  enable_globals_protection(L);
  g_error_handler_ref = store_cfunction(L, script_error_handler);
  g_encode_reply_ref = store_cfunction(L, encode_reply_body);
  g_collect_garbage_ref = store_cfunction(L, collect_garbage);
  return 0;
}

// Build a fresh Lua state in g_state honoring g_compat_flags. Shared by init()
// and reset(); the caller is responsible for closing any prior state. The
// setup runs in protected mode, so running out of memory fails it (-1, no
// state) instead of reaching the panic handler.
static int32_t setup_state(void) {
  g_state = luaL_newstate();
  if (!g_state) {
    return -1;
  }
  lua_atpanic(g_state, vm_panic);
  SetupCtx ctx = {NULL, 0, 0};
  PtrLen props = host_redis_props();
  if (props.ptr && props.len) {
    ctx.props = (const uint8_t *)(uintptr_t)props.ptr;
    ctx.props_len = (size_t)props.len;
  }
  int status = lua_cpcall(g_state, setup_state_body, &ctx);
  if (props.ptr) {
    free_mem(props.ptr);
  }
  if (status != 0 || ctx.props_rc != 0) {
    lua_close(g_state);
    g_state = NULL;
    return -1;
  }
  lua_settop(g_state, 0);
  lua_sethook(g_state, fuel_hook, LUA_MASKCOUNT, FUEL_HOOK_STEP);
  reset_fuel();
  return 0;
}

int32_t init(void) {
  if (g_eval_active) {
    return -1;
  }
  if (g_state) {
    lua_close(g_state);
    g_state = NULL;
  }
  return setup_state();
}

/* Replaces the VM with a fresh one, keeping everything configured outside it
 * (limits, compat flags; props are fetched from the host again). Also recovers
 * a VM that is missing because a previous init/reset/rebuild ran out of memory
 * or close_vm ran. */
int32_t reset(void) {
  if (g_eval_active) {
    return -1;
  }
  if (g_state) {
    lua_close(g_state);
    g_state = NULL;
  }
  return setup_state();
}

/* Closes the VM for good (the engine is being disposed). Idempotent; refused
 * while an eval is active, like init and reset. */
int32_t close_vm(void) {
  if (g_eval_active) {
    return -1;
  }
  if (g_state) {
    lua_close(g_state);
    g_state = NULL;
  }
  return 0;
}

/* Lua memory in use (KB) above which a run is followed by a full collection:
 * a quarter of the fixed 64 MB heap. */
#define GC_AFTER_RUN_KB (16 * 1024)

/* Lua 5.1 has no emergency collection, and its GC pacing (next cycle at 2x the
 * memory that survived the last one) knows nothing of the fixed-size heap. A
 * script that allocated heavily, whether it succeeded, hit "not enough memory"
 * or caught and rethrew it, can leave enough garbage that the next unrelated
 * script fails to allocate. Collect it once Lua holds more than
 * GC_AFTER_RUN_KB; below that the regular pacing leaves ample headroom, and
 * above it the cost is proportional to what the script just allocated.
 * Protected, as a collection allocates (see below), through the preallocated
 * collect_garbage closure: creating one here could itself fail on a full heap.
 * The Lua stack is left as it was.
 *
 * Returns non-zero if the collection ran out of memory. Lua 5.1 shrinks the
 * string table at the end of a sweep by allocating the smaller one first; when
 * the heap is full of objects that died after that cycle's mark, this fails
 * every time and the cycle that would free them never starts. Only discarding
 * the VM gets that memory back (see run_guarded). */
static int collect_if_heap_high(void) {
  if (!g_state || lua_gc(g_state, LUA_GCCOUNT, 0) <= GC_AFTER_RUN_KB) {
    return 0;
  }
  int top = lua_gettop(g_state);
  lua_rawgeti(g_state, LUA_REGISTRYINDEX, g_collect_garbage_ref);
  int status = lua_pcall(g_state, 0, 0, 0);
  lua_settop(g_state, top); /* drop the error lua_pcall pushes on failure */
  return status;
}

// Shared body of eval() and eval_with_args(). With has_args set, KEYS/ARGV are
// decoded from `args` (see set_keys_argv) after the maxArgBytes check;
// otherwise both are set to empty tables.
static PtrLen run_script(const char *script, size_t script_len, int has_args,
                         const uint8_t *args, size_t args_len, uint32_t keys_count) {
  if (!g_state) {
    return REPLY_ERROR_LIT("ERR Lua VM not initialized");
  }
  reset_fuel();
  redis_reset_resp_version();
  if (g_compat_flags & COMPAT_RESEED_RANDOM) {
    redis_math_reseed();
  }
  if (has_args && g_max_arg_bytes > 0 && args_len > g_max_arg_bytes) {
    return REPLY_ERROR_LIT("ERR KEYS/ARGV exceeds configured limit");
  }
  KeysArgvCtx keys_argv = {has_args, args, args_len, keys_count, 0};
  const char *setup_err = set_script_keys_argv(g_state, &keys_argv);
  if (setup_err) {
    return reply_error(setup_err, strlen(setup_err));
  }
  clear_engine_error(g_state);
  lua_rawgeti(g_state, LUA_REGISTRYINDEX, g_error_handler_ref);
  int errfunc = lua_gettop(g_state);
  if (luaL_loadbuffer(g_state, script, script_len, "@user_script") != 0) {
    const char *err = lua_tostring(g_state, -1);
    PtrLen out = reply_script_error(err ? err : "ERR script load failed", 0, 0);
    lua_settop(g_state, 0);
    return out;
  }
  g_error_line = 0;
  g_error_from_table = 0;
  // Like Redis (lua_pcall(lua, 0, 1, -2)), keep exactly one result: the first
  // value of a multi-value return, or nil when the script returns nothing.
  int status = lua_pcall(g_state, 0, 1, errfunc);
  // Free the script's garbage before allocating the reply: a script that
  // filled the heap and caught the error would otherwise leave no room for it.
  // run_guarded acts on the result once the reply is built.
  g_script_gc_status = collect_if_heap_high();
  if (g_fuel_killed) {
    // Whether the kill escaped (status != 0) or was swallowed as a value. The
    // message carries its code, like the error table Redis raises for a kill.
    PtrLen out = reply_script_error(FUEL_KILL_MSG, g_fuel_kill_line, SCRIPT_ERROR_FROM_TABLE);
    lua_settop(g_state, 0);
    return out;
  }
  if (status != 0) {
    // The error handler ran (and set g_error_from_table) only for LUA_ERRRUN;
    // a memory error or a failing handler leaves a plain message.
    uint8_t flags = 0;
    if (status == LUA_ERRRUN) {
      if (is_engine_error(g_state, -1)) {
        flags = SCRIPT_ERROR_ENGINE;
      } else if (g_error_from_table) {
        flags = SCRIPT_ERROR_FROM_TABLE;
      }
    }
    const char *err = lua_tostring(g_state, -1);
    PtrLen out = reply_script_error(err ? err : "ERR script execution failed", g_error_line, flags);
    lua_settop(g_state, 0);
    return out;
  }
  ReplyBuffer rb;
  rb_init(&rb);
  rb.limit = g_max_reply_bytes;
  int rc = encode_reply(g_state, -1, &rb);
  lua_settop(g_state, 0);
  if (rc != 0) {
    // The reply buffer records whether a write crossed maxReplyBytes; any
    // other failure is the heap (a buffer that could not grow, or a Lua memory
    // error in encode_reply).
    int status = rb.status;
    free(rb.data);
    if (status == RB_OVER_LIMIT) {
      return REPLY_ERROR_LIT("ERR reply exceeds configured limit");
    }
    return REPLY_ERROR_LIT("ERR reply encoding failed");
  }
  PtrLen out = rb_finalize(&rb);
  if (out.ptr == 0) {
    return REPLY_ERROR_LIT("ERR reply encoding failed");
  }
  return out;
}

typedef PtrLen (*GuardedFn)(void *arg);

/* Closes the VM and builds a fresh one (g_state is NULL if that fails). */
static int32_t rebuild_vm(void) {
  lua_State *old = g_state;
  g_state = NULL;
  if (old) {
    lua_close(old);
  }
  return setup_state();
}

/* Runs fn with the panic handler armed (see vm_panic). After a panic the VM is
 * rebuilt and the reply is an error naming the Lua error. The VM is also
 * rebuilt when its garbage cannot be collected (see collect_if_heap_high):
 * nothing but KEYS/ARGV outlives a script, so a fresh VM behaves the same.
 * Refuses to run while another eval is active (see g_eval_active). */
static PtrLen run_guarded(GuardedFn fn, void *arg) {
  if (g_eval_active) {
    return REPLY_ERROR_LIT("ERR nested eval is not supported: a script is already running");
  }
  g_eval_active = 1;
  g_script_gc_status = -1;
  PtrLen out;
  int gc_status;
  if (setjmp(g_panic_jmp) == 0) {
    g_panic_armed = 1;
    out = fn(arg);
    g_panic_armed = 0;
    // Collect here only if run_script returned before its own collection.
    gc_status = g_script_gc_status >= 0 ? g_script_gc_status : collect_if_heap_high();
  } else {
    int32_t rc = rebuild_vm();
    char msg[sizeof(g_panic_msg) + 96];
    snprintf(msg, sizeof(msg), "ERR unprotected Lua error (%s); %s", g_panic_msg,
             rc == 0 ? "the Lua VM was reset" : "the Lua VM could not be re-created");
    out = reply_error(msg, strlen(msg));
    gc_status = 0; /* fresh VM */
  }
  if (gc_status != 0) {
    rebuild_vm();
  }
  // Every reply run_script builds is non-empty, so {0, 0} means even the error
  // reply could not be allocated. Retry now that the heap has been collected.
  if (out.ptr == 0) {
    out = REPLY_ERROR_LIT("ERR not enough memory for the script reply");
  }
  g_eval_active = 0;
  return out;
}

typedef struct ScriptRun {
  const char *script;
  size_t script_len;
  int has_args;
  const uint8_t *args;
  size_t args_len;
  uint32_t keys_count;
} ScriptRun;

static PtrLen run_script_guarded(void *arg) {
  ScriptRun *run = (ScriptRun *)arg;
  return run_script(run->script, run->script_len, run->has_args, run->args, run->args_len,
                    run->keys_count);
}

PtrLen eval(uint32_t ptr, uint32_t len) {
  ScriptRun run = {(const char *)(uintptr_t)ptr, (size_t)len, 0, NULL, 0, 0};
  return run_guarded(run_script_guarded, &run);
}

PtrLen eval_with_args(uint32_t script_ptr, uint32_t script_len, uint32_t args_ptr,
                      uint32_t args_len, uint32_t keys_count) {
  ScriptRun run = {(const char *)(uintptr_t)script_ptr, (size_t)script_len, 1,
                   (const uint8_t *)(uintptr_t)args_ptr, (size_t)args_len, keys_count};
  return run_guarded(run_script_guarded, &run);
}

#ifdef LUA_REDIS_WASM_TESTING
/* Smoke-test hook: raises a Lua error outside any protected call, which only
 * the panic handler can catch. */
static PtrLen raise_unprotected_error(void *arg) {
  (void)arg;
  lua_pushstring(g_state, "injected\r\nerror");
  lua_error(g_state);
  return (PtrLen){0, 0};
}

PtrLen test_unprotected_error(void) { return run_guarded(raise_unprotected_error, NULL); }
#endif

uint32_t alloc(uint32_t size) {
  void *mem = malloc(size);
  return (uint32_t)(uintptr_t)mem;
}

void free_mem(uint32_t ptr) {
  void *mem = (void *)(uintptr_t)ptr;
  free(mem);
}
