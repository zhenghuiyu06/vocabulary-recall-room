#!/bin/zsh

set -eu

project_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd -- "$project_dir"

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT="3000"

if [[ ! -f "$project_dir/dist/server/index.js" ]]; then
  /usr/local/bin/npm run build
fi

exec /usr/local/bin/npm run start
