#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Evaluates `script` and returns the reply's type tag. */
static uint8_t eval_tag(const char *script) {
  uint32_t len = (uint32_t)strlen(script);
  uint32_t ptr = alloc(len);
  memcpy((void *)(uintptr_t)ptr, script, len);
  PtrLen reply = eval(ptr, len);
  free_mem(ptr);
  assert(reply.ptr != 0);
  uint8_t tag = *(const uint8_t *)(uintptr_t)reply.ptr;
  free_mem(reply.ptr);
  return tag;
}

int main(void) {
  assert(init() == 0);
  assert(reset() == 0);
  assert(eval_tag("return 1") == REPLY_INT);

  /* close_vm is idempotent and leaves no VM behind. */
  assert(close_vm() == 0);
  assert(close_vm() == 0);
  assert(eval_tag("return 1") == REPLY_ERROR);

  /* reset rebuilds a missing VM. */
  assert(reset() == 0);
  assert(eval_tag("return 1") == REPLY_INT);
  assert(close_vm() == 0);
  return 0;
}
