#ifndef REDIS_LUA_WASM_REDIS_MATH_H
#define REDIS_LUA_WASM_REDIS_MATH_H

#include <lua.h>

/* Replaces math.random / math.randomseed on the global `math` table with the
 * Redis PRNG versions. Must run before globals protection locks `math`. */
void register_redis_math(lua_State *L);

/* Reseeds the PRNG with 0, as Redis 6.2 did before every script. */
void redis_math_reseed(void);

#endif /* REDIS_LUA_WASM_REDIS_MATH_H */
