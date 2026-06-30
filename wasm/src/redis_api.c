#include "../include/abi.h"
#include "redis_api.h"
#include <lauxlib.h>
#include <lua.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define LOG_DEBUG 0
#define LOG_VERBOSE 1
#define LOG_NOTICE 2
#define LOG_WARNING 3

static uint32_t g_resp_version = 2;

uint32_t redis_resp_version(void) {
  return g_resp_version;
}

void redis_reset_resp_version(void) {
  g_resp_version = 2;
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

static int arg_to_bytes(lua_State *L, int idx, const char **out, size_t *len) {
  int type = lua_type(L, idx);
  switch (type) {
    case LUA_TSTRING:
    case LUA_TNUMBER: {
      // Real Redis accepts only strings and numbers as command arguments;
      // numbers are stringified (e.g. 3.3 -> "3.3"). Booleans, nil and tables
      // are rejected by the caller.
      *out = lua_tolstring(L, idx, len);
      return 0;
    }
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
    const char *data = NULL;
    size_t len = 0;
    if (arg_to_bytes(L, start + i, &data, &len) != 0) {
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

static int decode_reply(lua_State *L, const uint8_t *buf, size_t len, size_t *offset,
                        int raise_on_error) {
  if (*offset + 5 > len) {
    return luaL_error(L, "ERR reply decoding failed");
  }
  uint8_t type = buf[*offset];
  uint32_t count_or_len = read_u32_le(buf + *offset + 1);
  *offset += 5;
  switch (type) {
    case REPLY_NULL:
      /* RESP null (bulk/multibulk) maps to Lua false, matching real Redis
       * (redisProtocolToLuaType). This is the call path only; the return
       * path still maps nil/false -> null. */
      lua_pushboolean(L, 0);
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
      if (raise_on_error) {
        lua_pushlstring(L, (const char *)(buf + *offset), count_or_len);
        *offset += count_or_len;
        return lua_error(L);
      }
      int result = push_error_table(L, buf + *offset, count_or_len);
      *offset += count_or_len;
      return result;
    }
    case REPLY_ARRAY: {
      lua_createtable(L, (int)count_or_len, 0);
      for (uint32_t i = 1; i <= count_or_len; i++) {
        if (decode_reply(L, buf, len, offset, raise_on_error) != 1) {
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
        if (decode_reply(L, buf, len, offset, raise_on_error) != 1 ||
            decode_reply(L, buf, len, offset, raise_on_error) != 1) {
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
        if (decode_reply(L, buf, len, offset, raise_on_error) != 1) {
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
    lua_pushliteral(L, "__RLUA_E__:command-arg-type");
    return lua_error(L);
  }
  PtrLen reply = raise_on_error ? host_redis_call((uint32_t)(uintptr_t)ab.data, (uint32_t)ab.len)
                                : host_redis_pcall((uint32_t)(uintptr_t)ab.data, (uint32_t)ab.len);
  free(ab.data);
  if (reply.ptr == 0 || reply.len == 0) {
    return luaL_error(L, "ERR empty reply from host");
  }
  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  size_t offset = 0;
  int result = decode_reply(L, buf, reply.len, &offset, raise_on_error);
  free_mem(reply.ptr);
  return result;
}

static int l_redis_call(lua_State *L) {
  return redis_call_common(L, 1);
}

static int l_redis_pcall(lua_State *L) {
  return redis_call_common(L, 0);
}

static int l_redis_log(lua_State *L) {
  int argc = lua_gettop(L);
  if (argc < 2) {
    return luaL_error(L, "ERR redis.log requires level and message");
  }
  int level = (int)luaL_checkinteger(L, 1);
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 2, &len);
  host_redis_log((uint32_t)level, (uint32_t)(uintptr_t)msg, (uint32_t)len);
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

// Tests whether the message opens with a Redis error code: a space-terminated
// leading token matching `[A-Z][A-Z0-9]*`. Mirrors isErrorCode in src/codec.ts.
static int has_error_code(const char *msg, size_t len) {
  const char *space = memchr(msg, ' ', len);
  if (space == NULL || space == msg) {
    return 0;
  }
  for (const char *p = msg; p < space; p++) {
    unsigned char c = (unsigned char)*p;
    int is_upper = c >= 'A' && c <= 'Z';
    int is_digit = c >= '0' && c <= '9';
    if (!is_upper && !(p > msg && is_digit)) {
      return 0;
    }
  }
  return 1;
}

static int l_redis_error_reply(lua_State *L) {
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 1, &len);
  // Real Redis prepends the default "ERR " code when the message does not already
  // begin with an uppercase error code (the leading token before the first space).
  if (!has_error_code(msg, len)) {
    lua_pushliteral(L, "ERR ");
    lua_pushvalue(L, 1);
    lua_concat(L, 2);
    msg = lua_tolstring(L, -1, &len);
  }
  return push_error_table(L, (const uint8_t *)msg, (uint32_t)len);
}

static int l_redis_status_reply(lua_State *L) {
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 1, &len);
  return push_status_table(L, (const uint8_t *)msg, (uint32_t)len);
}

static int l_redis_setresp(lua_State *L) {
  uint32_t next = (uint32_t)luaL_checkinteger(L, 1);
  if (next != 2 && next != 3) {
    return luaL_error(L, "ERR RESP version must be 2 or 3.");
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

void register_redis_api(lua_State *L) {
  lua_newtable(L);

  lua_pushcfunction(L, l_redis_call);
  lua_setfield(L, -2, "call");

  lua_pushcfunction(L, l_redis_pcall);
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
