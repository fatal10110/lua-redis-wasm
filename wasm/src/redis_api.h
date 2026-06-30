#ifndef REDIS_LUA_WASM_REDIS_API_H
#define REDIS_LUA_WASM_REDIS_API_H

#include <lua.h>
#include <stddef.h>
#include <stdint.h>

void register_redis_api(lua_State *L);

/* Decodes the host_redis_props blob and assigns each entry onto the global
 * `redis` table. Returns 0 on success, -1 on a malformed blob. */
int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);

#endif /* REDIS_LUA_WASM_REDIS_API_H */
