#ifndef REDIS_LUA_WASM_ABI_H
#define REDIS_LUA_WASM_ABI_H

#include <stdint.h>

#define REDIS_LUA_WASM_ABI_VERSION 0

#ifdef __cplusplus
extern "C" {
#endif

typedef enum ReplyType {
  REPLY_NULL = 0x00,
  REPLY_INT = 0x01,
  REPLY_BULK = 0x02,
  REPLY_ARRAY = 0x03,
  REPLY_STATUS = 0x04,
  REPLY_ERROR = 0x05
} ReplyType;

#if defined(__GNUC__)
typedef struct __attribute__((packed)) ReplyHeader {
  uint8_t type;
  uint32_t count_or_len;
} ReplyHeader;
#else
#pragma pack(push, 1)
typedef struct ReplyHeader {
  uint8_t type;
  uint32_t count_or_len;
} ReplyHeader;
#pragma pack(pop)
#endif

typedef struct PtrLen {
  uint32_t ptr;
  uint32_t len;
} PtrLen;

/* Host imports */
PtrLen host_redis_call(uint32_t ptr, uint32_t len);
PtrLen host_redis_pcall(uint32_t ptr, uint32_t len);
void host_redis_log(uint32_t level, uint32_t ptr, uint32_t len);
PtrLen host_sha1hex(uint32_t ptr, uint32_t len);

/* WASM exports */
int32_t init(void);
int32_t reset(void);
PtrLen eval(uint32_t ptr, uint32_t len);
PtrLen eval_with_args(uint32_t script_ptr, uint32_t script_len, uint32_t args_ptr,
                      uint32_t args_len, uint32_t keys_count);
void set_limits(uint32_t max_fuel, uint32_t max_reply_bytes, uint32_t max_arg_bytes);
uint32_t alloc(uint32_t size);
void free_mem(uint32_t ptr);

#ifdef __cplusplus
}
#endif

#endif /* REDIS_LUA_WASM_ABI_H */
