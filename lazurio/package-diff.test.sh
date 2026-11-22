#!/usr/bin/env bash
# Tests lazurio/package-diff.sh, the package.json part of lazurio/fork-check.sh.
#
#   bash lazurio/package-diff.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
failed=0
check() { # <name> <expected output> <diff>
  local got
  got=$(printf '%s\n' "$3" | bash "$here/package-diff.sh")
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$2], got [$got]"; failed=1; fi
}
header='diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json'

check 'only the version line' '' "$header
@@ -3 +3 @@
-  \"version\": \"0.60.733.0\",
+  \"version\": \"0.60.733.0-lazurio.2\","

check 'an unindented property' '+"review_test": true,' "$header
@@ -3 +3,2 @@
-  \"version\": \"0.60.733.0\",
+  \"version\": \"0.60.733.0-lazurio.2\",
+\"review_test\": true,"

check 'an indented property' '+  "private": true,' "$header
@@ -4,0 +5 @@
+  \"private\": true,"

check 'a removed line' '-    "test": "bun test",' "$header
@@ -9 +8,0 @@
-    \"test\": \"bun test\","

check 'a removed line that starts with dashes' '--- a comment' "$header
@@ -9 +8,0 @@
--- a comment"

check 'a version line that is not the top-level one' '-    "version": "0.9.0",
+    "version": "1.0.0",' "$header
@@ -20 +20 @@
-    \"version\": \"0.9.0\",
+    \"version\": \"1.0.0\","

check 'no difference' '' ''

exit $failed
