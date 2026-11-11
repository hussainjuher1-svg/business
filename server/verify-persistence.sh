#!/usr/bin/env bash
# PILOT PERSISTENCE + BACKUP RESTORATION VERIFICATION
#
# ISOLATION: this script creates its own temporary database, seeds it, and runs
# its own server on port 3401. It never opens, seeds, backs up, or modifies the
# development database (data/daybook.db) or any running preview server.
set -u
export NODE_NO_WARNINGS=1
cd "$(dirname "$0")/.."

PORT=3401
BASE="http://127.0.0.1:$PORT"
TMPDIR_P=$(mktemp -d "${TMPDIR:-/tmp}/daybook-persist-XXXXXX")
TESTDB="$TMPDIR_P/persist.db"
BACKUP="$TMPDIR_P/backup.db"
SCRATCH="$TMPDIR_P/restore.db"
COOKIE_JAR="$TMPDIR_P/cookies.txt"
SERVER_PID=""
FAILED=0

say() { printf '\n%s\n' "$*"; }
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILED=1; }

server_start() {
  DB_PATH="$TESTDB" PORT="$PORT" node server/src/index.js >"$TMPDIR_P/server.log" 2>&1 &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if grep -q "API listening" "$TMPDIR_P/server.log" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  echo "server failed to start:"; cat "$TMPDIR_P/server.log"; return 1
}

server_stop() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}

cleanup() { server_stop; rm -rf "$TMPDIR_P"; }
trap cleanup EXIT

# --- DB helper: run a node snippet against the test database ---
dbq() { DB_PATH="$TESTDB" node -e "$1"; }

snap() {
  dbq "
  const {get}=require('./server/src/db');
  const b=get('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
  const one=(s)=>get(s,[b.id]).n;
  console.log(JSON.stringify({
    id:b.id,
    customers:one('SELECT COUNT(*) n FROM customers WHERE business_id=?'),
    inquiries:one('SELECT COUNT(*) n FROM inquiries WHERE business_id=?'),
    estimates:one('SELECT COUNT(*) n FROM estimates WHERE business_id=?'),
    jobs:one('SELECT COUNT(*) n FROM jobs WHERE business_id=?'),
    followUps:one('SELECT COUNT(*) n FROM follow_ups WHERE business_id=?'),
    knowledge:one('SELECT COUNT(*) n FROM knowledge_items WHERE business_id=?'),
    chunks:one('SELECT COUNT(*) n FROM knowledge_chunks WHERE business_id=?')
  }));" 2>/dev/null | tail -1
}

say "=== 0. ISOLATED TEST DATABASE ==="
echo "Test database: $TESTDB"
DB_PATH="$TESTDB" node server/seed.js >/dev/null 2>&1 || bad "seed.js failed"
DB_PATH="$TESTDB" node server/seed-hvac.js >/dev/null 2>&1 || bad "seed-hvac.js failed"
[ -f "$TESTDB" ] && ok "temporary test database seeded ($(du -h "$TESTDB" | cut -f1))" || bad "test database missing"
server_start || { bad "server did not start"; exit 1; }
ok "isolated server listening on $BASE"

# Rotate the demo password (release blocker #3) via the product's own flow.
HNODE=$(node -e "
const { adoptDemoAccount } = require('./server/test/lib/demo-fixture');
adoptDemoAccount('$BASE','hvac@daybook.local','persist').then(p=>console.log(p)).catch(e=>{console.error(e.message);process.exit(1);});
") || bad "could not rotate the demo password"
[ -n "${HNODE:-}" ] && ok "demo account completed its forced password rotation" || bad "no rotated credential"

say "=== 1. BASELINE (before restart) ==="
BEFORE=$(snap)
echo "$BEFORE"

say "=== 2. CREATE A POST-SEED RECORD (must survive restart) ==="
MARKER="PERSIST_MARKER_$(date +%s)"
dbq "
const {run,get}=require('./server/src/db');
const b=get('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
run('INSERT INTO customers (business_id,name,phone,email,address,notes) VALUES (?,?,?,?,?,?)',
  [b.id,'$MARKER','+1 555-888-0001','persist@example.com','1 Persistence Way','Created to verify durability']);
console.log('inserted marker customer: $MARKER');" 2>/dev/null | tail -1
AFTER_INSERT=$(snap)
echo "$AFTER_INSERT"

say "=== 3. BACKUP (SQLite safe backup API, WAL-safe) ==="
dbq "
const {db}=require('./server/src/db');
db.exec(\"VACUUM INTO '$BACKUP'\");
console.log('backup written');" 2>/dev/null | tail -1
[ -f "$BACKUP" ] && ok "backup file exists ($(du -h "$BACKUP" | cut -f1))" || bad "backup missing"

say "=== 4. RESTART SERVER (hard kill, no graceful shutdown) ==="
# Establish a real logged-in session BEFORE the restart, so we can prove it survives.
LOGIN_CODE=$(curl -s -m 10 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"hvac@daybook.local\",\"password\":\"$HNODE\"}" -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}')
[ "$LOGIN_CODE" = "200" ] && ok "session established before restart (login $LOGIN_CODE)" || bad "login before restart failed ($LOGIN_CODE)"

kill -9 "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null   # reap it so the shell does not print "Killed"
sleep 1
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/health" 2>/dev/null)
[ "$HEALTH" = "000" ] && ok "server is genuinely down after SIGKILL" || bad "server still answering (health ${HEALTH:-none})"
server_start || bad "server did not come back up"
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health" 2>/dev/null)
[ "$HEALTH" = "200" ] && ok "server reachable after restart (health $HEALTH)" || bad "server not reachable (health ${HEALTH:-none})"

say "=== 5. VERIFY DATA SURVIVED RESTART ==="
AFTER_RESTART=$(snap)
echo "$AFTER_RESTART"
[ "$AFTER_INSERT" = "$AFTER_RESTART" ] && ok "row counts identical across restart" || bad "row counts changed: $AFTER_INSERT -> $AFTER_RESTART"

FOUND=$(dbq "
const {get}=require('./server/src/db');
const r=get('SELECT id FROM customers WHERE name=?',['$MARKER']);
console.log(r?r.id:'MISSING');" 2>/dev/null | tail -1)
[ "$FOUND" != "MISSING" ] && ok "marker record survived restart (id $FOUND)" || bad "marker record lost"

say "=== 6. VERIFY AUTH SESSION SURVIVED RESTART ==="
ME_CODE=$(curl -s -o "$TMPDIR_P/me.json" -w '%{http_code}' -m 5 -b "$COOKIE_JAR" "$BASE/api/auth/me" 2>/dev/null)
[ "$ME_CODE" = "200" ] && ok "pre-restart session cookie still valid after restart" || bad "session lost across restart ($ME_CODE)"

ASK=$(curl -s -m 20 -b "$COOKIE_JAR" -X POST "$BASE/api/assistant/chat" -H 'Content-Type: application/json' \
  -d '{"message":"What is our diagnostic fee?"}')
echo "$ASK" | grep -q "89" && ok "assistant still answers from restored records" || bad "assistant answer degraded after restart"

say "=== 7. BACKUP RESTORATION TEST (restore into a scratch DB) ==="
cp "$BACKUP" "$SCRATCH"
ORIG=$(dbq "
const {get}=require('./server/src/db');
const b=get('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
console.log(get('SELECT COUNT(*) n FROM customers WHERE business_id=?',[b.id]).n);" 2>/dev/null | tail -1)

RESTORED=$(DB_PATH="$SCRATCH" node -e "
const {q}=require('./server/src/db');
const b=q('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
if(!b.length){console.log('RESTORE_FAILED');process.exit(0);}
const n=q('SELECT COUNT(*) n FROM customers WHERE business_id=?',[b[0].id])[0].n;
const k=q('SELECT COUNT(*) n FROM knowledge_items WHERE business_id=?',[b[0].id])[0].n;
const c=q('SELECT COUNT(*) n FROM knowledge_chunks WHERE business_id=?',[b[0].id])[0].n;
console.error('  restored counts -> customers:'+n+' knowledge:'+k+' chunks:'+c);
console.log(n);" 2>&1 | tail -1)

echo "  live customers=$ORIG  restored customers=$RESTORED"
[ "$ORIG" = "$RESTORED" ] && [ -n "$RESTORED" ] && ok "restored backup matches live data" || bad "restore mismatch (live=$ORIG restored=$RESTORED)"

FTS=$(DB_PATH="$SCRATCH" node -e "
const {q}=require('./server/src/db');
const n=q(\"SELECT COUNT(*) n FROM knowledge_chunks_fts\")[0].n;
const m=q('SELECT COUNT(*) n FROM knowledge_chunks')[0].n;
console.log(n===m?'FTS_OK':'FTS_MISMATCH '+n+'/'+m);" 2>/dev/null | tail -1)
[ "$FTS" = "FTS_OK" ] && ok "restored full-text index is consistent" || bad "full-text index inconsistent: $FTS"

say "=== SUMMARY ==="
echo "Test database: $TESTDB (temporary, removed on exit)"
[ "$FAILED" = "0" ] && echo "PERSISTENCE VERIFICATION: ALL CHECKS PASSED" || echo "PERSISTENCE VERIFICATION: FAILURES PRESENT"
exit $FAILED
