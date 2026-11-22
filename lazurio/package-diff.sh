#!/usr/bin/env bash
# Reads a unified diff of package.json on stdin and prints every added or
# removed content line except the one change a fork release may make: its
# "version" line. Empty output: only the version differs.
#
#   git diff -U0 <upstream-tag> <commit> -- package.json | lazurio/package-diff.sh
#
# Content lines are the +/- lines after the first hunk header, so an added
# property is caught however it is indented ("review_test": true, at column
# 0 included); the ---/+++ file headers are not content.
set -euo pipefail
awk '/^@@/ { hunk = 1; next } hunk && /^[+-]/' \
  | grep -vE '^[+-]  "version": "[^"]+",$' || true
