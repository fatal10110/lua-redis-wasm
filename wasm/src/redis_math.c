/* math.random / math.randomseed backed by Redis's PRNG.
 *
 * Redis replaces Lua's math.random and math.randomseed, which use the libc
 * rand()/srand(), with versions driven by redisLrand48()/redisSrand48()
 * (vendor/redis/src/rand.c, compiled as is), so a seed yields the same sequence
 * on every platform. The functions below are Lua 5.1's math_random and
 * math_randomseed (vendor/redis/deps/lua/src/lmathlib.c) with exactly that
 * substitution, which is also how Redis derives its own.
 *
 * The generator state lives in rand.c's statics, outside the Lua VM: like the
 * Redis process-wide state it survives a VM reset. Redis 7.0+ never reseeds it,
 * so the sequence continues across scripts from the initial state; Redis 6.2
 * reseeded it with 0 before every script (see redis_math_reseed). */
#include "redis_math.h"

#include <lauxlib.h>
#include <math.h>
#include <stdint.h>

#include "rand.h"

static int redis_math_random(lua_State *L) {
  /* the `%' avoids the (rare) case of r==1 */
  lua_Number r = (lua_Number)(redisLrand48() % REDIS_LRAND48_MAX) / (lua_Number)REDIS_LRAND48_MAX;
  switch (lua_gettop(L)) { /* check number of arguments */
    case 0: {              /* no arguments */
      lua_pushnumber(L, r); /* Number between 0 and 1 */
      break;
    }
    case 1: { /* only upper limit */
      int u = luaL_checkint(L, 1);
      luaL_argcheck(L, 1 <= u, 1, "interval is empty");
      lua_pushnumber(L, floor(r * u) + 1); /* int between 1 and `u' */
      break;
    }
    case 2: { /* lower and upper limits */
      int l = luaL_checkint(L, 1);
      int u = luaL_checkint(L, 2);
      luaL_argcheck(L, l <= u, 2, "interval is empty");
      lua_pushnumber(L, floor(r * (u - l + 1)) + l); /* int between `l' and `u' */
      break;
    }
    default:
      return luaL_error(L, "wrong number of arguments");
  }
  return 1;
}

static int redis_math_randomseed(lua_State *L) {
  redisSrand48(luaL_checkint(L, 1));
  return 0;
}

void register_redis_math(lua_State *L) {
  lua_getglobal(L, "math");
  lua_pushcfunction(L, redis_math_random);
  lua_setfield(L, -2, "random");
  lua_pushcfunction(L, redis_math_randomseed);
  lua_setfield(L, -2, "randomseed");
  lua_pop(L, 1);
}

void redis_math_reseed(void) { redisSrand48(0); }
