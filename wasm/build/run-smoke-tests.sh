#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/wasm/build/tests"

LUA_DEPS="$ROOT_DIR/vendor/valkey/deps/lua/src"
VALKEY_SRC="$ROOT_DIR/vendor/valkey/src"
LUA_SRC_DIR="$LUA_DEPS"

LUA_CORE="lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c"
LUA_LIBS="lauxlib.c lbaselib.c ltablib.c lstrlib.c lmathlib.c loslib.c"
LUA_MODULES="lua_cjson.c lua_struct.c lua_bit.c strbuf.c fpconv.c"

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

COMMON_SRC="$ROOT_DIR/wasm/src/runtime.c $ROOT_DIR/wasm/src/redis_api.c $ROOT_DIR/wasm/src/redis_math.c $ROOT_DIR/wasm/src/lua_cmsgpack_checked.c $ROOT_DIR/wasm/src/tests/test_host_stubs.c $VALKEY_SRC/rand.c $CORE_FILES $LIB_FILES $MODULE_FILES"

mkdir -p "$OUT_DIR"

# LUA_REDIS_WASM_TESTING exposes test-only hooks from runtime.c (e.g.
# test_unprotected_error); the production build never defines it.
for test in runtime_smoke runtime_eval_smoke runtime_eval_args_smoke modules_smoke redis_math_smoke runtime_panic_smoke; do
  emcc -O2 -DENABLE_CJSON_GLOBAL -DLUA_REDIS_WASM_TESTING -sENVIRONMENT=node -sEXIT_RUNTIME=1 \
    -I"$ROOT_DIR/wasm/include" -I"$LUA_SRC_DIR" -I"$LUA_DEPS" -I"$VALKEY_SRC" \
    "$ROOT_DIR/wasm/src/tests/$test.c" $COMMON_SRC \
    -o "$OUT_DIR/$test.js"
  node "$OUT_DIR/$test.js"
  echo "$test: OK"
done
