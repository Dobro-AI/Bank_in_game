#!/bin/sh
# Ships the committed code to the server and rebuilds the bank container (data and keys stay).
#   DEPLOY_HOST=root@144.31.207.247 scripts/deploy.sh
set -e
HOST="${DEPLOY_HOST:-root@144.31.207.247}"
DIR="${DEPLOY_DIR:-/opt/bank/docker}"
git archive --format=tar HEAD | ssh "$HOST" "mkdir -p '$DIR' && tar -x -C '$DIR'"
ssh "$HOST" "cd '$DIR' && docker compose up -d --build app </dev/null && docker image prune -f >/dev/null && docker compose ps"
