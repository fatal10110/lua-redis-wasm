# Conformance Suite

This directory will host Redis 7 Lua conformance scripts and golden outputs.

## Layout
- `conformance/scripts/`: Lua scripts to execute against Redis and this engine.
- `conformance/golden/`: Expected outputs captured from Redis 7.

## Next steps
- Add scripts covering cjson, cmsgpack, struct, bit, and redis.call/pcall.
- Capture golden outputs from a Redis 7 instance.
