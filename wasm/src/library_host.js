// Emscripten JS library declaring the host imports (see wasm/include/abi.h).
//
// The real implementations are injected by the JS loader at instantiation
// (src/loader-core.ts merges them into the `env` import namespace, replacing
// these entries). Declaring them here tells the Emscripten linker the symbols
// are intentionally provided by JS, so the build can keep undefined-symbol
// errors enabled: any other unresolved symbol still fails the link.
//
// The placeholders only run if a loader forgot to supply an import. Emscripten
// serializes each library function with toString(), so they must be
// self-contained (no closures over helpers defined in this file).

addToLibrary({
  host_redis_call: () => {
    throw new Error('lua-redis-wasm: host import "host_redis_call" was not provided by the loader');
  },
  host_redis_pcall: () => {
    throw new Error('lua-redis-wasm: host import "host_redis_pcall" was not provided by the loader');
  },
  host_redis_log: () => {
    throw new Error('lua-redis-wasm: host import "host_redis_log" was not provided by the loader');
  },
  host_redis_setresp: () => {
    throw new Error('lua-redis-wasm: host import "host_redis_setresp" was not provided by the loader');
  },
  host_sha1hex: () => {
    throw new Error('lua-redis-wasm: host import "host_sha1hex" was not provided by the loader');
  },
  host_redis_props: () => {
    throw new Error('lua-redis-wasm: host import "host_redis_props" was not provided by the loader');
  },
});
