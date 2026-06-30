#include "../include/abi.h"
#include "redis_api.h"
#include <lauxlib.h>
#include <lua.h>
#include <lualib.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_FUEL_LIMIT 10000000
#define FUEL_HOOK_STEP 1000

typedef struct ReplyBuffer {
  uint8_t *data;
  size_t len;
  size_t cap;
} ReplyBuffer;

static lua_State *g_state = NULL;
static int64_t g_fuel_remaining = DEFAULT_FUEL_LIMIT;
static int64_t g_fuel_limit = DEFAULT_FUEL_LIMIT;
static uint32_t g_max_reply_bytes = 0;
static uint32_t g_max_arg_bytes = 0;

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

static void rb_init(ReplyBuffer *rb) {
  rb->data = NULL;
  rb->len = 0;
  rb->cap = 0;
}

static int rb_reserve(ReplyBuffer *rb, size_t extra) {
  size_t needed = rb->len + extra;
  if (needed <= rb->cap) {
    return 0;
  }
  size_t new_cap = rb->cap == 0 ? 256 : rb->cap;
  while (new_cap < needed) {
    new_cap *= 2;
  }
  uint8_t *next = (uint8_t *)realloc(rb->data, new_cap);
  if (!next) {
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

static PtrLen rb_finalize(ReplyBuffer *rb) {
  PtrLen out = {0, 0};
  if (!rb->data || rb->len == 0) {
    return out;
  }
  void *mem = malloc(rb->len);
  if (!mem) {
    return out;
  }
  memcpy(mem, rb->data, rb->len);
  out.ptr = (uint32_t)(uintptr_t)mem;
  out.len = (uint32_t)rb->len;
  return out;
}

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
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  return out;
}

/* Like reply_error, but tags the reply as a script-aborting error so the host
 * decorates it with the script sha / source context. Used for load and runtime
 * (lua_pcall) failures, including errors that propagated out of redis.call. */
static PtrLen reply_script_error(const char *msg, size_t len) {
  ReplyBuffer rb;
  rb_init(&rb);
  if (rb_write_header(&rb, REPLY_SCRIPT_ERROR, (uint32_t)len) != 0) {
    return (PtrLen){0, 0};
  }
  if (rb_append(&rb, msg, len) != 0) {
    free(rb.data);
    return (PtrLen){0, 0};
  }
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  return out;
}

static PtrLen reply_null(void) {
  ReplyBuffer rb;
  rb_init(&rb);
  if (rb_write_header(&rb, REPLY_NULL, 0) != 0) {
    return (PtrLen){0, 0};
  }
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  return out;
}

static PtrLen reply_status(const char *msg, size_t len) {
  ReplyBuffer rb;
  rb_init(&rb);
  if (rb_write_header(&rb, REPLY_STATUS, (uint32_t)len) != 0) {
    return (PtrLen){0, 0};
  }
  if (rb_append(&rb, msg, len) != 0) {
    free(rb.data);
    return (PtrLen){0, 0};
  }
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  return out;
}

static int encode_lua_value(lua_State *L, int idx, ReplyBuffer *rb);

static int encode_table(lua_State *L, int idx, ReplyBuffer *rb) {
  size_t len = 0;
  const char *msg = NULL;

  // Redis checks `err` before `ok`: a table carrying both fields is an error.
  lua_getfield(L, idx, "err");
  if (lua_isstring(L, -1)) {
    msg = lua_tolstring(L, -1, &len);
    int rc = rb_write_header(rb, REPLY_ERROR, (uint32_t)len);
    if (rc == 0) {
      rc = rb_append(rb, msg, len);
    }
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

  lua_getfield(L, idx, "ok");
  if (lua_isstring(L, -1)) {
    msg = lua_tolstring(L, -1, &len);
    int rc = rb_write_header(rb, REPLY_STATUS, (uint32_t)len);
    if (rc == 0) {
      rc = rb_append(rb, msg, len);
    }
    lua_pop(L, 1);
    return rc;
  }
  lua_pop(L, 1);

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
    if (encode_lua_value(L, -1, rb) != 0) {
      lua_pop(L, 1);
      return -1;
    }
    lua_pop(L, 1);
  }
  return 0;
}

static int encode_lua_value(lua_State *L, int idx, ReplyBuffer *rb) {
  int type = lua_type(L, idx);
  switch (type) {
    case LUA_TNIL:
      return rb_write_header(rb, REPLY_NULL, 0);
    case LUA_TNUMBER: {
      // Real Redis converts a Lua number return value to an integer reply,
      // truncating any fractional part (e.g. `return 3.7` -> 3).
      lua_Number num = lua_tonumber(L, idx);
      if (rb_write_header(rb, REPLY_INT, 8) != 0) {
        return -1;
      }
      uint8_t payload[8];
      write_i64_le(payload, (int64_t)num);
      return rb_append(rb, payload, sizeof(payload));
    }
    case LUA_TBOOLEAN:
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
      return encode_table(L, idx, rb);
    default:
      return -1;
  }
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

static void disable_non_determinism(lua_State *L) {
  remove_global(L, "io");
  remove_global(L, "os");
  remove_global(L, "debug");
  remove_global(L, "package");
  remove_global(L, "require");
  remove_global(L, "dofile");
  remove_global(L, "loadfile");
  // Base-lib globals real Redis does not expose to scripts. With globals
  // protection installed, accessing these raises the nonexistent-global error.
  remove_global(L, "print");
  remove_global(L, "loadstring");
  remove_global(L, "collectgarbage");
  remove_global(L, "gcinfo");
  remove_global(L, "newproxy");
  // Sandbox-escape vectors: setfenv swaps the running function's environment
  // for a writable table and getfenv(0) reaches the real global table,
  // bypassing globals protection. Redis removes these too (lua_builtins_deprecated).
  remove_global(L, "setfenv");
  remove_global(L, "getfenv");
  remove_package_entry(L, "io");
  remove_package_entry(L, "os");
  remove_package_entry(L, "debug");
  remove_package_entry(L, "package");
  lua_getglobal(L, "math");
  if (lua_istable(L, -1)) {
    lua_pushnil(L);
    lua_setfield(L, -2, "random");
    lua_pushnil(L);
    lua_setfield(L, -2, "randomseed");
  }
  lua_pop(L, 1);
}

// Globals protection: mirror real Redis exactly.
//
// READ of a nonexistent global -> a metatable __index handler (this function)
// raises, matching Redis's luaSetErrorMetatable. We control this string, so we
// emit a coded marker `__RLUA_E__:global-read:<name>`; the TS layer forwards
// { kind, name } and the host picks the wording. `name` is the __index key
// (stack index 2).
//
// WRITE of any global (creation or reassignment of an existing one) -> the
// patched Lua's native readonly flag (lua_enablereadonlytable), enabled in
// enable_globals_protection below. The VM raises "Attempt to modify a readonly
// table" itself; that string is Redis's own (vendored), so it passes through
// untouched. The flag blocks every write, including reassigning an existing
// global -- which a __newindex metatable would miss.
static int protect_globals_index(lua_State *L) {
  const char *name = lua_tostring(L, 2);
  return luaL_error(L, "__RLUA_E__:global-read:%s", name ? name : "?");
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
// mutating e.g. the shared string metatable. Mirrors Redis's
// luaSetTableProtectionForBasicTypes.
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

static void open_allowed_libs(lua_State *L) {
  // luaopen_base pushes TWO tables (the globals table and the coroutine table);
  // the rest push one. Clear the stack afterwards so no library table is left
  // behind to masquerade as a script return value.
  luaopen_base(L);
  luaopen_table(L);
  luaopen_string(L);
  luaopen_math(L);
  lua_settop(L, 0);
  disable_non_determinism(L);
  load_redis_modules(L);
}

static void fuel_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  g_fuel_remaining -= FUEL_HOOK_STEP;
  if (g_fuel_remaining <= 0) {
    luaL_error(L, "Script killed by fuel limit");
  }
}

static void reset_fuel(void) {
  g_fuel_remaining = g_fuel_limit;
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

int32_t init(void) {
  if (g_state) {
    lua_close(g_state);
    g_state = NULL;
  }
  g_state = luaL_newstate();
  if (!g_state) {
    return -1;
  }
  open_allowed_libs(g_state);
  register_redis_api(g_state);
  {
    PtrLen props = host_redis_props();
    if (props.ptr && props.len) {
      int rc = apply_redis_props(g_state, (const uint8_t *)(uintptr_t)props.ptr,
                                 (size_t)props.len);
      free_mem(props.ptr);
      if (rc != 0) {
        return -1;
      }
    }
  }
  /* Redis 7.4+ exposes `server` as an alias of `redis`; same table reference so
   * both share the host-injected props. Must run before protection locks them. */
  lua_getglobal(g_state, "redis");
  lua_setglobal(g_state, "server");
  enable_globals_protection(g_state);
  lua_sethook(g_state, fuel_hook, LUA_MASKCOUNT, FUEL_HOOK_STEP);
  reset_fuel();
  return 0;
}

int32_t reset(void) {
  if (!g_state) {
    return -1;
  }
  lua_close(g_state);
  g_state = luaL_newstate();
  if (!g_state) {
    return -1;
  }
  open_allowed_libs(g_state);
  register_redis_api(g_state);
  {
    PtrLen props = host_redis_props();
    if (props.ptr && props.len) {
      int rc = apply_redis_props(g_state, (const uint8_t *)(uintptr_t)props.ptr,
                                 (size_t)props.len);
      free_mem(props.ptr);
      if (rc != 0) {
        return -1;
      }
    }
  }
  /* Redis 7.4+ exposes `server` as an alias of `redis`; same table reference so
   * both share the host-injected props. Must run before protection locks them. */
  lua_getglobal(g_state, "redis");
  lua_setglobal(g_state, "server");
  enable_globals_protection(g_state);
  lua_sethook(g_state, fuel_hook, LUA_MASKCOUNT, FUEL_HOOK_STEP);
  reset_fuel();
  return 0;
}

PtrLen eval(uint32_t ptr, uint32_t len) {
  if (!g_state) {
    return reply_error("ERR Lua VM not initialized", 26);
  }
  reset_fuel();
  set_empty_keys_argv(g_state);
  const char *script = (const char *)(uintptr_t)ptr;
  if (luaL_loadbuffer(g_state, script, (size_t)len, "@user_script") != 0) {
    size_t err_len = 0;
    const char *err = lua_tolstring(g_state, -1, &err_len);
    PtrLen out = reply_script_error(err ? err : "ERR script load failed", err ? err_len : 23);
    lua_settop(g_state, 0);
    return out;
  }
  if (lua_pcall(g_state, 0, LUA_MULTRET, 0) != 0) {
    size_t err_len = 0;
    const char *err = lua_tolstring(g_state, -1, &err_len);
    PtrLen out = reply_script_error(err ? err : "ERR script execution failed", err ? err_len : 28);
    lua_settop(g_state, 0);
    return out;
  }
  int top = lua_gettop(g_state);
  if (top == 0) {
    // A script with no return value replies with nil, matching real Redis.
    return reply_null();
  }
  ReplyBuffer rb;
  rb_init(&rb);
  if (encode_lua_value(g_state, -1, &rb) != 0) {
    lua_settop(g_state, 0);
    free(rb.data);
    return reply_error("ERR unsupported Lua return type", 32);
  }
  if (g_max_reply_bytes > 0 && rb.len > g_max_reply_bytes) {
    lua_settop(g_state, 0);
    free(rb.data);
    return reply_error("ERR reply exceeds configured limit", 34);
  }
  lua_settop(g_state, 0);
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  if (out.ptr == 0) {
    return reply_error("ERR reply encoding failed", 26);
  }
  return out;
}

PtrLen eval_with_args(uint32_t script_ptr, uint32_t script_len, uint32_t args_ptr,
                      uint32_t args_len, uint32_t keys_count) {
  if (!g_state) {
    return reply_error("ERR Lua VM not initialized", 26);
  }
  reset_fuel();
  if (g_max_arg_bytes > 0 && args_len > g_max_arg_bytes) {
    return reply_error("ERR KEYS/ARGV exceeds configured limit", 40);
  }
  const uint8_t *args = (const uint8_t *)(uintptr_t)args_ptr;
  if (set_keys_argv(g_state, args, (size_t)args_len, keys_count) != 0) {
    lua_settop(g_state, 0);
    return reply_error("ERR invalid KEYS/ARGV encoding", 31);
  }
  const char *script = (const char *)(uintptr_t)script_ptr;
  if (luaL_loadbuffer(g_state, script, (size_t)script_len, "@user_script") != 0) {
    size_t err_len = 0;
    const char *err = lua_tolstring(g_state, -1, &err_len);
    PtrLen out = reply_script_error(err ? err : "ERR script load failed", err ? err_len : 23);
    lua_settop(g_state, 0);
    return out;
  }
  if (lua_pcall(g_state, 0, LUA_MULTRET, 0) != 0) {
    size_t err_len = 0;
    const char *err = lua_tolstring(g_state, -1, &err_len);
    PtrLen out = reply_script_error(err ? err : "ERR script execution failed", err ? err_len : 28);
    lua_settop(g_state, 0);
    return out;
  }
  int top = lua_gettop(g_state);
  if (top == 0) {
    // A script with no return value replies with nil, matching real Redis.
    return reply_null();
  }
  ReplyBuffer rb;
  rb_init(&rb);
  if (encode_lua_value(g_state, -1, &rb) != 0) {
    lua_settop(g_state, 0);
    free(rb.data);
    return reply_error("ERR unsupported Lua return type", 32);
  }
  if (g_max_reply_bytes > 0 && rb.len > g_max_reply_bytes) {
    lua_settop(g_state, 0);
    free(rb.data);
    return reply_error("ERR reply exceeds configured limit", 34);
  }
  lua_settop(g_state, 0);
  PtrLen out = rb_finalize(&rb);
  free(rb.data);
  if (out.ptr == 0) {
    return reply_error("ERR reply encoding failed", 26);
  }
  return out;
}

uint32_t alloc(uint32_t size) {
  void *mem = malloc(size);
  return (uint32_t)(uintptr_t)mem;
}

void free_mem(uint32_t ptr) {
  void *mem = (void *)(uintptr_t)ptr;
  free(mem);
}
