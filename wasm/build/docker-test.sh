#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_NAME="emscripten/emsdk:3.1.56"

# Default to amd64 since emscripten/emsdk does not publish arm64 images.
PLATFORM="${DOCKER_PLATFORM:---platform=linux/amd64}"

# Run smoke tests inside Docker.
docker run $PLATFORM --rm -v "$ROOT_DIR":/work -w /work "$IMAGE_NAME" \
  /bin/sh -c "./wasm/build/run-smoke-tests.sh"
