#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/wasm/build/tests"

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

COMMON_SRC="$ROOT_DIR/wasm/src/runtime.c $ROOT_DIR/wasm/src/redis_api.c $CORE_FILES $LIB_FILES $MODULE_FILES"

mkdir -p "$OUT_DIR"

for test in runtime_smoke runtime_eval_smoke runtime_eval_args_smoke modules_smoke; do
  emcc -O2 -DENABLE_CJSON_GLOBAL -sENVIRONMENT=node -sEXIT_RUNTIME=1 \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 -sWARN_ON_UNDEFINED_SYMBOLS=0 \
    -I"$ROOT_DIR/wasm/include" -I"$LUA_SRC_DIR" -I"$REDIS_LUA_DEPS" -I"$REDIS_SRC" \
    "$ROOT_DIR/wasm/src/tests/$test.c" $COMMON_SRC \
    -o "$OUT_DIR/$test.js"
  node "$OUT_DIR/$test.js"
  echo "$test: OK"
done
