#!/usr/bin/env bash
set -euo pipefail

# Phase 2 build script using Emscripten.
# Requires `emcc` in PATH.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/wasm/build"
SRC_DIR="$ROOT_DIR/wasm/src"

mkdir -p "$OUT_DIR"

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found in PATH. Install Emscripten to build the WASM module."
  exit 1
fi

LUA_DEPS="$ROOT_DIR/vendor/valkey/deps/lua/src"
VALKEY_SRC="$ROOT_DIR/vendor/valkey/src"
LUA_SRC_DIR="$LUA_DEPS"
LUA_CORE="lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c"
LUA_LIBS="lauxlib.c lbaselib.c ltablib.c lstrlib.c lmathlib.c loslib.c"
# lua_cjson.c is compiled through wasm/src/lua_cjson_checked.c, which also
# replaces strbuf.c.
LUA_MODULES="lua_struct.c lua_bit.c fpconv.c"

CORE_FILES=""
for file in $LUA_CORE; do
  CORE_FILES="$CORE_FILES $LUA_SRC_DIR/$file"
done

LIB_FILES=""
for file in $LUA_LIBS; do
  LIB_FILES="$LIB_FILES $LUA_SRC_DIR/$file"
done

MODULE_FILES=""
for file in $LUA_MODULES; do
  MODULE_FILES="$MODULE_FILES $LUA_DEPS/$file"
done
MODULE_FILES="$MODULE_FILES $ROOT_DIR/vendor/valkey/deps/fpconv/fpconv_dtoa.c" # redis.call number args

# C stack (#77). Emscripten's default is 64 KB, far below what Lua's own limit
# of 200 nested C calls (LUAI_MAXCCALLS, as in Redis) needs: a string.gsub
# callback level takes about 1.5 KB, so 200 levels take about 300 KB, and a
# cjson level about 120 bytes, capped at ~4000 levels (~0.5 MB, see
# lua_cjson_checked.c). With 2 MB, taken from the fixed 64 MB heap, scripts
# get Lua's "C stack overflow" error instead of overflowing. --stack-first
# puts the stack at the bottom of memory, so any overflow traps (the engine
# reports it and refuses further evals) instead of silently overwriting static
# data.
STACK_FLAGS="-sSTACK_SIZE=2097152 -Wl,--stack-first"

emcc -O2 -DENABLE_CJSON_GLOBAL \
  --js-library "$SRC_DIR/library_host.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sNO_EXIT_RUNTIME=1 -sSTRICT=1 \
  -sWASM_BIGINT=1 \
  -sEXPORTED_RUNTIME_METHODS="['HEAPU8']" \
  -sINCOMING_MODULE_JS_API="['locateFile','instantiateWasm']" \
  -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 -sABORTING_MALLOC=0 \
  $STACK_FLAGS \
  -sEXPORTED_FUNCTIONS="['_init','_reset','_close_vm','_eval','_eval_with_args','_alloc','_free_mem','_set_limits','_set_compat','_current_call_source','_current_call_line']" \
  -I"$ROOT_DIR/wasm/include" -I"$LUA_SRC_DIR" -I"$LUA_DEPS" -I"$VALKEY_SRC" \
  "$SRC_DIR/runtime.c" "$SRC_DIR/redis_api.c" "$SRC_DIR/redis_math.c" "$SRC_DIR/lua_cmsgpack_checked.c" \
  "$SRC_DIR/lua_cjson_checked.c" \
  "$VALKEY_SRC/rand.c" $CORE_FILES $LIB_FILES $MODULE_FILES \
  -o "$OUT_DIR/redis_lua.mjs"

echo "Built $OUT_DIR/redis_lua.mjs"
