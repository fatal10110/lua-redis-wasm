#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_NAME="emscripten/emsdk:6.0.1"

# emscripten/emsdk publishes multi-arch images (amd64 + arm64), so build on the
# host architecture natively — no qemu emulation (which segfaults the compiler on
# Apple Silicon). Override DOCKER_PLATFORM to force a specific arch if needed.
PLATFORM="${DOCKER_PLATFORM:-}"

# Run the build inside Docker, mounting the repo.
docker run $PLATFORM --rm -v "$ROOT_DIR":/work -w /work "$IMAGE_NAME" \
  /bin/sh -c "./wasm/build/build.sh"
