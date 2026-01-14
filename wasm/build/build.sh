#!/usr/bin/env sh
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

LUA_SRC_DIR="$ROOT_DIR/lua/src"
LUA_CORE="lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c"
LUA_LIBS="lauxlib.c lbaselib.c ltablib.c lstrlib.c lmathlib.c"

CORE_FILES=""
for file in $LUA_CORE; do
  CORE_FILES="$CORE_FILES $LUA_SRC_DIR/$file"
done

LIB_FILES=""
for file in $LUA_LIBS; do
  LIB_FILES="$LIB_FILES $LUA_SRC_DIR/$file"
done

emcc -O2 -sSTANDALONE_WASM=1 \
  -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=67108864 \
  -I"$ROOT_DIR/wasm/include" -I"$LUA_SRC_DIR" \
  "$SRC_DIR/runtime.c" $CORE_FILES $LIB_FILES \
  -o "$OUT_DIR/redis_lua.wasm"

echo "Built $OUT_DIR/redis_lua.wasm"
