#!/usr/bin/env bash
set -u
log="${FAKE_TMUX_LOG:?FAKE_TMUX_LOG must point at a writable file}"
{ for argument in "$@"; do printf '%s\037' "$argument"; done; printf '\n'; } >> "$log"
case "${1:-}" in
  split-window) printf '%%42\n' ;;
  display-message) printf '@1\n' ;;
  list-panes) printf '%%0\tOmO\t@1\t1\n' ;;
  select-pane) : ;;
  kill-pane) : ;;
  *) : ;;
esac
