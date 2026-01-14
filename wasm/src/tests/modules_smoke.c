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

  const char *script =
      "return (type(cjson)==\"table\" and type(cmsgpack)==\"table\" and "
      "type(struct)==\"table\" and type(bit)==\"table\") and \"ok\" or \"fail\"";
  uint32_t script_len = (uint32_t)strlen(script);
  uint32_t script_ptr = alloc(script_len);
  memcpy((void *)(uintptr_t)script_ptr, script, script_len);

  PtrLen reply = eval(script_ptr, script_len);
  free_mem(script_ptr);

  assert(reply.ptr != 0);
  assert(reply.len >= 5);

  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  uint8_t type = buf[0];
  uint32_t len = read_u32_le(buf + 1);

  assert(type == REPLY_BULK);
  assert(len == 2);
  assert(buf[5] == 'o');
  assert(buf[6] == 'k');

  free_mem(reply.ptr);
  return 0;
}
