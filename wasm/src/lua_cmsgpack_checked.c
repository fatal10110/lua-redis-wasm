/* lua_cmsgpack with allocation failures made fatal.
 *
 * The vendored lua_cmsgpack.c (vendor/valkey/deps/lua/src, not modified here)
 * grows its pack buffer through the raw Lua allocator obtained from
 * lua_getallocf() and never checks for NULL. Redis gets away with that because
 * its allocator (zmalloc) aborts on OOM; this module is linked with
 * -sABORTING_MALLOC=0 so that Lua itself sees NULL and raises "not enough
 * memory", which would let cmsgpack.pack() write through a NULL buffer and
 * silently corrupt the heap.
 *
 * So compile cmsgpack against a lua_getallocf() that hands out a wrapper which
 * abort()s when a non-zero-size request fails, matching Redis's behavior. The
 * abort throws out of the WASM module; the JS engine treats that as a fault and
 * refuses further evaluations instead of running on a corrupted heap. */
#include <stdlib.h>

#include "lua.h"

static lua_Alloc g_real_alloc;
static void *g_real_alloc_ud;

static void *abort_on_oom_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
  (void)ud;
  void *out = g_real_alloc(g_real_alloc_ud, ptr, osize, nsize);
  if (out == NULL && nsize != 0) {
    abort();
  }
  return out;
}

static lua_Alloc checked_getallocf(lua_State *L, void **ud) {
  g_real_alloc = lua_getallocf(L, &g_real_alloc_ud);
  *ud = NULL;
  return abort_on_oom_alloc;
}

/* lua.h is include-guarded, so the vendored file's own #include "lua.h" does not
 * redeclare lua_getallocf under this macro. */
#define lua_getallocf checked_getallocf
#include "lua_cmsgpack.c"
#undef lua_getallocf
