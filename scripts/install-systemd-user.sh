#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="${WECHATBOT_PROJECT_DIR:-$(cd -- "$script_dir/.." && pwd)}"
node_bin="${WECHATBOT_NODE_BIN:-$(command -v node || true)}"
home_dir="${WECHATBOT_HOME_DIR:-${HOME:?HOME is not set}}"
if [[ -z "$node_bin" ]]; then
  printf '%s\n' 'node was not found; set WECHATBOT_NODE_BIN to the absolute Node.js path.' >&2
  exit 1
fi

template="$project_dir/deploy/wecode.service"
[[ -f "$template" ]] || { printf 'service template not found: %s\n' "$template" >&2; exit 1; }

unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
mkdir -p "$unit_dir" "$project_dir/runtime"
node_dir="$(dirname -- "$node_bin")"
rendered_unit="$(mktemp "$unit_dir/wecode.service.XXXXXX")"
sed \
  -e "s|__WECHATBOT_PROJECT_DIR__|$project_dir|g" \
  -e "s|__WECHATBOT_NODE_BIN__|$node_bin|g" \
  -e "s|__WECHATBOT_NODE_DIR__|$node_dir|g" \
  -e "s|__WECHATBOT_HOME_DIR__|$home_dir|g" \
  "$template" > "$rendered_unit"
chmod 0644 "$rendered_unit"
mv -f "$rendered_unit" "$unit_dir/wecode.service"
systemctl --user daemon-reload
systemctl --user enable --now wecode.service
systemctl --user --no-pager --full status wecode.service
