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

REDIS_LUA_DEPS="$ROOT_DIR/vendor/redis/deps/lua/src"
REDIS_SRC="$ROOT_DIR/vendor/redis/src"
LUA_SRC_DIR="$REDIS_LUA_DEPS"
LUA_CORE="lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c"
LUA_LIBS="lauxlib.c lbaselib.c ltablib.c lstrlib.c lmathlib.c"
REDIS_LUA_MODULES="lua_cjson.c lua_cmsgpack.c lua_struct.c lua_bit.c strbuf.c fpconv.c"

CORE_FILES=""
for file in $LUA_CORE; do
  CORE_FILES="$CORE_FILES $LUA_SRC_DIR/$file"
done

LIB_FILES=""
for file in $LUA_LIBS; do
  LIB_FILES="$LIB_FILES $LUA_SRC_DIR/$file"
done

MODULE_FILES=""
for file in $REDIS_LUA_MODULES; do
  MODULE_FILES="$MODULE_FILES $REDIS_LUA_DEPS/$file"
done

emcc -O2 -DENABLE_CJSON_GLOBAL \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sNO_EXIT_RUNTIME=1 -sSTRICT=1 \
  -sWASM_BIGINT=1 \
  -sEXPORTED_RUNTIME_METHODS="['HEAPU8']" \
  -sINCOMING_MODULE_JS_API="['locateFile','instantiateWasm']" \
  -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 \
  -sEXPORTED_FUNCTIONS="['_init','_reset','_eval','_eval_with_args','_alloc','_free_mem','_set_limits']" \
  -I"$ROOT_DIR/wasm/include" -I"$LUA_SRC_DIR" -I"$REDIS_LUA_DEPS" -I"$REDIS_SRC" \
  "$SRC_DIR/runtime.c" "$SRC_DIR/redis_api.c" $CORE_FILES $LIB_FILES $MODULE_FILES \
  -o "$OUT_DIR/redis_lua.mjs"

echo "Built $OUT_DIR/redis_lua.mjs"
