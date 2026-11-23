#!/usr/bin/env bash
# Usage: docker-smoke.sh <image> <git-sha>
# Proves the lab's requirements on the image that is about to be published.
set -euo pipefail
IMAGE=$1
SHA=$2

size=$(docker image inspect "$IMAGE" --format '{{.Size}}')
echo "image size: $((size / 1024 / 1024)) MB (limit 200 MB)"
[ "$size" -lt $((200 * 1024 * 1024)) ] || { echo "image is too big"; exit 1; }

user=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
echo "runs as: ${user:-root}"
[ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "0" ] || { echo "the image runs as root"; exit 1; }

cmd=$(docker image inspect "$IMAGE" --format '{{json .Config.Cmd}}')
echo "command: $cmd"
case "$cmd" in *npm*) echo "CMD must be node, not npm"; exit 1;; esac
docker image inspect "$IMAGE" --format '{{json .Config.Healthcheck}}' | grep -q Test || { echo "no HEALTHCHECK"; exit 1; }

cid=$(docker run -d -p 3000:3000 "$IMAGE")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 1; done

health=$(curl -fsS http://127.0.0.1:3000/health)
echo "$health" | head -c 200; echo
echo "$health" | grep -q "\"gitSha\":\"$SHA\"" || { echo "/health does not show git SHA $SHA"; exit 1; }
curl -fsS http://127.0.0.1:3000/ready | grep -q '"ready":true'
curl -fsS http://127.0.0.1:3000/metrics | grep -q '^dogfight_players '
curl -fsS http://127.0.0.1:3000/manifest.webmanifest >/dev/null

# no dev dependencies in the final image
if docker run --rm --entrypoint sh "$IMAGE" -c 'ls node_modules | grep -E "^(vite|vitest|playwright|typescript|eslint)$"'; then
  echo "dev dependencies found in the image"; exit 1
fi

node .github/scripts/graceful-stop-check.mjs http://127.0.0.1:3000 "$cid"
echo "smoke test passed"
