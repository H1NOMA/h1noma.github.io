#!/usr/bin/env python3
"""Локальный стенд КОМИК: сайт + имитация облака (Supabase) на одном адресе.

Запуск:  python3 tests/mock_cloud.py [--port 8765] [--seed файл.json] [--fail 0.2] [--slow 300]
В браузере (или в тесте Playwright) перед загрузкой страницы:
  localStorage.setItem('comik:cloud', JSON.stringify({url:'http://127.0.0.1:8765', key:'anon'}))
— сайт начнёт ходить в этот стенд (CSP пускает: тот же адрес, что у самой страницы).

Что умеет:
  · /rest/v1/kv — GET (select с псевдонимами value->>поле, фильтры eq/in/like/is), POST (insert/upsert),
    PATCH (CAS по value->>rev) — те запросы, что шлёт index.html;
  · права как на сервере (миграции 09-21…09-27 + 10-28): аноним только читает, игрок пишет свои строки
    и общие (с потолком размера), команда (DEVS) — всё; строки comik:img:<хэш> — только с верным хэшем;
  · миграция 10-29 (по умолчанию включена, /__mock/fail {"v3": false} — сервер без неё): чтение белым списком
    (чужие листы — только витрина /rest/v1/kv_chars_pub), личные пуш-подписки push:sub:<тег>,
    rpc komik_api_version → 3. Санитайзер общих строк (игрок меняет только своё) стенд сам не повторяет;
  · API 4 (по умолчанию включён, /__mock/fail {"v4": false} — сервер без него, версия 3): rpc komik_delete_me —
    игрок сам удаляет аккаунт (свои строки, портреты без других ссылок, записи на игры, тег на доске, реестр,
    пользователь); пароль нужен свежий (amr в токене), команде нельзя; запись токеном удалённого — 42501,
    логин занят 90 дней;
  · --pg БАЗА — вместо имитации прав REST идёт в настоящий Postgres с миграциями (tests/sql/stand.sh): те же
    правила RLS, триггеры, витрина, санитайзер — запросы сайта переводятся в SQL и выполняются через psql от
    имени anon/authenticated с токеном, как это делает PostgREST;
  · /auth/v1 — вход по паролю, регистрация (автоподтверждение), обновление токена, выход, user, смена пароля;
  · /functions/v1/notify-game — отдаёт публичный ключ, рассылку только считает;
  · /__mock/rows (GET — все строки, POST — заменить), /__mock/log (GET — журнал, DELETE — очистить),
    /__mock/fail (POST {"rate":0.2,"slow":300,"v3":true,"v4":true}) — обрывы, задержка, версия сервера.
Сид — массив строк [{key, value}] (формат ежедневного бэкапа kv) или {rows:[…]}.
"""
import argparse, base64, hashlib, json, os, random, re, subprocess, sys, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlsplit, parse_qsl, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVS = {'hinoma', 'herr_teo', 'arlissss'}
LOCK = threading.RLock()   # note() зовётся и под замком (отказ в записи)
ROWS = {}            # key → value (jsonb)
USERS = {}           # email → {id, email, password}
LOG = []             # [{t, method, path, key, bytes, status}]
FAIL = {'rate': 0.0, 'slow': 0, 'player_img': True, 'v3': True, 'v4': True}   # player_img: False — сервер без миграции 10-28; v3: False — без 10-29; v4: False — без удаления аккаунта
GONE = {}            # uid → {tag, at}: удалённые аккаунты (komik_gone) — их токен ничего не пишет, логин занят GONE_DAYS
GONE_DAYS = 90
REAUTH_S = 600       # komik:reauth — пароль вводили не позже 10 минут назад
PUBLIC_READ = {'comik:archive:v1', 'comik:news:v1', 'comik:chrono:v1', 'comik:hero:v1', 'comik:projects:v1', 'comik:games:v1',
               'comik:tracker:shared:v1', 'comik:users:v1', 'comik:coreover:v1', 'comik:corehid:v1'}
PUB_FIELDS = ['id', 'owner', 'alias', 'name', 'player', 'ava', 'role', 'subcls', 'origin', 'subrace', 'level', 'hp', 'ac', 'init',
              'speed', 'deleted', 'createdAt', 'updatedAt']
VAPID = 'B' + 'A' * 86
PG = None            # имя базы в режиме --pg


def user_id(email):
    return str(uuid.UUID(hashlib.md5(email.encode()).hexdigest()))


# ── режим --pg: настоящий Postgres вместо имитации ──
def lit(v):
    """строковый литерал SQL в долларовых кавычках"""
    s, tag = str(v), 'q'
    while '$' + tag + '$' in s:
        tag += 'q'
    return '$' + tag + '$' + s + '$' + tag + '$'


def pg_run(sql, claims=None):
    """(вывод, None) или (None, (sqlstate, сообщение)). claims — токен: None = владелец базы (postgres)"""
    head = 'begin;\n'
    if claims is not None:
        head += 'set local role %s;\nset local request.jwt.claims to %s;\n' % (
            'authenticated' if claims.get('role') == 'authenticated' else 'anon', lit(json.dumps(claims)))
    r = subprocess.run(['psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', PG],
                       input='\\set VERBOSITY verbose\n' + head + sql + ';\ncommit;\n', capture_output=True, text=True)
    if r.returncode != 0:
        m = re.search(r'ERROR:\s+([0-9A-Z]{5}):\s*(.*)', r.stderr)
        return None, (m.group(1), m.group(2)) if m else ('XX000', r.stderr.strip()[:300])
    return r.stdout.strip(), None


def pg_col(expr):
    if expr in ('key', 'value'):
        return expr
    m = re.fullmatch(r'value->>(\w+)', expr)
    if m:
        return "value->>'%s'" % m.group(1)
    raise ValueError('колонка ' + expr)


def pg_where(filters):
    conds = []
    for col, op in filters:
        c = pg_col(col)
        kind, _, arg = op.partition('.')
        if kind == 'eq':
            conds.append('%s = %s' % (c, lit(arg)))
        elif kind == 'in':
            conds.append('%s in (%s)' % (c, ', '.join(lit(x) for x in parse_in(arg)) or 'null'))
        elif kind == 'like':
            conds.append('%s like %s' % (c, lit(arg.replace('*', '%'))))
        elif kind == 'is' and arg == 'null':
            conds.append('%s is null' % c)
        else:
            raise ValueError('фильтр ' + op)
    return ' and '.join(conds) or 'true'


def pg_proj(select):
    if not select or select == '*':
        return "json_build_object('key', key, 'value', value)"
    parts = []
    for part in select.split(','):
        part = part.strip()
        alias, _, expr = part.partition(':')
        if not expr:
            expr, alias = alias, alias.split('->>')[-1]
        parts.append('%s, %s' % (lit(alias), pg_col(expr)))
    return 'json_build_object(%s)' % ', '.join(parts)


def pg_rows():
    out, err = pg_run("select coalesce(json_agg(json_build_object('key', key, 'value', value)), '[]') from public.kv")
    return json.loads(out) if out else []


def pg_load(rows):
    return pg_run('truncate public.kv; insert into public.kv (key, value) select r->>\'key\', r->\'value\' from json_array_elements(%s::json) r'
                  % lit(json.dumps(rows, ensure_ascii=False)))


def jwt(payload):
    enc = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b'=').decode()
    return enc({'alg': 'HS256', 'typ': 'JWT'}) + '.' + enc(payload) + '.bW9jaw'


def jwt_payload(tok):
    try:
        p = tok.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4)))
    except Exception:
        return {}


def player_cap(tag, key):
    """public.kv_player_cap: потолок размера строки для игрока (байты) или None — писать нельзя"""
    if not re.fullmatch(r'[a-z0-9_]{4,32}', tag or ''):
        return None
    caps = {'comik:tracker:shared:v1': 8388608, 'comik:games:v1': 524288, 'comik:users:v1': 262144,
            'comik:chars:' + tag: 10485760, 'comik:bm:' + tag: 262144}
    if FAIL['v3']:
        caps['push:sub:' + tag] = 65536
    else:
        caps['push:subs'] = 524288
    if key in caps:
        return caps[key]
    if key.startswith('comik:img:') and FAIL['player_img']:
        return 1572864
    return None


def img_ok(key, value):
    """строка картинки: ключ — это хэш содержимого (как проверка kv_img_ok в миграции 10-28)"""
    if not key.startswith('comik:img:'):
        return True
    if not isinstance(value, str) or not value.startswith('data:image/'):
        return False
    return key == 'comik:img:' + hashlib.sha256(value.encode('utf-8')).hexdigest()[:32]


def can_read(tag, key):
    """правило kv_read: до 10-29 — всё всем; после — белый список, своё владельцу, всё команде"""
    if not FAIL['v3'] or tag in DEVS:
        return True
    if key in PUBLIC_READ or key.startswith('comik:img:') or key.startswith('comik:trk:bg:'):
        return True
    return bool(tag) and key in ('comik:chars:' + tag, 'comik:bm:' + tag, 'push:sub:' + tag)


def char_pub(c):
    """komik_char_pub: из листа — только поля витрины; портрет — только ссылкой"""
    out = {f: c[f] for f in PUB_FIELDS if c.get(f) is not None}
    if not re.fullmatch(r'kvimg:[0-9a-f]{32}|img/[A-Za-z0-9_./-]{1,200}', str(out.get('ava') or '')):
        out.pop('ava', None)
    return out


def pub_rows():
    return [{'key': k, 'value': dict({'at': v.get('at')}, **{g: [char_pub(c) for c in a if isinstance(c, dict)]
                                                             for g, a in v.items() if isinstance(a, list)})}
            for k, v in ROWS.items() if k.startswith('comik:chars:') and isinstance(v, dict)]


def can_write(tag, key, value, insert):
    size = len(json.dumps(value, ensure_ascii=False).encode('utf-8'))
    if not img_ok(key, value):
        return False
    if tag in DEVS:
        return True
    if key == 'comik:projects:v1':
        return tag == 'hinoma'
    cap = player_cap(tag, key)
    return cap is not None and size <= cap


def like_re(pat):
    out, i = '', 0
    while i < len(pat):
        c = pat[i]
        if c == '\\' and i + 1 < len(pat):
            out += re.escape(pat[i + 1]); i += 2; continue
        out += '.*' if c in '%*' else ('.' if c == '_' else re.escape(c))
        i += 1
    return re.compile('^' + out + '$', re.S)


def parse_in(v):
    v = v.strip()
    if v.startswith('(') and v.endswith(')'):
        v = v[1:-1]
    out, cur, q = [], '', False
    for ch in v:
        if ch == '"':
            q = not q; continue
        if ch == ',' and not q:
            out.append(cur); cur = ''; continue
        cur += ch
    out.append(cur)
    return out


def field(row, expr):
    if expr == 'key':
        return row['key']
    if expr == 'value':
        return row['value']
    m = re.fullmatch(r'value->>(\w+)', expr)
    if m:
        v = row['value']
        if isinstance(v, dict) and m.group(1) in v:
            x = v[m.group(1)]
            if x is None:
                return None
            return x if isinstance(x, str) else json.dumps(x)
        return None
    return None


def match(row, filters):
    for col, op in filters:
        v = field(row, col)
        kind, _, arg = op.partition('.')
        if kind == 'eq':
            if v is None or str(v) != arg: return False
        elif kind == 'in':
            if v not in parse_in(arg): return False
        elif kind == 'like':
            if v is None or not like_re(arg).match(str(v)): return False
        elif kind == 'is':
            if arg == 'null' and v is not None: return False
            if arg != 'null': return False
        else:
            return False
    return True


def project(row, select):
    if not select or select == '*':
        return {'key': row['key'], 'value': row['value']}
    out = {}
    for part in select.split(','):
        part = part.strip()
        alias, _, expr = part.partition(':')
        if not expr:
            expr, alias = alias, alias.split('->>')[-1]
        out[alias] = field(row, expr)
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def tag_gone(tag):
    """логин удалённого аккаунта ещё не освободился (komik_email_guard)"""
    return any(g['tag'] == tag and time.time() - g['at'] < GONE_DAYS * 86400 for g in GONE.values())


def delete_me(tag, uid):
    """komik_delete_me без базы — те же шаги, что у серверной функции. Зовётся под LOCK"""
    now = int(time.time() * 1000)
    GONE[uid] = {'tag': tag, 'at': time.time()}
    pics = set(re.findall(r'kvimg:([0-9a-f]{32})', json.dumps(ROWS.get('comik:chars:' + tag))))
    n = 0
    for k in ('comik:chars:' + tag, 'comik:bm:' + tag, 'push:sub:' + tag):
        if ROWS.pop(k, None) is not None:
            n += 1
    # портреты своих листов — если на них больше никто не ссылается
    rest = json.dumps([v for k, v in ROWS.items() if not k.startswith('comik:img:')])
    imgs = sum(1 for h in pics if 'kvimg:' + h not in rest and ROWS.pop('comik:img:' + h, None) is not None)
    # живые игры: своя запись снимается с отметкой gone[тег] — не раньше «сейчас» и строго новее записи
    games = ROWS.get('comik:games:v1')
    for s in games if isinstance(games, list) else []:
        if not isinstance(s, dict) or s.get('deleted') is True or not isinstance(s.get('players'), list):
            continue
        me = [p for p in s['players'] if isinstance(p, dict) and str(p.get('tag') or '').lower() == tag]
        if me:
            s['players'] = [p for p in s['players'] if not any(p is m for m in me)]
            s['gone'] = dict(s['gone'] if isinstance(s.get('gone'), dict) else {})
            s['gone'][tag] = max(now, 1 + int(max(max(num(p.get('upd')), num(p.get('at'))) for p in me)))
    # доска: свой тег с карточек снимается, rev растёт — условная запись ГМа поверх старой версии не пройдёт
    board = ROWS.get('comik:tracker:shared:v1')
    if isinstance(board, dict) and '"%s"' % tag in json.dumps(board).lower():
        for bv in board.values():
            for c in bv.get('list') if isinstance(bv, dict) and isinstance(bv.get('list'), list) else []:
                if isinstance(c, dict) and str(c.get('ownTag') or '').lower() == tag:
                    del c['ownTag']
        rev = str(board.get('rev') or '')
        board['rev'] = int(rev) + 1 if re.fullmatch(r'\d{1,15}', rev) else 1
    users = ROWS.get('comik:users:v1')
    if isinstance(users, list):
        ROWS['comik:users:v1'] = [u for u in users if not (isinstance(u, dict) and str(u.get('tag') or '').lower() == tag)]
    USERS.pop(tag + '@komikdnd.ru', None)
    return {'ok': True, 'tag': tag, 'rows': n, 'imgs': imgs}


class H(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    # ── общие ответы ──
    def send_json(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8') if obj is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)
        return len(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode('utf-8')) if raw else None
        except Exception:
            return None

    def claims(self):
        p = jwt_payload((self.headers.get('Authorization') or '').replace('Bearer ', ''))
        return p if p.get('role') == 'authenticated' else {'role': 'anon'}

    def pg_err(self, err, key=''):
        code, msg = err
        st = {'42501': 403 if self.tag() is not None else 401, '23505': 409, '42P01': 404, '42883': 404}.get(code, 400)
        self.note(key, 0, st)
        return self.send_json(st, {'code': code, 'message': msg})

    def pg_rest(self, u):
        """REST в режиме --pg: GET/POST/PATCH к kv и витрине — тем же SQL, что строит PostgREST"""
        table = u.path.rsplit('/', 1)[-1]
        if table not in ('kv', 'kv_chars_pub'):
            return self.send_json(404, {'message': 'only kv in mock'})
        select, filters = self.query(u)
        keyf = next((op for col, op in filters if col == 'key'), '')
        try:
            where, proj = pg_where(filters), pg_proj(select)
        except ValueError as e:
            return self.send_json(400, {'message': str(e)})
        prefer = self.headers.get('Prefer') or ''
        if self.command == 'GET':
            sql = "select coalesce(json_agg(%s), '[]') from public.%s where %s" % (proj, table, where)
        elif self.command == 'POST':
            b = self.body()
            rows = b if isinstance(b, list) else [b]
            if not rows or not all(isinstance(r, dict) and 'key' in r for r in rows):
                return self.send_json(400, {'message': 'bad row'})
            keyf = rows[0]['key']
            vals = ', '.join('(%s, %s::jsonb)' % (lit(r['key']), lit(json.dumps(r.get('value'), ensure_ascii=False))) for r in rows)
            ups = ' on conflict (key) do update set key = excluded.key, value = excluded.value' if 'merge-duplicates' in prefer else ''
            sql = "with x as (insert into public.%s (key, value) values %s%s returning key, value) select coalesce(json_agg(%s), '[]') from x" % (table, vals, ups, proj)
        else:
            b = self.body() or {}
            sets = []
            if 'value' in b:
                sets.append('value = %s::jsonb' % lit(json.dumps(b['value'], ensure_ascii=False)))
            if 'key' in b:
                sets.append('key = %s' % lit(b['key']))
            sql = "with x as (update public.%s set %s where %s returning key, value) select coalesce(json_agg(%s), '[]') from x" % (table, ', '.join(sets) or 'key = key', where, proj)
        out, err = pg_run(sql, self.claims())
        if err:
            return self.pg_err(err, keyf)
        res = json.loads(out or '[]')
        if self.command == 'GET' and 'vnd.pgrst.object' in (self.headers.get('Accept') or ''):
            if len(res) != 1:
                n = self.send_json(406, {'code': 'PGRST116', 'message': 'JSON object requested, multiple (or no) rows returned', 'details': 'The result contains %d rows' % len(res)})
                return self.note(keyf, n, 406)
            n = self.send_json(200, res[0])
            return self.note(keyf, n, 200)
        code = 200 if self.command != 'POST' else 201
        if self.command != 'GET' and 'return=representation' not in prefer:
            n = self.send_json(201 if self.command == 'POST' else 204, None)
        else:
            n = self.send_json(code, res)
        self.note(keyf, n, code)

    def gone(self):
        """токен удалённого аккаунта (триггер komik_kv_gone): запись — 42501"""
        return self.claims().get('sub') in GONE

    def tag(self):
        tok = (self.headers.get('Authorization') or '').replace('Bearer ', '')
        p = jwt_payload(tok)
        if p.get('role') != 'authenticated':
            return None
        m = re.fullmatch(r'([a-z0-9_]{4,32})@komikdnd\.ru', (p.get('email') or '').lower())
        return m.group(1) if m else ''

    def chaos(self):
        """обрыв соединения или задержка — как у живого сервера на плохой сети"""
        if FAIL['slow']:
            time.sleep(FAIL['slow'] / 1000.0)
        if FAIL['rate'] and random.random() < FAIL['rate']:
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except Exception:
                pass
            return True
        return False

    def note(self, key, nbytes, status):
        with LOCK:
            LOG.append({'t': time.time(), 'method': self.command, 'path': urlsplit(self.path).path, 'key': key, 'bytes': nbytes, 'status': status})
            del LOG[:-5000]

    # ── маршруты ──
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path.startswith('/rest/v1/'):
            if self.chaos(): return
            return self.rest_get(u)
        if u.path.startswith('/auth/v1/'):
            if self.chaos(): return
            return self.auth(u)
        if u.path.startswith('/functions/v1/'):
            return self.send_json(200, {'publicKey': VAPID})
        if u.path.startswith('/realtime/'):
            return self.send_json(404, {'error': 'no realtime in mock'})
        if u.path == '/__mock/rows':
            if PG:
                return self.send_json(200, pg_rows())
            with LOCK:
                rows = [{'key': k, 'value': v} for k, v in ROWS.items()]
            return self.send_json(200, rows)
        if u.path == '/__mock/log':
            with LOCK:
                return self.send_json(200, list(LOG))
        return super().do_GET()

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        u = urlsplit(self.path)
        if u.path == '/__mock/rows':
            b = self.body()
            rows = b.get('rows') if isinstance(b, dict) else b
            if PG:
                _, err = pg_load(rows or [])
                return self.send_json(500 if err else 200, {'ok': not err, 'rows': len(rows or []), 'error': err})
            with LOCK:
                ROWS.clear(); ROWS.update({r['key']: r['value'] for r in rows or []})
            return self.send_json(200, {'ok': True, 'rows': len(ROWS)})
        if u.path == '/__mock/fail':
            b = self.body() or {}
            FAIL['rate'] = float(b.get('rate') or 0); FAIL['slow'] = int(b.get('slow') or 0)
            FAIL['player_img'] = b.get('player_img', True) is not False
            FAIL['v3'] = b.get('v3', True) is not False or bool(PG)   # настоящая база — всегда с 10-29
            FAIL['v4'] = b.get('v4', True) is not False                 # а версию 4 стенд прячет и перед базой
            return self.send_json(200, dict(FAIL, pg=PG))
        if u.path == '/rest/v1/rpc/komik_api_version':
            self.body()
            if self.chaos(): return
            if not FAIL['v3']:
                return self.send_json(404, {'code': 'PGRST202', 'message': 'Could not find the function public.komik_api_version without parameters in the schema cache'})
            if PG:
                out, err = pg_run('select public.komik_api_version()', self.claims())
                return self.send_json(200, int(out) if FAIL['v4'] else min(int(out), 3)) if not err else self.pg_err(err)
            return self.send_json(200, 4 if FAIL['v4'] else 3)
        if u.path == '/rest/v1/rpc/komik_delete_me':
            return self.rpc_delete_me()
        if u.path.startswith('/rest/v1/'):
            if self.chaos(): return
            return self.rest_post(u)
        if u.path.startswith('/auth/v1/'):
            if self.chaos(): return
            return self.auth(u)
        if u.path.startswith('/functions/v1/'):
            self.body()
            return self.send_json(200, {'sent': 0})
        return self.send_json(404, {'error': 'not found'})

    def do_PUT(self):
        u = urlsplit(self.path)
        if u.path.startswith('/auth/v1/'):
            if self.chaos(): return
            return self.auth(u)
        return self.send_json(404, {'error': 'not found'})

    def do_PATCH(self):
        u = urlsplit(self.path)
        if u.path.startswith('/rest/v1/'):
            if self.chaos(): return
            return self.rest_patch(u)
        return self.send_json(404, {'error': 'not found'})

    def do_DELETE(self):
        u = urlsplit(self.path)
        if u.path == '/__mock/log':
            with LOCK:
                LOG.clear()
            return self.send_json(200, {'ok': True})
        if u.path.startswith('/rest/v1/'):
            return self.send_json(403, {'code': '42501', 'message': 'permission denied for table kv'})
        return self.send_json(404, {'error': 'not found'})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── REST ──
    def query(self, u):
        select, filters = None, []
        for k, v in parse_qsl(u.query, keep_blank_values=True):
            if k == 'select':
                select = v
            elif k in ('limit', 'order', 'offset', 'on_conflict', 'columns'):
                continue
            else:
                filters.append((k, v))
        return select, filters

    def rest_get(self, u):
        if PG:
            return self.pg_rest(u)
        pub = u.path.endswith('/kv_chars_pub')
        if pub and not FAIL['v3']:
            return self.send_json(404, {'code': 'PGRST205', 'message': "Could not find the table 'public.kv_chars_pub' in the schema cache"})
        if not u.path.endswith('/kv') and not pub:
            return self.send_json(404, {'message': 'only kv in mock'})
        select, filters = self.query(u)
        tag = self.tag()
        with LOCK:
            rows = pub_rows() if pub else [{'key': k, 'value': v} for k, v in ROWS.items() if can_read(tag, k)]
        out = [project(r, select) for r in rows if match(r, filters)]
        keyf = next((op for col, op in filters if col == 'key'), '')
        if 'vnd.pgrst.object' in (self.headers.get('Accept') or ''):
            if len(out) != 1:
                n = self.send_json(406, {'code': 'PGRST116', 'message': 'JSON object requested, multiple (or no) rows returned', 'details': 'The result contains %d rows' % len(out)})
                return self.note(keyf, n, 406)
            n = self.send_json(200, out[0])
            return self.note(keyf, n, 200)
        n = self.send_json(200, out)
        self.note(keyf, n, 200)

    def rest_post(self, u):
        if PG:
            return self.pg_rest(u)
        if not u.path.endswith('/kv'):
            return self.send_json(404, {'message': 'only kv in mock'})
        b = self.body()
        rows = b if isinstance(b, list) else [b]
        prefer = self.headers.get('Prefer') or ''
        upsert = 'merge-duplicates' in prefer
        tag = self.tag()
        done = []
        with LOCK:
            for r in rows:
                if not isinstance(r, dict) or 'key' not in r:
                    return self.send_json(400, {'message': 'bad row'})
                k, v = r['key'], r.get('value')
                exists = k in ROWS
                if exists and not upsert:
                    self.note(k, 0, 409)
                    return self.send_json(409, {'code': '23505', 'message': 'duplicate key value violates unique constraint "kv_pkey"'})
                if tag is None or self.gone() or not can_write(tag, k, v, not exists):
                    self.note(k, 0, 403)
                    return self.send_json(403 if tag is not None else 401, {'code': '42501', 'message': 'new row violates row-level security policy for table "kv"'})
                ROWS[k] = v
                done.append({'key': k, 'value': v})
        size = len(json.dumps(b, ensure_ascii=False).encode('utf-8'))
        for r in done:
            self.note(r['key'], size, 201)
        if 'return=representation' in prefer:
            select, _ = self.query(u)
            return self.send_json(201, [project(r, select) for r in done])
        return self.send_json(201, None)

    def rest_patch(self, u):
        if PG:
            return self.pg_rest(u)
        if not u.path.endswith('/kv'):
            return self.send_json(404, {'message': 'only kv in mock'})
        select, filters = self.query(u)
        b = self.body() or {}
        tag = self.tag()
        changed = []
        with LOCK:
            for k in list(ROWS.keys()):
                row = {'key': k, 'value': ROWS[k]}
                if not match(row, filters):
                    continue
                nv = b.get('value', ROWS[k])
                nk = b.get('key', k)
                # RLS: USING отфильтровывает строку молча, WITH CHECK — ошибка
                if tag is None or not can_read(tag, k):
                    continue
                if tag not in DEVS and player_cap(tag, k) is None and not (k == 'comik:projects:v1' and tag == 'hinoma'):
                    continue
                if nk != k or self.gone() or not can_write(tag, k, nv, False):
                    self.note(k, 0, 403)
                    return self.send_json(403, {'code': '42501', 'message': 'new row violates row-level security policy for table "kv"'})
                ROWS[k] = nv
                changed.append({'key': k, 'value': nv})
        size = len(json.dumps(b, ensure_ascii=False).encode('utf-8'))
        for r in changed:
            self.note(r['key'], size, 200)
        if 'return=representation' in (self.headers.get('Prefer') or ''):
            return self.send_json(200, [project(r, select) for r in changed])
        return self.send_json(204, None)

    def rpc_delete_me(self):
        """komik_delete_me(confirm): ошибки — 42501 с текстом komik:<код>, как у серверной функции"""
        b = self.body() or {}
        if self.chaos(): return
        if not FAIL['v3'] or not FAIL['v4']:
            return self.send_json(404, {'code': 'PGRST202', 'message': 'Could not find the function public.komik_delete_me(confirm) in the schema cache'})
        c = self.claims()
        confirm = str(b.get('confirm') or '')
        if PG:
            out, err = pg_run('select public.komik_delete_me(%s)' % lit(confirm), c)
            if err:
                return self.pg_err(err)
            res = json.loads(out)
            with LOCK:
                USERS.pop(str(res.get('tag') or '') + '@komikdnd.ru', None)
                GONE[c.get('sub')] = {'tag': res.get('tag'), 'at': time.time()}
            self.note('', 0, 200)
            return self.send_json(200, res)
        tag = self.tag()
        fail = lambda code, msg: self.send_json(403, {'code': '42501', 'message': 'komik:%s %s' % (code, msg), 'details': None, 'hint': None})
        if tag is None:   # анониму функция не выдана вовсе
            return self.send_json(401, {'code': '42501', 'message': 'permission denied for function komik_delete_me'})
        with LOCK:
            if not tag or c.get('sub') in GONE or (c.get('email') or '').lower() not in USERS:
                return fail('auth', 'нужно войти')
            if confirm.strip().lower() != tag:
                return fail('confirm', 'подтверждение не совпадает с логином')
            if tag in DEVS:
                return fail('team', 'аккаунт команды так не удаляется')
            pw = [num(a.get('timestamp')) for a in c.get('amr') or [] if isinstance(a, dict) and a.get('method') == 'password']
            if not pw or max(pw) < time.time() - REAUTH_S:
                return fail('reauth', 'введите пароль ещё раз')
            res = delete_me(tag, c.get('sub'))
        self.note('', 0, 200)
        return self.send_json(200, res)

    # ── Auth ──
    def session(self, user):
        now = int(time.time())
        # amr — как у GoTrue: способ и время входа; обновление токена его не меняет (komik:reauth смотрит сюда)
        claims = {'sub': user['id'], 'email': user['email'], 'role': 'authenticated', 'aud': 'authenticated', 'exp': now + 3600, 'iat': now,
                  'aal': 'aal1', 'amr': [{'method': 'password', 'timestamp': int(user.get('pw_at') or now)}], 'session_id': user['id']}
        u = {'id': user['id'], 'aud': 'authenticated', 'role': 'authenticated', 'email': user['email'],
             'email_confirmed_at': '2026-01-01T00:00:00Z', 'app_metadata': {'provider': 'email'}, 'user_metadata': {},
             'created_at': '2026-01-01T00:00:00Z'}
        return {'access_token': jwt(claims), 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': now + 3600,
                'refresh_token': 'r-' + user['id'], 'user': u}

    def auth(self, u):
        path = u.path[len('/auth/v1'):]
        q = dict(parse_qsl(u.query))
        if path == '/health':
            return self.send_json(200, {'name': 'GoTrue mock'})
        if path == '/settings':
            return self.send_json(200, {'external': {'email': True}, 'disable_signup': False, 'mailer_autoconfirm': True})
        if path == '/user' and self.command == 'GET':
            p = jwt_payload((self.headers.get('Authorization') or '').replace('Bearer ', ''))
            user = USERS.get((p.get('email') or '').lower())
            if p.get('sub') in GONE:
                return self.send_json(403, {'code': 403, 'error_code': 'user_not_found', 'msg': 'User from sub claim in JWT does not exist'})
            if not user or p.get('role') != 'authenticated':
                return self.send_json(401, {'code': 401, 'msg': 'invalid JWT'})
            return self.send_json(200, self.session(user)['user'])
        if path == '/user' and self.command == 'PUT':
            b = self.body() or {}
            p = jwt_payload((self.headers.get('Authorization') or '').replace('Bearer ', ''))
            user = USERS.get((p.get('email') or '').lower())
            if not user or p.get('role') != 'authenticated' or p.get('sub') != user['id']:
                return self.send_json(401, {'code': 401, 'msg': 'invalid JWT'})
            if 'password' in b:
                pw = str(b.get('password') or '')
                if len(pw) < 8:
                    return self.send_json(422, {'code': 422, 'error_code': 'weak_password', 'msg': 'Password should be at least 8 characters.', 'weak_password': {'reasons': ['length']}})
                if pw == user['password']:
                    return self.send_json(422, {'code': 422, 'error_code': 'same_password', 'msg': 'New password should be different from the old password.'})
                user['password'] = pw
            return self.send_json(200, self.session(user)['user'])
        if path == '/logout':
            self.body()
            return self.send_json(204, None)
        b = self.body() or {}
        if path == '/token' and q.get('grant_type') == 'password':
            user = USERS.get((b.get('email') or '').lower())
            if not user or user['password'] != b.get('password'):
                return self.send_json(400, {'code': 400, 'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'})
            user['pw_at'] = int(time.time())
            return self.send_json(200, self.session(user))
        if path == '/token' and q.get('grant_type') == 'refresh_token':
            rt = b.get('refresh_token') or ''
            user = next((x for x in USERS.values() if 'r-' + x['id'] == rt), None)
            if not user:
                return self.send_json(400, {'code': 400, 'error_code': 'refresh_token_not_found', 'msg': 'Invalid Refresh Token'})
            return self.send_json(200, self.session(user))
        if path == '/signup':
            email = (b.get('email') or '').lower()
            if not re.fullmatch(r'[a-z0-9_]{4,32}@komikdnd\.ru', email):
                return self.send_json(422, {'code': 422, 'msg': 'email domain'})
            if len(b.get('password') or '') < 8:
                return self.send_json(422, {'code': 422, 'error_code': 'weak_password', 'msg': 'Password should be at least 8 characters.'})
            if email in USERS:
                return self.send_json(422, {'code': 422, 'error_code': 'user_already_exists', 'msg': 'User already registered'})
            # логин удалённого аккаунта занят 90 дней: отказ триггера на auth.users GoTrue отдаёт так
            db_fail = {'code': 500, 'error_code': 'unexpected_failure', 'msg': 'Database error saving new user'}
            if not PG and tag_gone(email.split('@')[0]):
                return self.send_json(500, db_fail)
            # id по почте — тот же у нового аккаунта с прежним логином: после 90 дней ему нужен свой
            uid = user_id(email)
            user = {'id': str(uuid.uuid4()) if uid in GONE else uid, 'email': email, 'password': b.get('password'), 'pw_at': int(time.time())}
            if PG:
                _, err = pg_run('insert into auth.users (id, email) values (%s, %s) on conflict do nothing' % (lit(user['id']), lit(email)))
                if err:
                    return self.send_json(500, db_fail)
            USERS[email] = user
            return self.send_json(200, self.session(user))
        return self.send_json(404, {'msg': 'not in mock: ' + path})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--seed', help='строки kv: [{key,value}] (можно .json.gz из ветки backups)')
    ap.add_argument('--fail', type=float, default=0.0)
    ap.add_argument('--slow', type=int, default=0)
    ap.add_argument('--pg', help='база Postgres с миграциями (tests/sql/stand.sh) — права и триггеры настоящие')
    a = ap.parse_args()
    global PG
    PG = a.pg
    if a.seed:
        import gzip
        op = gzip.open if a.seed.endswith('.gz') else open
        with op(a.seed, 'rt', encoding='utf-8') as f:
            d = json.load(f)
        rows = d.get('rows') if isinstance(d, dict) else d
        ROWS.update({r['key']: r['value'] for r in rows})
        if PG:
            _, err = pg_load(rows)
            if err:
                sys.exit('сид не лёг в базу: %s' % (err,))
    FAIL['rate'], FAIL['slow'] = a.fail, a.slow
    for t in ['hinoma', 'herr_teo', 'arlissss', 'testplayer', 'player_two']:
        e = t + '@komikdnd.ru'
        USERS[e] = {'id': user_id(e), 'email': e, 'password': 'password123'}
    if PG:   # аккаунты — из базы (к ним привязана команда в devs), недостающие тестовые — заводим
        for r in json.loads(pg_run("select coalesce(json_agg(json_build_object('id', id, 'email', email)), '[]') from auth.users")[0] or '[]'):
            USERS[r['email'].lower()] = {'id': r['id'], 'email': r['email'].lower(), 'password': 'password123'}
        for e, u in USERS.items():
            pg_run('insert into auth.users (id, email) values (%s, %s) on conflict do nothing' % (lit(u['id']), lit(e)))
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), H)
    print('КОМИК-стенд: http://127.0.0.1:%d  строк kv: %d%s' % (a.port, len(pg_rows()) if PG else len(ROWS), '  (Postgres: %s)' % PG if PG else ''), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
