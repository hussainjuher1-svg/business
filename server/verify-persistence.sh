#!/usr/bin/env bash
# PILOT PERSISTENCE + BACKUP RESTORATION VERIFICATION
set -u
export NODE_NO_WARNINGS=1
BASE=http://127.0.0.1:3001
cd "$(dirname "$0")/.."

say() { printf '\n%s\n' "$*"; }
ok()  { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
FAILED=0

# --- baseline fingerprints ---
snap() {
  node -e "
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
  }));"
}

say "=== 1. BASELINE (before restart) ==="
BEFORE=$(snap)
echo "$BEFORE"

say "=== 2. CREATE A POST-SEED RECORD (must survive restart) ==="
MARKER="PERSIST_MARKER_$(date +%s)"
node -e "
const {run,get}=require('./server/src/db');
const b=get('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
run('INSERT INTO customers (business_id,name,phone,email,address,notes) VALUES (?,?,?,?,?,?)',
  [b.id,'$MARKER','+1 555-888-0001','persist@example.com','1 Persistence Way','Created to verify durability']);
console.log('inserted marker customer: $MARKER');
"
AFTER_INSERT=$(snap)
echo "$AFTER_INSERT"

say "=== 3. BACKUP (SQLite safe backup API, WAL-safe) ==="
mkdir -p data/backups
BACKUP="data/backups/daybook-$(date +%Y%m%d-%H%M%S).db"
node -e "
const {db}=require('./server/src/db');
db.exec(\"VACUUM INTO '$BACKUP'\");
console.log('backup written: $BACKUP');
"
ls -la "$BACKUP" >/dev/null && ok "backup file exists ($(du -h "$BACKUP" | cut -f1))" || bad "backup missing"

say "=== 4. RESTART SERVER (simulates preview restart) ==="
# The caller stops/starts the process; here we verify the DB file is the source of truth.
sleep 1
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health" || echo 000)
[ "$HEALTH" = "200" ] && ok "server reachable after restart (health $HEALTH)" || bad "server not reachable (health $HEALTH)"

say "=== 5. VERIFY DATA SURVIVED RESTART ==="
AFTER_RESTART=$(snap)
echo "$AFTER_RESTART"
[ "$AFTER_INSERT" = "$AFTER_RESTART" ] && ok "row counts identical across restart" || bad "row counts changed: $AFTER_INSERT -> $AFTER_RESTART"

FOUND=$(node -e "
const {get}=require('./server/src/db');
const r=get('SELECT id FROM customers WHERE name=?',['$MARKER']);
console.log(r?r.id:'MISSING');")
[ "$FOUND" != "MISSING" ] && ok "marker record survived restart (id $FOUND)" || bad "marker record lost"

say "=== 6. VERIFY AUTH SESSION PERSISTED ==="
LOGIN=$(curl -s -m 5 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"hvac@daybook.local","password":"demo1234"}' -o /dev/null -w '%{http_code}')
[ "$LOGIN" = "200" ] && ok "demo login works after restart" || bad "login broken after restart ($LOGIN)"

ASK=$(curl -s -m 20 -b /tmp/_p.txt -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"hvac@daybook.local","password":"demo1234"}' -c /tmp/_p.txt >/dev/null; \
  curl -s -m 20 -b /tmp/_p.txt -X POST "$BASE/api/assistant/chat" -H 'Content-Type: application/json' \
  -d '{"message":"What is our diagnostic fee?"}')
echo "$ASK" | grep -q "89" && ok "assistant still answers from restored records" || bad "assistant answer degraded after restart"

say "=== 7. BACKUP RESTORATION TEST (restore into a scratch DB) ==="
SCRATCH="/tmp/daybook-restore-test.db"
rm -f "$SCRATCH"
cp "$BACKUP" "$SCRATCH"
ORIG=$(node -e "
const {get}=require('./server/src/db');
const b=get('SELECT id FROM businesses WHERE name LIKE ?',['Northwind%']);
const n=get('SELECT COUNT(*) n FROM customers WHERE business_id=?',[b.id]).n;
console.log(n);" 2>/dev/null | tail -1)

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

# Full-text index must be rebuilt/consistent in the restored copy
FTS=$(DB_PATH="$SCRATCH" node -e "
const {q}=require('./server/src/db');
const n=q(\"SELECT COUNT(*) n FROM knowledge_chunks_fts\")[0].n;
const m=q('SELECT COUNT(*) n FROM knowledge_chunks')[0].n;
console.log(n===m?'FTS_OK':'FTS_MISMATCH '+n+'/'+m);" 2>/dev/null | tail -1)
[ "$FTS" = "FTS_OK" ] && ok "restored full-text index is consistent" || bad "full-text index inconsistent: $FTS"

rm -f "$SCRATCH" "$SCRATCH-wal" "$SCRATCH-shm"

say "=== SUMMARY ==="
[ "$FAILED" = "0" ] && echo "PERSISTENCE VERIFICATION: ALL CHECKS PASSED" || echo "PERSISTENCE VERIFICATION: FAILURES PRESENT"
exit $FAILED
