#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_NAME="redis-lua-wasm-build"
HOST_ARCH="$(uname -m)"

PLATFORM=""
if [ "$HOST_ARCH" = "arm64" ] || [ "$HOST_ARCH" = "aarch64" ]; then
  PLATFORM="--platform=linux/arm64"
fi

# Build the container image.
docker build $PLATFORM -t "$IMAGE_NAME" -f "$ROOT_DIR/docker/Dockerfile" "$ROOT_DIR/docker"

# Run the build inside Docker, mounting the repo.
docker run $PLATFORM --rm -v "$ROOT_DIR":/work -w /work "$IMAGE_NAME" \
  /bin/sh -c "./wasm/build/build.sh"
