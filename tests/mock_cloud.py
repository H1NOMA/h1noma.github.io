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
  · /auth/v1 — вход по паролю, регистрация (автоподтверждение), обновление токена, выход, user;
  · /functions/v1/notify-game — отдаёт публичный ключ, рассылку только считает;
  · /__mock/rows (GET — все строки, POST — заменить), /__mock/log (GET — журнал, DELETE — очистить),
    /__mock/fail (POST {"rate":0.2,"slow":300}) — обрывы и задержка для проверки устойчивости.
Сид — массив строк [{key, value}] (формат ежедневного бэкапа kv) или {rows:[…]}.
"""
import argparse, base64, hashlib, json, os, random, re, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlsplit, parse_qsl, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVS = {'hinoma', 'herr_teo', 'arlissss'}
LOCK = threading.RLock()   # note() зовётся и под замком (отказ в записи)
ROWS = {}            # key → value (jsonb)
USERS = {}           # email → {id, email, password}
LOG = []             # [{t, method, path, key, bytes, status}]
FAIL = {'rate': 0.0, 'slow': 0, 'player_img': True}   # player_img: False — сервер без миграции 10-28
VAPID = 'B' + 'A' * 86


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
    caps = {'comik:tracker:shared:v1': 8388608, 'comik:games:v1': 524288, 'comik:users:v1': 262144, 'push:subs': 524288,
            'comik:chars:' + tag: 10485760, 'comik:bm:' + tag: 262144}
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
            with LOCK:
                ROWS.clear(); ROWS.update({r['key']: r['value'] for r in rows or []})
            return self.send_json(200, {'ok': True, 'rows': len(ROWS)})
        if u.path == '/__mock/fail':
            b = self.body() or {}
            FAIL['rate'] = float(b.get('rate') or 0); FAIL['slow'] = int(b.get('slow') or 0)
            FAIL['player_img'] = b.get('player_img', True) is not False
            return self.send_json(200, FAIL)
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
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
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
        if not u.path.endswith('/kv'):
            return self.send_json(404, {'message': 'only kv in mock'})
        select, filters = self.query(u)
        with LOCK:
            rows = [{'key': k, 'value': v} for k, v in ROWS.items()]
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
                if tag is None or not can_write(tag, k, v, not exists):
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
                if tag is None:
                    continue
                if tag not in DEVS and player_cap(tag, k) is None and not (k == 'comik:projects:v1' and tag == 'hinoma'):
                    continue
                if nk != k or not can_write(tag, k, nv, False):
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

    # ── Auth ──
    def session(self, user):
        now = int(time.time())
        claims = {'sub': user['id'], 'email': user['email'], 'role': 'authenticated', 'aud': 'authenticated', 'exp': now + 3600, 'iat': now}
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
            if not user or p.get('role') != 'authenticated':
                return self.send_json(401, {'code': 401, 'msg': 'invalid JWT'})
            return self.send_json(200, self.session(user)['user'])
        if path == '/logout':
            self.body()
            return self.send_json(204, None)
        b = self.body() or {}
        if path == '/token' and q.get('grant_type') == 'password':
            user = USERS.get((b.get('email') or '').lower())
            if not user or user['password'] != b.get('password'):
                return self.send_json(400, {'code': 400, 'error_code': 'invalid_credentials', 'msg': 'Invalid login credentials'})
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
            USERS[email] = {'id': hashlib.md5(email.encode()).hexdigest(), 'email': email, 'password': b.get('password')}
            return self.send_json(200, self.session(USERS[email]))
        return self.send_json(404, {'msg': 'not in mock: ' + path})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--seed', help='строки kv: [{key,value}] (можно .json.gz из ветки backups)')
    ap.add_argument('--fail', type=float, default=0.0)
    ap.add_argument('--slow', type=int, default=0)
    a = ap.parse_args()
    if a.seed:
        import gzip
        op = gzip.open if a.seed.endswith('.gz') else open
        with op(a.seed, 'rt', encoding='utf-8') as f:
            d = json.load(f)
        rows = d.get('rows') if isinstance(d, dict) else d
        ROWS.update({r['key']: r['value'] for r in rows})
    FAIL['rate'], FAIL['slow'] = a.fail, a.slow
    for t in ['hinoma', 'herr_teo', 'arlissss', 'testplayer', 'player_two']:
        e = t + '@komikdnd.ru'
        USERS[e] = {'id': hashlib.md5(e.encode()).hexdigest(), 'email': e, 'password': 'password123'}
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), H)
    print('КОМИК-стенд: http://127.0.0.1:%d  строк kv: %d' % (a.port, len(ROWS)), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
