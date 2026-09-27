/* Replacement for the vendored strbuf.c (vendor/redis/deps/lua/src), used by
 * cjson, implementing the out-of-line half of its strbuf.h API.
 *
 * The vendored implementation mallocs outside the Lua allocator and abort()s
 * when an allocation fails, so cjson.encode of a value that expands into a
 * huge document (a table holding the same subtable many times) kills the
 * engine. Its buffers also leak whenever a Lua error unwinds cjson while one
 * is live (decode's scratch buffer when pushing a value fails with "not enough
 * memory", or a private encode buffer).
 *
 * Here, every block goes through the Lua allocator (lua_heap_alloc), so it
 * counts toward maxMemoryBytes, and an allocation failure raises Lua's own
 * "not enough memory" error (luaD_throw(LUA_ERRMEM), as the Lua core does) on
 * the thread running cjson, without touching the strbuf, which stays valid.
 * Blocks are kept on a list. Each is transient (the scratch strbufs cjson makes
 * per call: strbuf_new's, and ones embedded in a C stack frame) or persistent
 * (the encode buffer embedded in a cjson config userdata, which cjson keeps
 * across calls and frees from the config's __gc). Once no script runs,
 * cjson_release_buffers() frees the transient blocks still listed, which are
 * the ones an error abandoned, and shrinks grown persistent buffers back to
 * the default size so that one large encode does not hold on to memory (and to
 * the maxMemoryBytes budget) for the life of the engine. */
#include <emscripten/stack.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lua.h"
#include "lua_modules.h"
#include "strbuf.h"

/* Lua core (ldo.c): raises `errcode` on L like a failed allocation does. */
void luaD_throw(lua_State *L, int errcode);

typedef struct StrbufBlock {
  struct StrbufBlock *prev;
  struct StrbufBlock *next;
  strbuf_t *owner; /* the strbuf whose buf this is; NULL for a strbuf_t itself */
  size_t size;     /* usable bytes, excluding the header */
  int transient;
} StrbufBlock;

/* Header size, rounded up to a multiple of 16 so the memory handed out keeps
 * the allocator's alignment. */
#define BLOCK_HEADER ((sizeof(StrbufBlock) + 15) & ~(size_t)15)

static StrbufBlock *g_blocks = NULL;

static void raise_no_memory(void) {
  lua_State *L = cjson_current_state();
  if (!L) {
    abort(); /* no cjson call has run yet: cannot happen while a script runs */
  }
  luaD_throw(L, LUA_ERRMEM);
}

static StrbufBlock *block_of(void *ptr) {
  return (StrbufBlock *)((char *)ptr - BLOCK_HEADER);
}

/* A strbuf embedded in a C stack frame (json_encode's private buffer) dies
 * with the call. The shadow stack grows down from base to end. */
static int on_c_stack(const void *p) {
  uintptr_t addr = (uintptr_t)p;
  return addr >= emscripten_stack_get_end() && addr < emscripten_stack_get_base();
}

/* Allocates (ptr == NULL) or resizes a block to `size` bytes. Raises on failure,
 * leaving `ptr` intact and listed. */
static void *block_realloc(void *ptr, size_t size, strbuf_t *owner, int transient) {
  if (size > SIZE_MAX - BLOCK_HEADER) {
    raise_no_memory();
  }
  StrbufBlock *block = ptr ? block_of(ptr) : NULL;
  size_t old_total = block ? BLOCK_HEADER + block->size : 0;
  StrbufBlock *grown = (StrbufBlock *)lua_heap_alloc(block, old_total, BLOCK_HEADER + size);
  if (!grown) {
    raise_no_memory();
  }
  if (!block) {
    grown->prev = NULL;
    grown->next = g_blocks;
    if (g_blocks) {
      g_blocks->prev = grown;
    }
    g_blocks = grown;
    grown->owner = owner;
    grown->transient = transient;
  } else if (grown != block) {
    if (grown->prev) {
      grown->prev->next = grown;
    } else {
      g_blocks = grown;
    }
    if (grown->next) {
      grown->next->prev = grown;
    }
  }
  grown->size = size;
  return (char *)grown + BLOCK_HEADER;
}

static void block_free(void *ptr) {
  StrbufBlock *block = block_of(ptr);
  if (block->prev) {
    block->prev->next = block->next;
  } else {
    g_blocks = block->next;
  }
  if (block->next) {
    block->next->prev = block->prev;
  }
  lua_heap_alloc(block, BLOCK_HEADER + block->size, 0);
}

static void init_strbuf(strbuf_t *s, size_t len, int dynamic) {
  size_t size = len ? len + 1 : STRBUF_DEFAULT_SIZE;
  s->buf = NULL;
  /* A strbuf left behind by a failed allocation must stay safe to use: with
   * size 1 and length 0 it has no free space, so the next append allocates. */
  s->size = 1;
  s->length = 0;
  s->dynamic = dynamic;
  s->reallocs = 0;
  s->debug = 0;
  if (size < len) {
    raise_no_memory();
  }
  s->buf = (char *)block_realloc(NULL, size, s, dynamic || on_c_stack(s));
  s->size = size;
  s->buf[0] = '\0';
}

void strbuf_init(strbuf_t *s, size_t len) {
  init_strbuf(s, len, 0);
}

strbuf_t *strbuf_new(size_t len) {
  strbuf_t *s = (strbuf_t *)block_realloc(NULL, sizeof(strbuf_t), NULL, 1);
  init_strbuf(s, len, 1);
  return s;
}

void strbuf_free(strbuf_t *s) {
  if (s->buf) {
    block_free(s->buf);
    s->buf = NULL;
  }
  if (s->dynamic) {
    block_free(s);
  }
}

/* Like the vendored version: grow exponentially, or shrink to exactly
 * len + 1 when the buffer is larger. */
void strbuf_resize(strbuf_t *s, size_t len) {
  size_t reqsize = len + 1;
  if (reqsize < len) {
    raise_no_memory();
  }
  size_t newsize;
  if (s->size > reqsize) {
    newsize = reqsize;
  } else if (reqsize >= SIZE_MAX / 2) {
    newsize = reqsize;
  } else {
    newsize = s->size ? s->size : 1;
    while (newsize < reqsize) {
      newsize *= 2;
    }
  }
  /* Only the block moves on success; the strbuf is untouched on failure. */
  s->buf = (char *)block_realloc(s->buf, newsize, s, s->dynamic || on_c_stack(s));
  s->size = newsize;
  s->reallocs++;
}

void strbuf_append_string(strbuf_t *s, const char *str) {
  strbuf_append_mem(s, str, strlen(str));
}

/* strbuf_free_to_string is not implemented: cjson does not use it, and its
 * result would have to be freed by the caller with free(). */

void cjson_release_buffers(void) {
  StrbufBlock *block = g_blocks;
  while (block) {
    StrbufBlock *next = block->next;
    void *data = (char *)block + BLOCK_HEADER;
    if (block->transient) {
      block_free(data);
    } else if (block->owner && block->size > STRBUF_DEFAULT_SIZE) {
      /* A kept encode buffer: every encode starts with strbuf_reset, so its
       * contents are dead. Shrinking cannot fail for want of memory (and is
       * never refused), but keep the block if realloc declines. */
      strbuf_t *owner = block->owner;
      StrbufBlock *shrunk = (StrbufBlock *)lua_heap_alloc(
          block, BLOCK_HEADER + block->size, BLOCK_HEADER + STRBUF_DEFAULT_SIZE);
      if (shrunk) {
        if (shrunk->prev) {
          shrunk->prev->next = shrunk;
        } else {
          g_blocks = shrunk;
        }
        if (shrunk->next) {
          shrunk->next->prev = shrunk;
        }
        shrunk->size = STRBUF_DEFAULT_SIZE;
        owner->buf = (char *)shrunk + BLOCK_HEADER;
        owner->size = STRBUF_DEFAULT_SIZE;
        owner->length = 0;
        owner->buf[0] = '\0';
      }
    }
    block = next;
  }
}
