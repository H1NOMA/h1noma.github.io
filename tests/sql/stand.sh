#!/usr/bin/env bash
# База для стенда на настоящем Postgres: «Supabase»-заглушка + все миграции, как на сервере (push.sh).
#   PGHOST=… PGPORT=… PGUSER=postgres bash tests/sql/stand.sh [база]       (по умолчанию komik_stand)
#   python3 tests/mock_cloud.py --pg komik_stand --seed снимок.json        — браузерные проверки ходят в неё
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${1:-komik_stand}
MIGS=$(sed -n 's/^MIGS="\(.*\)"$/\1/p' migrate/push.sh)
psql -q -X -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
q(){ psql -q -X -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
q -f tests/sql/supabase_stub.sql >/dev/null 2>&1
{ echo 'begin;'; for f in $MIGS; do sed -e '/^begin;$/d' -e '/^commit;$/d' "migrate/$f"; done; echo 'commit;'; } | q >/dev/null 2>&1
echo "база $DB: заглушка + $MIGS"
