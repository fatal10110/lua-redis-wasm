// Shared no-op stubs for the host imports, linked into the smoke-test binaries.
//
// The real host imports are provided by the JS loader at WASM instantiation; the
// native smoke tests have no JS host, so they must define them. init()/reset()
// call host_redis_props() unconditionally, so it MUST return {0,0} (no props).
// The rest are not exercised by the current smoke scripts, but are stubbed too so
// the test binaries don't rely on -sERROR_ON_UNDEFINED_SYMBOLS for them.
#include "../../include/abi.h"

PtrLen host_redis_call(uint32_t ptr, uint32_t len) {
  (void)ptr;
  (void)len;
  return (PtrLen){0, 0};
}

PtrLen host_redis_pcall(uint32_t ptr, uint32_t len) {
  (void)ptr;
  (void)len;
  return (PtrLen){0, 0};
}

void host_redis_log(uint32_t level, uint32_t ptr, uint32_t len) {
  (void)level;
  (void)ptr;
  (void)len;
}

PtrLen host_sha1hex(uint32_t ptr, uint32_t len) {
  (void)ptr;
  (void)len;
  return (PtrLen){0, 0};
}

PtrLen host_redis_props(void) { return (PtrLen){0, 0}; }
