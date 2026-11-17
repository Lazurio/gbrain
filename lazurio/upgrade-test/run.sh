#!/usr/bin/env bash
# Upgrade test for a Lazurio release of the gbrain fork.
#
#   lazurio/upgrade-test/run.sh <work-dir> <from-ref> <to-ref> [port]
#
# <from-ref> and <to-ref> are what bun installs, e.g.
#   github:Lazurio/gbrain#v0.60.315.0-lazurio.1  github:Lazurio/gbrain#v0.60.733.0-lazurio.1
#
# It builds a brain on <from-ref> the way Lazurio sets one up (PGLite, no
# embeddings, a content root that is a git checkout with an origin, git
# durability on, API keys minted over the admin API), fills it with fictional
# pages, links and facts over MCP, then:
#   1. stops the server, backs up ~/.gbrain, the vault and its remote;
#   2. starts <to-ref> on the same brain (its migrations run at start);
#   3. compares counts, ids, links, recall, token names and scopes, and the
#      tool surface (no tool or parameter removed, retyped or newly required);
#   4. checks the vault: no file changed by the upgrade, a new write commits
#      and pushes;
#   5. starts <from-ref> again on the migrated brain (the way back);
#   6. restores the backup and checks it equals the starting snapshot.
# Everything stays under <work-dir> and on 127.0.0.1:<port>. No real data.
set -euo pipefail
WORK=$(realpath -m "$1"); FROM=$2; TO=$3; PORT=${4:-3191}
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=http://127.0.0.1:$PORT
RUN=$WORK/run; H=$RUN/home; VAULT=$RUN/vault; REMOTE=$RUN/vault-remote.git; TOK=$RUN/tokens
export GBRAIN_HOME=$H GIT_TERMINAL_PROMPT=0 GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1
say() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*"; exit 1; }

install() { # install <ref> <dir>
  mkdir -p "$2"; [ -x "$2/node_modules/.bin/gbrain" ] && return
  (cd "$2" && echo '{}' > package.json && bun add --backend=copyfile "$1" > install.log 2>&1)
}
serve() { # serve <dir> start|stop
  local pidf=$RUN/serve.pid
  if [ "$2" = start ]; then
    GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat "$H/.gbrain/serve/admin-token")" setsid "$1/node_modules/.bin/gbrain" \
      serve --http --bind 127.0.0.1 --port "$PORT" --public-url "$BASE" >> "$RUN/serve-$(basename "$1").log" 2>&1 < /dev/null &
    echo $! > "$pidf"
    for _ in $(seq 1 300); do
      curl -fsS "$BASE/health" > /dev/null 2>&1 && return 0
      kill -0 "$(cat "$pidf")" 2> /dev/null || fail "server $(basename "$1") exited"
      sleep 1
    done
    fail "server $(basename "$1") not healthy"
  else
    local p; p=$(cat "$pidf"); kill -TERM "$p" 2> /dev/null || true
    for _ in $(seq 1 60); do kill -0 "$p" 2> /dev/null || return 0; sleep 1; done
    fail "server pid $p did not stop"
  fi
}
py() { python3 -I "$HERE/$1" "${@:2}"; }
gb() { "$1/node_modules/.bin/gbrain" "${@:2}"; }
json_field() { python3 -c 'import json,sys;t=sys.stdin.read();d=json.JSONDecoder().raw_decode(t[t.index("{"):])[0];print(eval(sys.argv[1],{},{"d":d}))' "$1"; }
snapshot() { py snapshot.py "$HERE" "$BASE" "$TOK/hermes-buddy" "$TOK/lazurio-launchpad-brain" "$H/.gbrain/serve/admin-token" "$WORK/snap-$1.json"; }
tools() { py mcp.py tools "$BASE" "$TOK/hermes-buddy" > "$WORK/tools-$1-rw.json"; py mcp.py tools "$BASE" "$TOK/lazurio-launchpad-brain" > "$WORK/tools-$1-ro.json"; }

[ -e "$RUN" ] && fail "$RUN exists; use an empty work dir"
mkdir -p "$WORK"; say "install"; install "$FROM" "$WORK/from"; install "$TO" "$WORK/to"
echo "from $(gb "$WORK/from" --version)  to $(gb "$WORK/to" --version)"

say "brain on from (as Lazurio sets it up)"
mkdir -p "$H" "$VAULT" "$TOK"; chmod 700 "$TOK"
git init -q --bare -b main "$REMOTE"
SEED=$(mktemp -d "$WORK/seed.XXXX"); git -C "$SEED" init -q -b main; printf '# Vault\n' > "$SEED/README.md"
git -C "$SEED" add -A; git -C "$SEED" -c user.name=test -c user.email=test@example.invalid commit -qm seed
git -C "$SEED" push -q "$REMOTE" main; rm -rf "$SEED"
gb "$WORK/from" init --pglite --no-embedding --non-interactive --content-root "$VAULT" --git --json > "$RUN/init.json" 2> "$RUN/init.err"
mkdir -p "$H/.gbrain/serve"; chmod 700 "$H/.gbrain/serve"
(umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$H/.gbrain/serve/admin-token")
git -C "$VAULT" remote add origin "$REMOTE"; git -C "$VAULT" fetch -q origin main
for n in LICENSE README.md skillpack.json skills; do [ -e "$VAULT/$n" ] && mv "$VAULT/$n" "$RUN/content-root-$n" || true; done
git -C "$VAULT" checkout -q -B main origin/main; git -C "$VAULT" branch -q --set-upstream-to=origin/main main
git -C "$VAULT" config user.name gbrain-test; git -C "$VAULT" config user.email test@example.invalid
gb "$WORK/from" config set sync.on_commit true > /dev/null
serve "$WORK/from" start
STATE=$(gb "$WORK/from" sources writer status default --json 2> /dev/null | json_field 'd["admin_state"]')
gb "$WORK/from" sources writer git-durability default --enable --admin-intent writer_git_durability \
  --expected-state "$STATE" --json > "$RUN/durability.json" 2>&1 || fail "git durability not enabled (see $RUN/durability.json)"
for t in "hermes-buddy read,write" "executor-personal-gbrain read,write" "lazurio-launchpad-brain read"; do
  set -- $t; py mcp.py mint "$BASE" "$H/.gbrain/serve/admin-token" "$1" "$2" "$TOK/$1" > /dev/null
done
py populate.py "$HERE" "$BASE" "$TOK/hermes-buddy" > "$WORK/populate.json"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));bad=[p for p in d["put_page"] if p[1]]+[r for r in d["remember"] if r[1]];sys.exit(1 if bad else 0)' "$WORK/populate.json" || fail "populate had errors"
sleep 20
snapshot from; tools from
say "backup and upgrade"
serve "$WORK/from" stop
mkdir -p "$WORK/backup"; cp -a "$H/.gbrain" "$WORK/backup/dot-gbrain"; cp -a "$VAULT" "$WORK/backup/vault"; cp -a "$REMOTE" "$WORK/backup/vault-remote.git"
serve "$WORK/to" start
grep -E 'migration\(s\) applied' "$RUN/serve-to.log" || true
snapshot to; tools to

say "compare"
python3 -I - "$WORK" <<'EOF'
import json, sys
w = sys.argv[1]; problems = []
a = json.load(open(f'{w}/snap-from.json')); b = json.load(open(f'{w}/snap-to.json'))
for k, v in a['calls'].items():
    if k == 'get_brain_identity':
        for f in ('page_count', 'chunk_count', 'engine'):
            if v.get(f) != b['calls'][k].get(f): problems.append(f'{k}.{f}: {v.get(f)} -> {b["calls"][k].get(f)}')
    elif v != b['calls'].get(k):
        problems.append(f'{k} differs')
for k, v in a['shapes'].items():
    if v != b['shapes'].get(k): print(f'note: output shape of {k} changed (check it is additive)')
for mode in ('rw', 'ro'):
    t1 = {t['name']: t for t in json.load(open(f'{w}/tools-from-{mode}.json'))['tools']}
    t2 = {t['name']: t for t in json.load(open(f'{w}/tools-to-{mode}.json'))['tools']}
    gone = sorted(set(t1) - set(t2))
    if gone: problems.append(f'{mode}: tools removed {gone}')
    print(f'{mode}: {len(t1)} -> {len(t2)} tools, added {sorted(set(t2) - set(t1))}')
    for n in sorted(set(t1) & set(t2)):
        s1, s2 = t1[n]['inputSchema'], t2[n]['inputSchema']
        p1, p2 = s1.get('properties', {}), s2.get('properties', {})
        rem = sorted(set(p1) - set(p2))
        typ = sorted(k for k in set(p1) & set(p2) if p1[k].get('type') != p2[k].get('type')
                     or set(p1[k].get('enum') or []) - set(p2[k].get('enum') or []))
        req = sorted(set(s2.get('required', [])) - set(s1.get('required', [])))
        if rem or typ or req: problems.append(f'{mode} {n}: removed {rem} retyped {typ} newly required {req}')
print('PROBLEMS:' if problems else 'compare: ok', *problems, sep='\n  ')
sys.exit(1 if problems else 0)
EOF

say "vault"
diff -rq --exclude=.git "$WORK/backup/vault" "$VAULT" && echo "vault unchanged by the upgrade" || fail "upgrade changed vault files"
HEAD0=$(git -C "$REMOTE" rev-parse main)
py mcp.py call "$BASE" "$TOK/executor-personal-gbrain" remember '{"source_id":"default","entity":"bob-tester","fact":"Written after the upgrade.","kind":"fact","visibility":"world","provenance":"gbrain upgrade test"}' > "$WORK/remember-after.json"
for _ in $(seq 1 60); do [ "$(git -C "$REMOTE" rev-parse main)" != "$HEAD0" ] && break; sleep 1; done
[ "$(git -C "$REMOTE" rev-parse main)" != "$HEAD0" ] || fail "write after upgrade did not reach the remote"
git -C "$REMOTE" diff --stat "$HEAD0" main
py mcp.py mint "$BASE" "$H/.gbrain/serve/admin-token" lazurio-read-after-upgrade read "$TOK/after" > /dev/null && echo "read key minted on to"

say "way back: from on the migrated brain"
serve "$WORK/to" stop
if serve "$WORK/from" start; then
  py mcp.py call "$BASE" "$TOK/hermes-buddy" recall '{"entity":"bob-tester"}' | json_field '"recall total %s, error %s" % (d["result"].get("total"), d["isError"])'
  serve "$WORK/from" stop
fi

say "restore the backup"
rm -rf "$H/.gbrain" "$VAULT" "$REMOTE"
cp -a "$WORK/backup/dot-gbrain" "$H/.gbrain"; cp -a "$WORK/backup/vault" "$VAULT"; cp -a "$WORK/backup/vault-remote.git" "$REMOTE"
serve "$WORK/from" start; snapshot restored; serve "$WORK/from" stop
python3 -c 'import json,sys;a=json.load(open(sys.argv[1]))["calls"];b=json.load(open(sys.argv[2]))["calls"];sys.exit(0 if a==b else 1)' \
  "$WORK/snap-from.json" "$WORK/snap-restored.json" && echo "restored brain equals the starting snapshot" || fail "restore differs"
say "PASS"
