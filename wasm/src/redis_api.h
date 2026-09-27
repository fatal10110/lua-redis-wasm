#ifndef REDIS_LUA_WASM_REDIS_API_H
#define REDIS_LUA_WASM_REDIS_API_H

#include <lua.h>
#include <stddef.h>
#include <stdint.h>

/* Maximum nesting depth of a reply crossing the host boundary, in either
 * direction (script return value -> host, host reply -> Lua). Real Redis has
 * no explicit cap: it only stops when lua_checkstack cannot grow the Lua stack
 * (LUAI_MAXCSTACK, 8000 slots). Both conversions here recurse on the native
 * WASM stack, and the JS host encodes/decodes replies recursively, which
 * overflows at a few thousand levels; so cap well below that. Exceeding it
 * fails like the Lua stack limit: "reached lua stack limit". */
#define REDIS_REPLY_MAX_DEPTH 1000

void register_redis_api(lua_State *L);
uint32_t redis_resp_version(void);
void redis_reset_resp_version(void);

/* Whether the Redis 7 error model is selected (COMPAT_TABLE_ERRORS, defined in
 * runtime.c): errors are raised as {err=...} tables and the global pcall
 * unwraps them (Redis 7.0+, Valkey); otherwise they are plain strings (Redis
 * 6.2). register_redis_api snapshots it when a state is set up. */
int compat_table_errors(void);

/* redis.log error wording of the selected profile (COMPAT_LOG_DEBUG_LEVEL /
 * COMPAT_SERVER_LOG_NAME, defined in runtime.c): Redis 6.2-7.2 say
 * "Invalid debug level.", Valkey 8.0+ names "server.log()" in the arity error.
 * Snapshot by register_redis_api like compat_table_errors. */
int compat_log_debug_level(void);
int compat_server_log_name(void);

/* Raises `msg` ("CODE message") as a script error in the error model of the
 * current state: {err=msg} with table errors, the string itself otherwise.
 * Never returns. */
int redis_raise_error(lua_State *L, const char *msg);

/* Decodes the host_redis_props blob and assigns each entry onto the global
 * `redis` table. Returns 0 on success, -1 on a malformed blob. */
int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);

#endif /* REDIS_LUA_WASM_REDIS_API_H */
