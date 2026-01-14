#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

static uint32_t read_u32_le(const uint8_t *src) {
  return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) |
         ((uint32_t)src[3] << 24);
}

int main(void) {
  assert(init() == 0);

  const char *script = "return 42";
  uint32_t ptr = alloc((uint32_t)strlen(script));
  memcpy((void *)(uintptr_t)ptr, script, strlen(script));

  PtrLen reply = eval(ptr, (uint32_t)strlen(script));
  free_mem(ptr);

  assert(reply.ptr != 0);
  assert(reply.len >= 5);

  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  uint8_t type = buf[0];
  uint32_t len = read_u32_le(buf + 1);

  assert(type == REPLY_INT);
  assert(len == 8);

  free_mem(reply.ptr);
  return 0;
}
