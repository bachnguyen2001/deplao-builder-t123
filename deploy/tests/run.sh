#!/usr/bin/env bash
# Runs every deploy/tests/test_*.sh. Usage (repo root): bash deploy/tests/run.sh
set -Eeuo pipefail
# Git Bash on Windows: never rewrite /paths passed to native programs.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' MSYS2_ENV_CONV_EXCL='*'
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
failed=0
for t in deploy/tests/test_*.sh; do
  if bash "$t"; then echo "PASS $t"; else echo "FAIL $t"; failed=1; fi
done
exit "$failed"
