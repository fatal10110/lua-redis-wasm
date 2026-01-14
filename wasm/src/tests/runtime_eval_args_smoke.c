#include "../../include/abi.h"
#include <assert.h>
#include <stdint.h>
#include <string.h>

static void write_u32_le(uint8_t *dst, uint32_t value) {
  dst[0] = (uint8_t)(value & 0xFF);
  dst[1] = (uint8_t)((value >> 8) & 0xFF);
  dst[2] = (uint8_t)((value >> 16) & 0xFF);
  dst[3] = (uint8_t)((value >> 24) & 0xFF);
}

static uint32_t read_u32_le(const uint8_t *src) {
  return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) |
         ((uint32_t)src[3] << 24);
}

int main(void) {
  assert(init() == 0);

  const char *script = "return KEYS[1] .. ARGV[1]";
  uint32_t script_len = (uint32_t)strlen(script);
  uint32_t script_ptr = alloc(script_len);
  memcpy((void *)(uintptr_t)script_ptr, script, script_len);

  uint8_t args[4 + 4 + 3 + 4 + 3];
  size_t offset = 0;
  write_u32_le(args + offset, 2);
  offset += 4;

  write_u32_le(args + offset, 3);
  offset += 4;
  args[offset++] = '\0';
  args[offset++] = '\1';
  args[offset++] = '\2';

  write_u32_le(args + offset, 3);
  offset += 4;
  args[offset++] = '\3';
  args[offset++] = '\0';
  args[offset++] = '\4';

  uint32_t args_ptr = alloc((uint32_t)sizeof(args));
  memcpy((void *)(uintptr_t)args_ptr, args, sizeof(args));

  PtrLen reply = eval_with_args(script_ptr, script_len, args_ptr, (uint32_t)sizeof(args), 1);
  free_mem(script_ptr);
  free_mem(args_ptr);

  assert(reply.ptr != 0);
  assert(reply.len >= 5);

  const uint8_t *buf = (const uint8_t *)(uintptr_t)reply.ptr;
  uint8_t type = buf[0];
  uint32_t len = read_u32_le(buf + 1);

  assert(type == REPLY_BULK);
  assert(len == 6);

  const uint8_t *payload = buf + 5;
  assert(payload[0] == '\0');
  assert(payload[1] == '\1');
  assert(payload[2] == '\2');
  assert(payload[3] == '\3');
  assert(payload[4] == '\0');
  assert(payload[5] == '\4');

  free_mem(reply.ptr);
  return 0;
}
