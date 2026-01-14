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
      *out = lua_tolstring(L, idx, len);
      return 0;
    }
    case LUA_TBOOLEAN: {
      if (lua_toboolean(L, idx)) {
        *out = "1";
        *len = 1;
      } else {
        *out = "0";
        *len = 1;
      }
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
      lua_pushnil(L);
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
    default:
      return luaL_error(L, "ERR unknown reply type");
  }
}

static int redis_call_common(lua_State *L, int raise_on_error) {
  int argc = lua_gettop(L);
  if (argc == 0) {
    return luaL_error(L, "ERR redis.call requires arguments");
  }
  ArgBuffer ab;
  if (encode_args(L, 1, argc, &ab) != 0) {
    free(ab.data);
    return luaL_error(L, "ERR invalid argument to redis.call");
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

static int l_redis_error_reply(lua_State *L) {
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 1, &len);
  return push_error_table(L, (const uint8_t *)msg, (uint32_t)len);
}

static int l_redis_status_reply(lua_State *L) {
  size_t len = 0;
  const char *msg = luaL_checklstring(L, 1, &len);
  return push_status_table(L, (const uint8_t *)msg, (uint32_t)len);
}

static int l_redis_setresp(lua_State *L) {
  uint32_t prev = g_resp_version;
  g_resp_version = (uint32_t)luaL_checkinteger(L, 1);
  lua_pushnumber(L, (lua_Number)prev);
  return 1;
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
