/* lua_cjson with a strbuf that raises Lua's memory error instead of aborting.
 *
 * The vendored lua_cjson.c (vendor/valkey/deps/lua/src, not modified here)
 * builds its output in a strbuf, whose vendored implementation (strbuf.c, not
 * compiled) allocates with plain malloc/realloc and calls die() -> abort() when
 * the heap cannot grow it. With the fixed 64 MB heap, cjson.encode of a value
 * that expands into a huge document (a table holding the same subtable many
 * times) then killed the whole module (#74).
 *
 * This file compiles lua_cjson.c and replaces strbuf.c (the functions below
 * keep strbuf.h's API; calculate_new_size and strbuf_append_string follow the
 * vendored code, MIT, Copyright (c) 2010-2012 Mark Pulford, see
 * THIRD_PARTY_NOTICES.md). The differences:
 *
 * - Running out of memory raises Lua's memory error ("not enough memory") on
 *   the thread running cjson, like a failed Lua allocation, and leaves the
 *   strbuf valid: the vendored strbuf_resize updates `size` before realloc, so
 *   it could not just be wrapped. cjson holds no other C resources at the
 *   points where a strbuf grows, so unwinding from there is safe.
 *
 * - An error that unwinds a cjson call (this memory error, or one Lua raises
 *   while cjson.decode builds tables) abandons the call's own buffer:
 *   json_encode's private buffer when cjson.encode_keep_buffer is off, or
 *   json_decode's scratch buffer. Such buffers are tracked and freed by
 *   cjson_release_buffers(), which runtime.c calls once the script has
 *   finished. The encode buffer kept in the cjson config (the default) outlives
 *   calls; cjson_release_buffers() shrinks it back to its initial size, so one
 *   large encode does not hold the memory for later scripts.
 */
#include <emscripten/stack.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lua.h"

/* The thread running cjson, for raising the memory error. Every cjson entry
 * point fetches its config (lua_touserdata) or creates one (lua_newuserdata)
 * before touching a strbuf, so recording the thread there covers all of them.
 * No Lua code runs inside a cjson call (the sandbox has no newproxy, so the
 * only finalizer a collection can run is cjson's own C one), so the thread
 * stays current for the whole call. lua.h is include-guarded, so the vendored
 * file's own #include does not redeclare these functions under the macros. */
static lua_State *g_cjson_thread = NULL;

static void *touserdata_noting_thread(lua_State *L, int idx) {
  g_cjson_thread = L;
  return lua_touserdata(L, idx);
}

static void *newuserdata_noting_thread(lua_State *L, size_t size) {
  g_cjson_thread = L;
  return lua_newuserdata(L, size);
}

#define lua_touserdata touserdata_noting_thread
#define lua_newuserdata newuserdata_noting_thread
#include "lua_cjson.c" /* also includes strbuf.h, which has no include guard */
#undef lua_touserdata
#undef lua_newuserdata

#include "ldo.h" /* luaD_throw: raise LUA_ERRMEM like a failed Lua allocation */

/* ===== strbuf ===== */

/* Every strbuf buffer is allocated with this header in front of it and linked
 * into one of two lists: buffers owned by a single cjson call (transient), and
 * the encode buffers kept in cjson configs (kept). */
typedef struct BufHeader {
  struct BufHeader *prev;
  struct BufHeader *next;
  /* Kept: the strbuf (inside a cjson config). Transient: the strbuf_new
   * strbuf to free along with the buffer, or NULL for one on the C stack. */
  strbuf_t *owner;
} BufHeader;

static BufHeader g_transient = {&g_transient, &g_transient, NULL};
static BufHeader g_kept = {&g_kept, &g_kept, NULL};

static void list_insert(BufHeader *head, BufHeader *h) {
  h->prev = head;
  h->next = head->next;
  head->next->prev = h;
  head->next = h;
}

static void list_remove(BufHeader *h) {
  h->prev->next = h->next;
  h->next->prev = h->prev;
}

static BufHeader *header_of(char *buf) { return (BufHeader *)buf - 1; }

/* A strbuf lives only as long as the cjson call that uses it when strbuf_new
 * created it (json_decode's scratch buffer) or when it is a local variable of
 * that call (json_encode's private buffer). The only other strbuf is the encode
 * buffer inside a cjson config, a Lua userdata. */
static int is_transient(strbuf_t *s) {
  uintptr_t addr = (uintptr_t)s;
  return s->dynamic ||
         (addr >= emscripten_stack_get_end() && addr < emscripten_stack_get_base());
}

static void strbuf_out_of_memory(void) {
  if (g_cjson_thread) {
    luaD_throw(g_cjson_thread, LUA_ERRMEM);
  }
  abort(); /* not reached: strbufs are only allocated inside cjson calls */
}

/* Allocates a buffer of `size` bytes for s and tracks it. s->buf is left alone
 * on failure. */
static char *buffer_alloc(strbuf_t *s, size_t size) {
  if (size > SIZE_MAX - sizeof(BufHeader)) {
    return NULL;
  }
  BufHeader *h = malloc(sizeof(BufHeader) + size);
  if (!h) {
    return NULL;
  }
  int transient = is_transient(s);
  h->owner = transient && !s->dynamic ? NULL : s;
  list_insert(transient ? &g_transient : &g_kept, h);
  return (char *)(h + 1);
}

static void buffer_free(char *buf) {
  if (buf) {
    BufHeader *h = header_of(buf);
    list_remove(h);
    free(h);
  }
}

/* Resizes s's buffer to `size` bytes. On failure the old buffer is kept and
 * the call returns 0. */
static int buffer_realloc(strbuf_t *s, size_t size) {
  if (!s->buf) {
    char *buf = buffer_alloc(s, size);
    if (buf) {
      s->buf = buf;
    }
    return buf != NULL;
  }
  if (size > SIZE_MAX - sizeof(BufHeader)) {
    return 0;
  }
  BufHeader *old = header_of(s->buf);
  BufHeader *prev = old->prev; /* the list head or a buffer realloc leaves alone */
  list_remove(old);
  BufHeader *h = realloc(old, sizeof(BufHeader) + size);
  int ok = h != NULL;
  if (!ok) {
    h = old;
  }
  list_insert(prev, h); /* back in the same place */
  s->buf = (char *)(h + 1);
  return ok;
}

void strbuf_init(strbuf_t *s, size_t len) {
  size_t size = len ? len + 1 : STRBUF_DEFAULT_SIZE;

  /* On failure s stays a valid empty strbuf: size 1 leaves no room, so the
   * next append goes through strbuf_resize, which allocates. */
  s->buf = NULL;
  s->size = 1;
  s->length = 0;
  s->dynamic = 0;
  s->reallocs = 0;
  s->debug = 0;
  if (size < len) {
    strbuf_out_of_memory();
  }
  char *buf = buffer_alloc(s, size);
  if (!buf) {
    strbuf_out_of_memory();
  }
  s->buf = buf;
  s->size = size;
  strbuf_ensure_null(s);
}

strbuf_t *strbuf_new(size_t len) {
  strbuf_t *s = malloc(sizeof(strbuf_t));
  if (!s) {
    strbuf_out_of_memory();
  }
  size_t size = len ? len + 1 : STRBUF_DEFAULT_SIZE;
  s->buf = NULL;
  s->size = 1;
  s->length = 0;
  s->dynamic = 1;
  s->reallocs = 0;
  s->debug = 0;
  char *buf = size < len ? NULL : buffer_alloc(s, size);
  if (!buf) {
    free(s);
    strbuf_out_of_memory();
  }
  s->buf = buf;
  s->size = size;
  strbuf_ensure_null(s);
  return s;
}

void strbuf_free(strbuf_t *s) {
  buffer_free(s->buf);
  s->buf = NULL;
  s->size = 1;
  s->length = 0;
  if (s->dynamic) {
    free(s);
  }
}

char *strbuf_free_to_string(strbuf_t *s, size_t *len) {
  /* Not used by lua_cjson. The caller frees the result with free(), so it is
   * copied out of the tracked buffer. */
  char *out = malloc(s->length + 1);
  if (!out) {
    strbuf_out_of_memory();
  }
  memcpy(out, s->buf, s->length);
  out[s->length] = '\0';
  if (len) {
    *len = s->length;
  }
  strbuf_free(s);
  return out;
}

/* As in the vendored strbuf.c, with its die() calls turned into a failure. */
static size_t calculate_new_size(strbuf_t *s, size_t len) {
  size_t reqsize, newsize;

  /* Ensure there is room for optional NULL termination */
  reqsize = len + 1;
  if (reqsize < len) {
    return 0;
  }

  /* If the user has requested to shrink the buffer, do it exactly */
  if (s->size > reqsize) {
    return reqsize;
  }

  newsize = s->size;
  if (reqsize >= SIZE_MAX / 2) {
    newsize = reqsize;
  } else {
    /* Exponential sizing */
    while (newsize < reqsize) {
      newsize *= 2;
    }
  }
  return newsize;
}

/* Ensure strbuf can handle a string length bytes long (ignoring NULL
 * optional termination). */
void strbuf_resize(strbuf_t *s, size_t len) {
  size_t newsize = calculate_new_size(s, len);

  if (newsize == 0 || !buffer_realloc(s, newsize)) {
    /* The contents are abandoned with the call the error unwinds. Hand back
     * the memory now, so that a buffer kept in the cjson config is not left
     * at its largest size: shrink it to the initial size (a shrinking realloc
     * does not fail in practice; if it does, the buffer stays as it was). */
    if (s->buf && s->size > STRBUF_DEFAULT_SIZE && buffer_realloc(s, STRBUF_DEFAULT_SIZE)) {
      s->size = STRBUF_DEFAULT_SIZE;
    }
    s->length = 0;
    strbuf_out_of_memory();
  }
  s->size = newsize;
  s->reallocs++;
}

void strbuf_append_string(strbuf_t *s, const char *str) {
  size_t i, space;

  space = strbuf_empty_length(s);

  for (i = 0; str[i]; i++) {
    if (space < 1) {
      strbuf_resize(s, s->length + 1);
      space = strbuf_empty_length(s);
    }

    s->buf[s->length] = str[i];
    s->length++;
    space--;
  }
}

/* Called by runtime.c after each script, when no cjson call is running. Frees
 * the buffers of cjson calls an error unwound, and shrinks the encode buffers
 * kept in cjson configs back to their initial size. */
void cjson_release_buffers(void) {
  while (g_transient.next != &g_transient) {
    BufHeader *h = g_transient.next;
    list_remove(h);
    free(h->owner); /* NULL unless strbuf_new allocated the strbuf */
    free(h);
  }
  for (BufHeader *h = g_kept.next; h != &g_kept;) {
    strbuf_t *s = h->owner;
    if (s->size > STRBUF_DEFAULT_SIZE && buffer_realloc(s, STRBUF_DEFAULT_SIZE)) {
      s->size = STRBUF_DEFAULT_SIZE;
      s->length = 0;
    }
    h = header_of(s->buf)->next; /* the realloc may have moved h */
  }
  g_cjson_thread = NULL;
}
