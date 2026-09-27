/* lua_cmsgpack with allocation failures raised as Lua memory errors.
 *
 * The vendored lua_cmsgpack.c (vendor/redis/deps/lua/src, not modified here)
 * grows its pack buffer through the raw Lua allocator obtained from
 * lua_getallocf() and never checks for NULL. Redis gets away with that because
 * its allocator (zmalloc) aborts on OOM. Here the Lua allocator returns NULL
 * both when the fixed WASM heap is exhausted (-sABORTING_MALLOC=0) and when
 * maxMemoryBytes is reached, so cmsgpack.pack() would write through a NULL
 * buffer and silently corrupt the heap.
 *
 * So compile cmsgpack against a lua_getallocf() that hands out a wrapper which
 * never returns NULL for a non-zero request: it raises Lua's own "not enough
 * memory" error instead (luaD_throw(LUA_ERRMEM), exactly what the Lua core
 * does when an allocation fails), so the script gets an ordinary error and the
 * engine stays usable.
 *
 * Raising unwinds the cmsgpack C frames that own the pack buffer, which would
 * leak it. Every block handed out is therefore kept on a list, and
 * cmsgpack_release_buffers() frees whatever is still on it once the script has
 * finished (no pack can be in progress then: it runs in a C function and cannot
 * yield). The blocks go through the Lua allocator, so they count toward
 * maxMemoryBytes, which also bounds what a failed pack can hold on to while the
 * script keeps running. */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "lua.h"

/* Lua core (ldo.c): raises `errcode` on L like a failed allocation does.
 * Declared here rather than via ldo.h to keep Lua's internal headers out of
 * the vendored cmsgpack source included below. */
void luaD_throw(lua_State *L, int errcode);

typedef struct TrackedBlock {
  struct TrackedBlock *prev;
  struct TrackedBlock *next;
  size_t size; /* bytes requested by cmsgpack, excluding the header */
} TrackedBlock;

/* Header size, rounded up to a multiple of 16 so the memory handed to cmsgpack
 * keeps the allocator's alignment. */
#define BLOCK_HEADER ((sizeof(TrackedBlock) + 15) & ~(size_t)15)

static TrackedBlock *g_blocks = NULL;
static lua_Alloc g_lua_alloc = NULL;
static void *g_lua_alloc_ud = NULL;

static void unlink_block(TrackedBlock *block) {
  if (block->prev) {
    block->prev->next = block->next;
  } else {
    g_blocks = block->next;
  }
  if (block->next) {
    block->next->prev = block->prev;
  }
}

static void free_block(TrackedBlock *block) {
  g_lua_alloc(g_lua_alloc_ud, block, BLOCK_HEADER + block->size, 0);
}

/* lua_Alloc handed to cmsgpack; ud is the calling lua_State. */
static void *raising_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
  lua_State *L = (lua_State *)ud;
  TrackedBlock *block = ptr ? (TrackedBlock *)((char *)ptr - BLOCK_HEADER) : NULL;
  (void)osize; /* the header records the size */
  if (nsize == 0) {
    if (block) {
      unlink_block(block);
      free_block(block);
    }
    return NULL;
  }
  if (nsize > SIZE_MAX - BLOCK_HEADER) {
    luaD_throw(L, LUA_ERRMEM);
  }
  size_t old_total = block ? BLOCK_HEADER + block->size : 0;
  TrackedBlock *grown =
      (TrackedBlock *)g_lua_alloc(g_lua_alloc_ud, block, old_total, BLOCK_HEADER + nsize);
  if (!grown) {
    /* The old block, if any, is intact and still listed. */
    luaD_throw(L, LUA_ERRMEM);
  }
  if (!block) {
    grown->prev = NULL;
    grown->next = g_blocks;
    if (g_blocks) {
      g_blocks->prev = grown;
    }
    g_blocks = grown;
  } else if (grown != block) {
    /* Moved: the links were copied, repoint the neighbours. */
    if (grown->prev) {
      grown->prev->next = grown;
    } else {
      g_blocks = grown;
    }
    if (grown->next) {
      grown->next->prev = grown;
    }
  }
  grown->size = nsize;
  return (char *)grown + BLOCK_HEADER;
}

void cmsgpack_release_buffers(void) {
  while (g_blocks) {
    TrackedBlock *block = g_blocks;
    g_blocks = block->next;
    free_block(block);
  }
}

static lua_Alloc checked_getallocf(lua_State *L, void **ud) {
  g_lua_alloc = lua_getallocf(L, &g_lua_alloc_ud);
  *ud = L;
  return raising_alloc;
}

/* lua.h is include-guarded, so the vendored file's own #include "lua.h" does not
 * redeclare lua_getallocf under this macro. */
#define lua_getallocf checked_getallocf
#include "lua_cmsgpack.c"
#undef lua_getallocf
