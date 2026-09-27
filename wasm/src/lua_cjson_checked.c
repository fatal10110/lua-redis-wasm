/* lua_cjson with a record of the running thread, for strbuf_checked.c.
 *
 * The vendored lua_cjson.c (vendor/redis/deps/lua/src, not modified here)
 * builds its output and scratch strings in strbufs. The vendored strbuf.c
 * aborts when malloc fails, and a Lua error raised while a strbuf is live (e.g.
 * "not enough memory" at maxMemoryBytes while decode pushes values) leaks it.
 * This build replaces strbuf.c with strbuf_checked.c, which allocates through
 * the Lua allocator, tracks its blocks and raises Lua's memory error instead of
 * aborting. Raising needs the lua_State of the running cjson function, which
 * the strbuf API does not pass, so it is recorded here:
 *
 * - every cjson entry point fetches its config with lua_touserdata() (via
 *   json_fetch_config) before it touches a strbuf, and the config constructor
 *   calls lua_newuserdata() first;
 * - the only call that can run Lua code in the middle of an encode is the
 *   lua_getfield() of `__is_cjson_array` (an __index metamethod on the
 *   metatable), which may run cjson on another coroutine, so the record is
 *   restored right after it.
 *
 * GC finalizers (json_destroy_config) run on the allocating thread and record
 * that same thread. */
#include "lua.h"
#include "lua_modules.h"

static lua_State *g_cjson_state = NULL;

lua_State *cjson_current_state(void) {
  return g_cjson_state;
}

#define lua_touserdata(L, idx) (g_cjson_state = (L), (lua_touserdata)((L), (idx)))
#define lua_newuserdata(L, size) (g_cjson_state = (L), (lua_newuserdata)((L), (size)))
#define lua_getfield(L, idx, k) ((lua_getfield)((L), (idx), (k)), (void)(g_cjson_state = (L)))

#include "lua_cjson.c"

#undef lua_touserdata
#undef lua_newuserdata
#undef lua_getfield
