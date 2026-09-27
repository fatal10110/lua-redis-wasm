/* Glue between the runtime and the C modules (cjson, cmsgpack) compiled
 * against checked allocators. See lua_cmsgpack_checked.c, lua_cjson_checked.c
 * and strbuf_checked.c. */
#ifndef REDIS_LUA_WASM_LUA_MODULES_H
#define REDIS_LUA_WASM_LUA_MODULES_H

#include <stddef.h>

#include "lua.h"

/* The Lua state's allocator (runtime.c): counts toward maxMemoryBytes and, while
 * a script runs, refuses growth past it. lua_Alloc semantics without `ud`. */
void *lua_heap_alloc(void *ptr, size_t osize, size_t nsize);

/* Frees the buffers a cmsgpack / cjson call abandoned when it raised an error,
 * and shrinks cjson's kept encode buffer. Called only when no script runs. */
void cmsgpack_release_buffers(void);
void cjson_release_buffers(void);

/* The thread running the current cjson C function (lua_cjson_checked.c), on
 * which strbuf_checked.c raises its memory errors; NULL before any call. */
lua_State *cjson_current_state(void);

#endif
