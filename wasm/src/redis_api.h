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

/* Decodes the host_redis_props blob and assigns each entry onto the global
 * `redis` table. Returns 0 on success, -1 on a malformed blob. */
int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);

#endif /* REDIS_LUA_WASM_REDIS_API_H */
