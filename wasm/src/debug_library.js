// Emscripten JS library for the REDIS_LUA_DEBUG build flavor only.
//
// host_debug_request is the single Asyncify import. It must be defined here —
// not injected via instantiateWasm like the sync host imports — because
// suspending requires the Asyncify.handleAsync wrapper the glue provides; a
// raw injected import returning a Promise would not unwind the WASM stack.
//
// The actual handler is looked up on the Module object at call time
// (Module['onDebugRequest'], set by the TS loader after instantiation). It
// receives (ptr, len) of the payload in linear memory and must resolve to a
// pointer to a reply buffer laid out as [u32le len][bytes], allocated with
// _alloc (C frees it with free_mem), or 0 when no debug session is attached.
addToLibrary({
  host_debug_request__deps: ['$Asyncify'],
  host_debug_request__async: true,
  host_debug_request: function (ptr, len) {
    return Asyncify.handleAsync(async () => {
      var handler = Module['onDebugRequest'];
      if (!handler) {
        return 0;
      }
      return handler(ptr, len);
    });
  },
});
