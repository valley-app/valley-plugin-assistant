#!/bin/sh
set -eu
runtime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m)" in
  arm64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) exit 1 ;;
esac
exec "$runtime_dir/../node/$architecture/node" "$runtime_dir/runtime.mjs" "$@"
