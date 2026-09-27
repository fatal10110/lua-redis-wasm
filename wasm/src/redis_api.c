/* redis.* bindings (redis.call/pcall/log/sha1hex/...) for lua-redis-wasm.
 *
 * Portions derived from Valkey / Redis 7.2.4 (BSD-3-Clause, see
 * THIRD_PARTY_NOTICES.md), mainly Valkey 8.0's src/script_lua.c and double2ll
 * from src/util.c, and from Redis 6.2's src/scripting.c (BSD-3-Clause) for the
 * redis-6.2 profile's error_reply / log / setresp errors. */
#include "../include/abi.h"
#include "redis_api.h"
#include "../../vendor/valkey/deps/fpconv/fpconv_dtoa.h"
#include <lauxlib.h>
#include <limits.h>
#include <lua.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LOG_DEBUG 0
#define LOG_VERBOSE 1
#define LOG_NOTICE 2
#define LOG_WARNING 3

static uint32_t g_resp_version = 2;
/* Redis 7 error model (compat flag, snapshot by register_redis_api): errors are
 * raised as {err=...} tables and the global pcall unwraps them. Off, errors are
 * plain strings as in Redis 6.2. */
static int g_table_errors = 0;
/* redis.log error wording of the profile (compat flags, snapshot by
 * register_redis_api): "Invalid debug level." (Redis 6.2-7.2) instead of
 * "Invalid log level.", and "server.log()" (Valkey 8.0+) instead of
 * "redis.log()" in the arity error. */
static int g_log_debug_level = 0;
static int g_server_log_name = 0;
/* Caller of the redis.call/redis.pcall currently dispatched to the host: the
 * chunk source (NUL-terminated, NULL when unknown) and line. Read by the host
 * via current_call_source()/current_call_line() from inside its callback, e.g.
 * to build Redis 6.2's "<source>: <line>: " pcall error prefix. */
static const char *g_call_source = NULL;
static int32_t g_call_line = 0;

uint32_t current_call_source(void) {
  return (uint32_t)(uintptr_t)g_call_source;
}

int32_t current_call_line(void) {
  return g_call_line;
}

int redis_table_errors(void) {
  return g_table_errors;
}

uint32_t redis_resp_version(void) {
  return g_resp_version;
}

void redis_reset_resp_version(void) {
  g_resp_version = 2;
}

/* Raises `msg` without luaL_error's "user_script:N:" position prefix; the
 * script line reaches the host through the error handler instead. In
 * table-error mode the error object is {err=msg}, like Redis 7's luaPushError +
 * luaError; otherwise it is the plain string, like Redis 6.2. `msg` is raised
 * as given: in table-error mode it should be a complete "CODE message" string,
 * while a Redis 6.2 error may have no code (see raise_api_error).
 * Derived from luaPushError / luaError in Valkey 8.0's src/script_lua.c
 * (same in Redis 7.2.4), BSD-3-Clause. */
int redis_raise_error(lua_State *L, const char *msg) {
  if (g_table_errors) {
    lua_createtable(L, 0, 1);
    lua_pushstring(L, msg);
    lua_setfield(L, -2, "err");
  } else {
    lua_pushstring(L, msg);
  }
  return lua_error(L);
}

int redis_raise_engine_error(lua_State *L, const char *msg) {
  lua_pushstring(L, msg);
  redis_mark_engine_error(L, -1);
  lua_pop(L, 1);
  return redis_raise_error(L, msg);
}

static void write_u32_le(uint8_t *dst, uint32_t value) {
  dst[0] = (uint8_t)(value & 0xFF);
  dst[1] = (uint8_t)((value >> 8) & 0xFF);
  dst[2] = (uint8_t)((value >> 16) & 0xFF);
  dst[3] = (uint8_t)((value >> 24) & 0xFF);
}

static uint32_t read_u32_le(const uint8_t *src) {
  return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) |
         ((uint32_t)src[3] << 24);
}

static int64_t read_i64_le(const uint8_t *src) {
  uint64_t value = 0;
  value |= (uint64_t)src[0];
  value |= (uint64_t)src[1] << 8;
  value |= (uint64_t)src[2] << 16;
  value |= (uint64_t)src[3] << 24;
  value |= (uint64_t)src[4] << 32;
  value |= (uint64_t)src[5] << 40;
  value |= (uint64_t)src[6] << 48;
  value |= (uint64_t)src[7] << 56;
  return (int64_t)value;
}

static double read_f64_le(const uint8_t *src) {
  double d;
  memcpy(&d, src, sizeof(d)); /* wasm is little-endian */
  return d;
}

typedef struct ArgBuffer {
  uint8_t *data;
  size_t len;
  size_t cap;
} ArgBuffer;

static void ab_init(ArgBuffer *ab, uint32_t count) {
  ab->cap = 256;
  ab->len = 0;
  ab->data = (uint8_t *)malloc(ab->cap);
  if (!ab->data) {
    ab->cap = 0;
    return;
  }
  uint8_t header[4];
  write_u32_le(header, count);
  memcpy(ab->data, header, sizeof(header));
  ab->len = sizeof(header);
}

static int ab_reserve(ArgBuffer *ab, size_t extra) {
  size_t needed = ab->len + extra;
  if (needed <= ab->cap) {
    return 0;
  }
  size_t new_cap = ab->cap == 0 ? 256 : ab->cap;
  while (new_cap < needed) {
    new_cap *= 2;
  }
  uint8_t *next = (uint8_t *)realloc(ab->data, new_cap);
  if (!next) {
    return -1;
  }
  ab->data = next;
  ab->cap = new_cap;
  return 0;
}

static int ab_append(ArgBuffer *ab, const void *data, size_t len) {
  if (ab_reserve(ab, len) != 0) {
    return -1;
  }
  memcpy(ab->data + ab->len, data, len);
  ab->len += len;
  return 0;
}

static int ab_append_string(ArgBuffer *ab, const char *str, size_t len) {
  uint8_t header[4];
  write_u32_le(header, (uint32_t)len);
  if (ab_append(ab, header, sizeof(header)) != 0) {
    return -1;
  }
  return ab_append(ab, str, len);
}

/* Redis's double2ll (src/util.c): integral values with |d| <= LLONG_MAX/2 are
 * safe to print as integers. -0.0 passes (and prints as "0"); NaN fails. */
static int double2ll(double d, long long *out) {
  if (d < (double)(-LLONG_MAX / 2) || d > (double)(LLONG_MAX / 2)) {
    return 0;
  }
  long long ll = (long long)d;
  if (ll == d) {
    *out = ll;
    return 1;
  }
  return 0;
}

#define NUMBER_ARG_BUF 32 /* > fpconv_dtoa's 24 bytes and any %lld */

/* Number argument -> string like luaArgsToRedisArgv in Valkey 8.0's
 * src/script_lua.c, not lua_tolstring (whose "%.14g" loses precision):
 * integral values print as integers (1e15 -> "1000000000000000"), anything
 * else in the shortest round-trip form (fpconv_dtoa: 0.1+0.2 -> "0.30000000000000004",
 * 1e300 -> "1e+300", 1/0 -> "inf"). */
static size_t number_to_arg(lua_Number num, char buf[NUMBER_ARG_BUF]) {
  long long lvalue;
  if (double2ll((double)num, &lvalue)) {
    return (size_t)snprintf(buf, NUMBER_ARG_BUF, "%lld", lvalue);
  }
  return (size_t)fpconv_dtoa((double)num, buf);
}

static int arg_to_bytes(lua_State *L, int idx, char numbuf[NUMBER_ARG_BUF], const char **out,
                        size_t *len) {
  int type = lua_type(L, idx);
  switch (type) {
    case LUA_TNUMBER:
      *len = number_to_arg(lua_tonumber(L, idx), numbuf);
      *out = numbuf;
      return 0;
    case LUA_TSTRING:
      // Real Redis accepts only strings and numbers as command arguments.
      // Booleans, nil and tables are rejected by the caller.
      *out = lua_tolstring(L, idx, len);
      return 0;
    default:
      return -1;
  }
}

static int encode_args(lua_State *L, int start, int argc, ArgBuffer *ab) {
  ab_init(ab, (uint32_t)argc);
  if (!ab->data) {
    return -1;
  }
  for (int i = 0; i < argc; i++) {
    char numbuf[NUMBER_ARG_BUF];
    const char *data = NULL;
    size_t len = 0;
    if (arg_to_bytes(L, start + i, numbuf, &data, &len) != 0) {
      return -1;
    }
    if (ab_append_string(ab, data, len) != 0) {
      return -1;
    }
  }
  return 0;
}

static int push_status_table(lua_State *L, const uint8_t *data, uint32_t len) {
  lua_createtable(L, 0, 1);
  lua_pushlstring(L, (const char *)data, len);
  lua_setfield(L, -2, "ok");
  return 1;
}

static int push_error_table(lua_State *L, const uint8_t *data, uint32_t len) {
  lua_createtable(L, 0, 1);
  lua_pushlstring(L, (const char *)data, len);
  lua_setfield(L, -2, "err");
  return 1;
}

static int is_crlf(char c) {
  return c == '\r' || c == '\n';
}

/* Pushes {err="CODE message"} for an error reply in Redis's "-CODE message"
 * form, with the leading '-' already removed. Mirrors luaPushErrorBuff on that
 * form (derived from Valkey 8.0's src/script_lua.c, same in Redis 7.2.4,
 * BSD-3-Clause):
 * - with no space, the generic "ERR " code is prepended; otherwise the token
 *   before the first space is the error code, taken as-is (no case check);
 * - the text after the code is trimmed of '\r'/'\n' at both ends (sdstrim). */
static int push_error_reply(lua_State *L, const char *err, size_t len) {
  const char *code = "ERR";
  size_t code_len = 3;
  const char *msg = err;
  size_t msg_len = len;
  const char *space = memchr(err, ' ', len);
  if (space != NULL) {
    code = err;
    code_len = (size_t)(space - err);
    msg = space + 1;
    msg_len = len - code_len - 1;
  }
  while (msg_len > 0 && is_crlf(msg[0])) {
    msg++;
    msg_len--;
  }
  while (msg_len > 0 && is_crlf(msg[msg_len - 1])) {
    msg_len--;
  }

  luaL_Buffer b;
  luaL_buffinit(L, &b);
  luaL_addlstring(&b, code, code_len);
  luaL_addchar(&b, ' ');
  luaL_addlstring(&b, msg, msg_len);
  luaL_pushresult(&b);
  size_t out_len = 0;
  const char *out = lua_tolstring(L, -1, &out_len);
  return push_error_table(L, (const uint8_t *)out, (uint32_t)out_len);
}

/* A command error reply from the host. Table-error mode builds it like Redis
 * 7's redisProtocolToLuaType_Error: luaPushErrorBuff's form plus
 * ignore_error_stats_update=true, the same table whether redis.call raises it
 * or redis.pcall returns it. Otherwise it is kept verbatim: raised as a string
 * or returned as {err=...}, as in Redis 6.2.
 * Derived from redisProtocolToLuaType_Error in Valkey 8.0's src/script_lua.c
 * (same in Redis 7.2.4), BSD-3-Clause. */
static int push_command_error(lua_State *L, const uint8_t *data, uint32_t len,
                              int raise_on_error) {
  if (g_table_errors) {
    push_error_reply(L, (const char *)data, len);
    lua_pushboolean(L, 1);
    lua_setfield(L, -2, "ignore_error_stats_update");
    return raise_on_error ? lua_error(L) : 1;
  }
  if (raise_on_error) {
    lua_pushlstring(L, (const char *)data, len);
    return lua_error(L);
  }
  return push_error_table(L, data, len);
}

static int decode_reply(lua_State *L, const uint8_t *buf, size_t len, size_t *offset,
                        int raise_on_error, int depth) {
  /* Each level pushes up to 3 slots (a map's wrapper table, inner table and
   * key) before recursing: grow the Lua stack like redisProtocolToLuaType
   * instead of writing past its end, and cap the recursion depth. Redis panics
   * here; this runs under decode_reply_protected, so it surfaces as a normal
   * script error instead. */
  if (depth > REDIS_REPLY_MAX_DEPTH || !lua_checkstack(L, 3)) {
    return luaL_error(L, "ERR reached lua stack limit");
  }
  if (*offset + 5 > len) {
    return luaL_error(L, "ERR reply decoding failed");
  }
  uint8_t type = buf[*offset];
  uint32_t count_or_len = read_u32_le(buf + *offset + 1);
  *offset += 5;
  switch (type) {
    case REPLY_NULL:
      /* RESP null maps to Lua false at RESP2 and to nil after
       * redis.setresp(3), matching real Redis (redisProtocolToLuaType). */
      if (redis_resp_version() == 3) {
        lua_pushnil(L);
      } else {
        lua_pushboolean(L, 0);
      }
      return 1;
    case REPLY_INT: {
      if (*offset + 8 > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      int64_t value = read_i64_le(buf + *offset);
      *offset += 8;
      lua_pushnumber(L, (lua_Number)value);
      return 1;
    }
    case REPLY_BULK: {
      if (*offset + count_or_len > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      lua_pushlstring(L, (const char *)(buf + *offset), count_or_len);
      *offset += count_or_len;
      return 1;
    }
    case REPLY_STATUS: {
      if (*offset + count_or_len > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      int result = push_status_table(L, buf + *offset, count_or_len);
      *offset += count_or_len;
      return result;
    }
    case REPLY_ERROR: {
      if (*offset + count_or_len > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      const uint8_t *data = buf + *offset;
      *offset += count_or_len;
      return push_command_error(L, data, count_or_len, raise_on_error);
    }
    case REPLY_ARRAY: {
      /* At RESP3, lua_newtable like real Redis: with a nil hole, later
       * elements land in the hash part so # and unpack stop at the hole.
       * RESP2 has no nil holes, so preallocate to avoid rehashing. */
      if (redis_resp_version() == 3) {
        lua_newtable(L);
      } else {
        lua_createtable(L, (int)count_or_len, 0);
      }
      for (uint32_t i = 1; i <= count_or_len; i++) {
        if (decode_reply(L, buf, len, offset, raise_on_error, depth + 1) != 1) {
          return luaL_error(L, "ERR reply decoding failed");
        }
        lua_rawseti(L, -2, (int)i);
      }
      return 1;
    }
    case REPLY_BOOL:
      if (*offset + 1 > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      lua_pushboolean(L, buf[*offset] != 0);
      *offset += 1;
      return 1;
    case REPLY_DOUBLE:
      if (*offset + 8 > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      lua_createtable(L, 0, 1);
      lua_pushnumber(L, (lua_Number)read_f64_le(buf + *offset));
      lua_setfield(L, -2, "double");
      *offset += 8;
      return 1;
    case REPLY_BIG_NUMBER:
      if (*offset + count_or_len > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      lua_createtable(L, 0, 1);
      lua_pushlstring(L, (const char *)(buf + *offset), count_or_len);
      lua_setfield(L, -2, "big_number");
      *offset += count_or_len;
      return 1;
    case REPLY_VERBATIM: {
      size_t payload_end = *offset + count_or_len;
      if (count_or_len < 4 || payload_end > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      uint32_t format_len = read_u32_le(buf + *offset);
      *offset += 4;
      if (*offset + format_len > payload_end) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      size_t string_len = payload_end - *offset - format_len;
      lua_createtable(L, 0, 1);
      lua_createtable(L, 0, 2);
      lua_pushlstring(L, (const char *)(buf + *offset), format_len);
      lua_setfield(L, -2, "format");
      *offset += format_len;
      if (*offset + string_len > len) {
        return luaL_error(L, "ERR reply decoding failed");
      }
      lua_pushlstring(L, (const char *)(buf + *offset), string_len);
      lua_setfield(L, -2, "string");
      *offset = payload_end;
      lua_setfield(L, -2, "verbatim_string");
      return 1;
    }
    case REPLY_MAP:
      lua_createtable(L, 0, 1);
      lua_createtable(L, 0, (int)count_or_len);
      for (uint32_t i = 0; i < count_or_len; i++) {
        if (decode_reply(L, buf, len, offset, raise_on_error, depth + 1) != 1 ||
            decode_reply(L, buf, len, offset, raise_on_error, depth + 1) != 1) {
          return luaL_error(L, "ERR reply decoding failed");
        }
        lua_settable(L, -3);
      }
      lua_setfield(L, -2, "map");
      return 1;
    case REPLY_SET:
      lua_createtable(L, 0, 1);
      lua_createtable(L, 0, (int)count_or_len);
      for (uint32_t i = 0; i < count_or_len; i++) {
        if (decode_reply(L, buf, len, offset, raise_on_error, depth + 1) != 1) {
          return luaL_error(L, "ERR reply decoding failed");
        }
        lua_pushboolean(L, 1);
        lua_settable(L, -3);
      }
      lua_setfield(L, -2, "set");
      return 1;
    default:
      return luaL_error(L, "ERR unknown reply type");
  }
}

typedef struct {
  const uint8_t *buf;
  size_t len;
  int raise_on_error;
} DecodeCtx;

static int decode_reply_protected(lua_State *L) {
  DecodeCtx *ctx = (DecodeCtx *)lua_touserdata(L, 1);
  size_t offset = 0;
  return decode_reply(L, ctx->buf, ctx->len, &offset, ctx->raise_on_error, 0);
}

static int redis_call_common(lua_State *L, int raise_on_error) {
  int argc = lua_gettop(L);
  /* A zero-arg redis.call()/redis.pcall() is dispatched to the host with an
   * empty argument list so the host owns the exact error message and the
   * call/pcall distinction (raise_on_error) is preserved natively. */
  ArgBuffer ab;
  if (encode_args(L, 1, argc, &ab) != 0) {
    free(ab.data);
    // Coded kind, no name (Redis's wording for this takes no variable). Raised
    // without a "user_script:N:" position prefix, matching real Redis; the host
    // renders "Lua redis lib command arguments must be strings or integers".
    return redis_raise_engine_error(L, "__RLUA_E__:command-arg-type");
  }
  /* Record the caller exactly as Redis 6.2's luaPushError does: stack level 1
   * as-is, without skipping C frames, so pcall(redis.pcall, ...) reports
   * "=[C]" and line -1. ar.source stays valid for the duration of the call. */
  lua_Debug ar;
  g_call_source = NULL;
  g_call_line = 0;
  if (lua_getstack(L, 1, &ar) && lua_getinfo(L, "Sl", &ar)) {
    g_call_source = ar.source;
    g_call_line = (int32_t)ar.currentline;
  }
  PtrLen reply = raise_on_error ? host_redis_call((uint32_t)(uintptr_t)ab.data, (uint32_t)ab.len)
                                : host_redis_pcall((uint32_t)(uintptr_t)ab.data, (uint32_t)ab.len);
  g_call_source = NULL;
  g_call_line = 0;
  free(ab.data);
  if (reply.ptr == 0 || reply.len == 0) {
    return redis_raise_error(L, "ERR empty reply from host");
  }
  /* Decode in protected mode so the host reply is freed before any error
   * (command error, nil table key, decode failure) propagates to the script. */
  DecodeCtx ctx = {(const uint8_t *)(uintptr_t)reply.ptr, reply.len, raise_on_error};
  lua_pushvalue(L, lua_upvalueindex(1)); /* decode_reply_protected, created once */
  lua_pushlightuserdata(L, &ctx);
  int status = lua_pcall(L, 1, 1, 0);
  free_mem(reply.ptr);
  if (status != 0) {
    return lua_error(L);
  }
  return 1;
}

static int l_redis_call(lua_State *L) {
  return redis_call_common(L, 1);
}

static int l_redis_pcall(lua_State *L) {
  return redis_call_common(L, 0);
}

/* Registry slot (keyed by this variable's address) that carries a host failure
 * message out of stash_host_failure's protected call. */
static char g_host_failure_key;

typedef struct {
  const char *msg;
  size_t len;
} HostFailure;

/* lua_cpcall body: interns the host's message into the registry slot. */
static int stash_host_failure(lua_State *L) {
  HostFailure *failure = (HostFailure *)lua_touserdata(L, 1);
  lua_pushlightuserdata(L, &g_host_failure_key);
  lua_pushlstring(L, failure->msg, failure->len);
  lua_rawset(L, LUA_REGISTRYINDEX);
  return 0;
}

/* Raises the failure returned by a void-result host import (log, setresp) as
 * a normal Lua error. See the host import contract in abi.h. The message is
 * copied into Lua in protected mode so a memory error cannot skip freeing the
 * host's buffer; if the copy fails, that memory error is raised instead. */
static int raise_host_failure(lua_State *L, PtrLen failure) {
  if (failure.ptr == 0) {
    lua_pushliteral(L, "ERR host callback failed");
    return lua_error(L);
  }
  HostFailure copy = {(const char *)(uintptr_t)failure.ptr, failure.len};
  int status = lua_cpcall(L, stash_host_failure, &copy);
  free_mem(failure.ptr);
  if (status != 0) {
    return lua_error(L); /* the memory error is on the stack */
  }
  /* Move the message from the registry slot to the stack; neither step
   * allocates (the slot's key already exists). */
  lua_pushlightuserdata(L, &g_host_failure_key);
  lua_rawget(L, LUA_REGISTRYINDEX);
  lua_pushlightuserdata(L, &g_host_failure_key);
  lua_pushnil(L);
  lua_rawset(L, LUA_REGISTRYINDEX);
  return lua_error(L);
}

/* Raises a redis.log / redis.setresp argument error given without a code.
 * Redis 7.0+ raises these with luaPushError, which adds the generic ERR code;
 * Redis 6.2 raised the bare message string (lua_pushstring + lua_error), so
 * without table errors there is no code.
 * Derived from luaLogCommand / luaSetResp in Valkey 8.0's src/script_lua.c
 * (same in Redis 7.2.4) and Redis 6.2's src/scripting.c, BSD-3-Clause. */
static int raise_api_error(lua_State *L, const char *msg) {
  return redis_raise_error(L, g_table_errors ? lua_pushfstring(L, "ERR %s", msg) : msg);
}

/* redis.log(level, ...). Mirrors Redis's luaLogCommand (src/script_lua.c): the
 * level must be a number (numeric strings count, like lua_isnumber) truncated to
 * an int in 0..3, and every argument after it is converted with lua_tolstring
 * and joined with " ". Values lua_tolstring cannot convert (nil, booleans,
 * tables, ...) are skipped, with no separator of their own; a separator is
 * written before every converted argument except the first one after the level,
 * exactly as Redis does. Verbosity filtering is left to the host, which receives
 * every message.
 * The argument errors follow the profile's wording: Valkey 8.0+ names
 * "server.log()" in the arity error, and Redis 6.2-7.2 say "Invalid debug
 * level." (Redis 7.4 changed it to "Invalid log level.", as Valkey 8.0 did). */
static int l_redis_log(lua_State *L) {
  int argc = lua_gettop(L);
  if (argc < 2) {
    return raise_api_error(L, g_server_log_name ? "server.log() requires two arguments or more."
                                                : "redis.log() requires two arguments or more.");
  }
  if (!lua_isnumber(L, 1)) {
    return raise_api_error(L, "First argument must be a number (log level).");
  }
  /* Redis assigns the number to an int (truncation toward zero) and then checks
   * LL_DEBUG..LL_WARNING. Range-check the double first so NaN / huge values
   * never reach the float-to-int conversion (which traps in WASM). */
  lua_Number raw_level = lua_tonumber(L, 1);
  if (!(raw_level > -1 && raw_level < 4)) {
    return raise_api_error(L, g_log_debug_level ? "Invalid debug level." : "Invalid log level.");
  }
  int level = (int)raw_level;

  luaL_Buffer b;
  luaL_buffinit(L, &b);
  for (int j = 2; j <= argc; j++) {
    size_t len = 0;
    const char *s = lua_tolstring(L, j, &len);
    if (s) {
      if (j != 2) {
        luaL_addchar(&b, ' ');
      }
      luaL_addlstring(&b, s, len);
    }
  }
  luaL_pushresult(&b);
  size_t len = 0;
  const char *msg = lua_tolstring(L, -1, &len);
  PtrLen failure = host_redis_log((uint32_t)level, (uint32_t)(uintptr_t)msg, (uint32_t)len);
  if (failure.len != 0) {
    return raise_host_failure(L, failure);
  }
  return 0;
}

static int l_redis_sha1hex(lua_State *L) {
  size_t len = 0;
  const char *data = luaL_checklstring(L, 1, &len);
  PtrLen out = host_sha1hex((uint32_t)(uintptr_t)data, (uint32_t)len);
  if (out.ptr == 0 || out.len == 0) {
    return luaL_error(L, "ERR sha1hex failed");
  }
  lua_pushlstring(L, (const char *)(uintptr_t)out.ptr, out.len);
  free_mem(out.ptr);
  return 1;
}

/* redis.error_reply(msg) without table errors, like Redis 6.2's
 * luaRedisErrorReplyCommand (luaRedisReturnSingleFieldTable + luaPushError in
 * src/scripting.c, BSD-3-Clause):
 * - one string argument is returned unchanged as {err=msg} (binary-safe, no
 *   code added, no '-' dropped);
 * - anything else returns {err="<source>: <line>: wrong number or type of
 *   arguments"}, positioned at stack level 1 as-is (the script, or "=[C]" and
 *   -1 for a C caller such as pcall), without a code. */
static int l_redis_error_reply_legacy(lua_State *L) {
  if (lua_gettop(L) != 1 || lua_type(L, -1) != LUA_TSTRING) {
    static const char bad_args[] = "wrong number or type of arguments";
    lua_Debug ar;
    lua_createtable(L, 0, 1);
    if (lua_getstack(L, 1, &ar) && lua_getinfo(L, "Sl", &ar)) {
      lua_pushfstring(L, "%s: %d: %s", ar.source, ar.currentline, bad_args);
    } else {
      lua_pushstring(L, bad_args);
    }
    lua_setfield(L, -2, "err");
    return 1;
  }
  lua_createtable(L, 0, 1);
  lua_pushvalue(L, 1);
  lua_setfield(L, -2, "err");
  return 1;
}

/* redis.error_reply(msg). With table errors (Redis 7.0+ / Valkey), mirrors
 * luaRedisErrorReplyCommand + luaPushErrorBuff in Valkey 8.0's
 * src/script_lua.c (same in Redis 7.2.4), BSD-3-Clause; both came with the
 * Redis 7 error model (redis/redis#10329):
 * - anything but exactly one string argument returns (does not raise)
 *   {err="ERR wrong number or type of arguments"};
 * - the message is read as a C string (cut at the first NUL) and one leading
 *   '-' is dropped;
 * - the rest is split into code and message by push_error_reply.
 * Without table errors it behaves like Redis 6.2 (l_redis_error_reply_legacy). */
static int l_redis_error_reply(lua_State *L) {
  if (!g_table_errors) {
    return l_redis_error_reply_legacy(L);
  }
  if (lua_gettop(L) != 1 || lua_type(L, -1) != LUA_TSTRING) {
    static const char bad_args[] = "ERR wrong number or type of arguments";
    return push_error_table(L, (const uint8_t *)bad_args, (uint32_t)(sizeof(bad_args) - 1));
  }
  const char *err = lua_tostring(L, 1);
  size_t len = strlen(err);
  if (err[0] == '-') {
    err++;
    len--;
  }
  return push_error_reply(L, err, len);
}

static int l_redis_status_reply(lua_State *L) {
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 1, &len);
  return push_status_table(L, (const uint8_t *)msg, (uint32_t)len);
}

/* redis.setresp(2|3). An unsupported version raises "RESP version must be 2
 * or 3.", ERR-coded with table errors (Redis 7.0+) and bare as in Redis 6.2
 * (luaSetResp, see raise_api_error). */
static int l_redis_setresp(lua_State *L) {
  uint32_t next = (uint32_t)luaL_checkinteger(L, 1);
  if (next != 2 && next != 3) {
    return raise_api_error(L, "RESP version must be 2 or 3.");
  }
  /* Notify the host so it can match reply shapes; switch only if it accepted. */
  PtrLen failure = host_redis_setresp(next);
  if (failure.len != 0) {
    return raise_host_failure(L, failure);
  }
  g_resp_version = next;
  return 0;
}

static void set_log_constants(lua_State *L) {
  lua_pushnumber(L, LOG_DEBUG);
  lua_setfield(L, -2, "LOG_DEBUG");
  lua_pushnumber(L, LOG_VERBOSE);
  lua_setfield(L, -2, "LOG_VERBOSE");
  lua_pushnumber(L, LOG_NOTICE);
  lua_setfield(L, -2, "LOG_NOTICE");
  lua_pushnumber(L, LOG_WARNING);
  lua_setfield(L, -2, "LOG_WARNING");
}

/* Stub function bodies for host-injected props. l_const_return returns its single
 * upvalue (the configured constant); l_noop returns nothing. */
static int l_const_return(lua_State *L) {
  lua_pushvalue(L, lua_upvalueindex(1));
  return 1;
}

static int l_noop(lua_State *L) {
  (void)L;
  return 0;
}

/* redisProps wire kinds/value types. Mirrors src/codec.ts. */
#define PROP_KIND_FIELD 0
#define PROP_KIND_STUB 1
#define PROP_VTYPE_NONE 0
#define PROP_VTYPE_BOOL 1
#define PROP_VTYPE_NUMBER 2
#define PROP_VTYPE_STRING 3

int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len) {
  if (len < 4) {
    return 0; /* nothing to apply */
  }
  size_t off = 0;
  uint32_t count = read_u32_le(buf);
  off += 4;

  lua_getglobal(L, "redis");
  if (!lua_istable(L, -1)) {
    lua_pop(L, 1);
    return -1;
  }
  int redis_idx = lua_gettop(L);

  for (uint32_t i = 0; i < count; i++) {
    if (off > len || 4 > len - off) {
      lua_pop(L, 1);
      return -1;
    }
    uint32_t name_len = read_u32_le(buf + off);
    off += 4;
    if (off > len || name_len > len - off) {
      lua_pop(L, 1);
      return -1;
    }
    const char *name = (const char *)(buf + off);
    off += name_len;

    if (off > len || 2 > len - off) {
      lua_pop(L, 1);
      return -1;
    }
    uint8_t kind = buf[off++];
    uint8_t vtype = buf[off++];

    /* Push the value (constant, or the stub's return value). */
    switch (vtype) {
      case PROP_VTYPE_NONE:
        lua_pushnil(L);
        break;
      case PROP_VTYPE_BOOL:
        if (off > len || 1 > len - off) { lua_pop(L, 1); return -1; }
        lua_pushboolean(L, buf[off] != 0);
        off += 1;
        break;
      case PROP_VTYPE_NUMBER:
        if (off > len || 8 > len - off) { lua_pop(L, 1); return -1; }
        lua_pushnumber(L, (lua_Number)read_f64_le(buf + off));
        off += 8;
        break;
      case PROP_VTYPE_STRING: {
        if (off > len || 4 > len - off) { lua_pop(L, 1); return -1; }
        uint32_t vlen = read_u32_le(buf + off);
        off += 4;
        if (off > len || vlen > len - off) { lua_pop(L, 1); return -1; }
        lua_pushlstring(L, (const char *)(buf + off), vlen);
        off += vlen;
        break;
      }
      default:
        /* Pops the redis table itself; nothing else is on the stack here. */
        lua_pop(L, 1);
        return -1;
    }

    /* Stack: [redis, value]. For a stub, replace value with a closure. */
    if (kind == PROP_KIND_STUB) {
      if (vtype == PROP_VTYPE_NONE) {
        lua_pop(L, 1); /* drop the nil placeholder */
        lua_pushcclosure(L, l_noop, 0);
      } else {
        lua_pushcclosure(L, l_const_return, 1); /* consumes value as upvalue */
      }
    }

    /* redis[name] = top-of-stack, binary-safe name. */
    lua_pushlstring(L, name, name_len); /* [redis, val, name] */
    lua_insert(L, -2);                  /* [redis, name, val] */
    lua_settable(L, redis_idx);         /* pops name+val */
  }

  lua_pop(L, 1); /* pop redis */
  return 0;
}

/* Global pcall in table-error mode. Derived from luaRedisPcall in Valkey 8.0's
 * src/script_lua.c (same in Redis 7.2.4), BSD-3-Clause: errors are {err=...}
 * tables there, so for backward compatibility a caught table error whose `err`
 * is a string is returned as that string. Any other error value, and every
 * success, is returned as the stock pcall would. Unlike Redis, a table error without a string `err` is
 * returned alone, without the extra nil Redis leaves behind, and a call with no
 * arguments is rejected like the stock pcall instead of calling past the stack.
 * xpcall is untouched, as in Redis: its handler sees the raw table. */
static int l_pcall_unwrap(lua_State *L) {
  luaL_checkany(L, 1);
  int argc = lua_gettop(L);
  lua_pushboolean(L, 1); /* result placeholder */
  lua_insert(L, 1);
  if (lua_pcall(L, argc - 1, LUA_MULTRET, 0) != 0) {
    lua_remove(L, 1); /* the placeholder: room for at least one element */
    if (lua_istable(L, -1)) {
      lua_getfield(L, -1, "err");
      if (lua_isstring(L, -1)) {
        lua_replace(L, -2); /* replace the error table with its message */
      } else {
        lua_pop(L, 1);
      }
    }
    lua_pushboolean(L, 0);
    lua_insert(L, 1);
  }
  return lua_gettop(L);
}

void register_redis_api(lua_State *L) {
  g_table_errors = compat_table_errors();
  g_log_debug_level = compat_log_debug_level();
  g_server_log_name = compat_server_log_name();
  if (g_table_errors) {
    lua_pushcfunction(L, l_pcall_unwrap);
    lua_setglobal(L, "pcall");
  }

  lua_newtable(L);

  lua_pushcfunction(L, decode_reply_protected);
  lua_pushvalue(L, -1);
  lua_pushcclosure(L, l_redis_call, 1);
  lua_setfield(L, -3, "call");
  lua_pushcclosure(L, l_redis_pcall, 1);
  lua_setfield(L, -2, "pcall");

  lua_pushcfunction(L, l_redis_log);
  lua_setfield(L, -2, "log");

  lua_pushcfunction(L, l_redis_sha1hex);
  lua_setfield(L, -2, "sha1hex");

  lua_pushcfunction(L, l_redis_error_reply);
  lua_setfield(L, -2, "error_reply");

  lua_pushcfunction(L, l_redis_status_reply);
  lua_setfield(L, -2, "status_reply");

  lua_pushcfunction(L, l_redis_setresp);
  lua_setfield(L, -2, "setresp");

  set_log_constants(L);

  lua_setglobal(L, "redis");
}
