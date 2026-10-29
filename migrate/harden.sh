#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · защита самого сервера (один раз, по желанию; повторный запуск безопасен)
#  Запуск на сервере (root): bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh)
#  Ставит:
#   · fail2ban — после 6 неверных паролей SSH за 10 минут адрес блокируется на час;
#   · unattended-upgrades — обновления безопасности Ubuntu ставятся сами каждый день.
#  Показывает, какие порты сервера открыты в интернет.
#  Обычный запуск НЕ отключает вход по паролю и НЕ меняет порт SSH (так легко закрыть дверь и перед собой) —
#  в конце печатает, как перейти на вход по ключу с Windows.
#
#  Вход только по ключу — отдельной командой, когда ключ уже добавлен и вход по нему проверен:
#    bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh) ssh-keys
#  Пишет /etc/ssh/sshd_config.d/00-komik.conf: PasswordAuthentication no, KbdInteractiveAuthentication no,
#  PermitRootLogin prohibit-password. Откажет, если в /root/.ssh/authorized_keys нет ни одного настоящего ключа;
#  перед перезапуском проверяет sshd -t и что настройки действительно подействовали (sshd -T), иначе — откат.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
bad(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; }
ok(){ printf '  %s ✓\n' "$*"; }
# пути — переменными только для проверки в песочнице (tests/README.md); на сервере — как есть
AK="${KOMIK_SSH_AUTHKEYS:-/root/.ssh/authorized_keys}"
SSHD_CFG="${KOMIK_SSHD_CONFIG:-/etc/ssh/sshd_config}"
DROPIN="${KOMIK_SSHD_DROPIN:-/etc/ssh/sshd_config.d/00-komik.conf}"

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
IP=$(hostname -I 2>/dev/null | awk '{print $1}'); IP=${IP:-<IP-сервера>}
# как завести ключ на Windows и положить его на сервер — одна инструкция для обоих режимов
key_howto(){
  cat <<EOF
На своём компьютере (Windows) открой PowerShell (НЕ на сервере):
  1) ssh-keygen -t ed25519
     (Enter на все вопросы; ключ появится в папке .ssh твоего пользователя)
  2) type \$env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh root@$IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
     (последний раз спросит пароль сервера)
  3) в НОВОМ окне PowerShell: ssh root@$IP — должен пустить БЕЗ пароля.
Только если шаг 3 сработал — на сервере: bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh) ssh-keys
Ключ живёт на этом компьютере: скопируй папку .ssh в надёжное место. Потерял ключ, а пароль выключен —
вход только через консоль в панели хостинга (там же вернуть пароль: rm $DROPIN && systemctl reload ssh).
EOF
}

# ── режим ssh-keys: вход по SSH только по ключу ──
if [ "${1:-}" = ssh-keys ]; then
  say "Вход по SSH только по ключу"
  # перевод строки Windows (\r) в конце ключа попадает в файл при вставке из PowerShell — убираем
  if [ -f "$AK" ] && grep -q $'\r' "$AK"; then sed -i 's/\r$//' "$AK"; fi
  # «правильный» ключ — тот, у которого ssh-keygen смог посчитать отпечаток (тип, base64 и длина — настоящие)
  KEYS=""; N=0
  if [ -f "$AK" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      if fp=$(ssh-keygen -l -f /dev/stdin <<< "$line" 2>/dev/null); then N=$((N + 1)); KEYS="$KEYS    $fp"$'\n'; fi
    done < "$AK"
  fi
  if [ "$N" = 0 ]; then
    bad "в $AK нет ни одного ключа — выключать вход по паролю нельзя: сервер закрылся бы и от тебя"
    echo
    key_howto
    exit 1
  fi
  # sshd строг к правам: папка и файл, доступные на запись другим, — и ключ молча не примут
  chmod 700 "$(dirname "$AK")"; chmod 600 "$AK"
  echo "Ключи, с которыми можно будет войти (из $AK): $N"
  printf '%s' "$KEYS"
  echo
  echo "Дальше вход root по паролю будет выключен — пустит только с этими ключами."
  echo "Вход по ключу ты уже проверил в НОВОМ окне PowerShell (ssh root@$IP — пустило без пароля)?"
  read -rp "Напиши «да», чтобы выключить вход по паролю: " YES </dev/tty || YES=""
  [ "$YES" = да ] || { echo "Отменено — ничего не менял."; exit 0; }
  BAK=""; if [ -f "$DROPIN" ]; then BAK=$(mktemp); cp "$DROPIN" "$BAK"; fi
  put_back(){ if [ -n "$BAK" ]; then cp "$BAK" "$DROPIN"; else rm -f "$DROPIN"; fi; }
  mkdir -p "$(dirname "$DROPIN")"
  # 00- — чтобы стоять раньше 50-cloud-init.conf и т.п.: у sshd действует ПЕРВОЕ значение параметра
  cat > "$DROPIN" <<EOF
# КОМИК (migrate/harden.sh ssh-keys): вход только по ключу. Вернуть вход по паролю (из консоли хостинга):
#   rm $DROPIN && systemctl reload ssh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  chmod 644 "$DROPIN"
  ERR=$(mktemp)
  if ! sshd -t -f "$SSHD_CFG" 2>"$ERR"; then
    put_back; bad "sshd -t: настройки не прошли проверку — вернул как было:"; sed 's/^/  /' "$ERR"; exit 1
  fi
  # подействовало ли: строка Include должна быть в sshd_config раньше своих значений этих параметров
  EFF=$(sshd -T -f "$SSHD_CFG" 2>"$ERR" | awk '$1 ~ /^(passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|permitrootlogin)$/ {print $1 "=" $2}')
  if ! grep -qx 'passwordauthentication=no' <<< "$EFF" || grep -Eq '^(kbdinteractive|challengeresponse)authentication=yes$' <<< "$EFF" \
     || ! grep -Eqx 'permitrootlogin=(without-password|prohibit-password)' <<< "$EFF"; then
    put_back
    bad "настройки не подействовали (sshd -T: $(paste -sd' ' <<< "$EFF")) — вернул как было."
    echo "  Скорее всего, в $SSHD_CFG нет строки «Include /etc/ssh/sshd_config.d/*.conf» в начале. Покажи вывод программисту."
    exit 1
  fi
  rm -f "$ERR" "$BAK"
  # reload: текущие соединения не рвутся. Сервис не запущен (вход через ssh.socket) — новые настройки возьмёт при старте
  if systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service 2>/dev/null; then
    ok "sshd перечитал настройки"
  else warn "не смог перечитать sshd (systemctl reload ssh) — настройки вступят после перезапуска сервера"; fi
  ok "вход по паролю выключен: $(paste -sd' ' <<< "$EFF")"
  printf '\n\033[1;33m%s\033[0m\n' "НЕ ЗАКРЫВАЙ ЭТО ОКНО, пока не проверишь вход в НОВОМ окне PowerShell: ssh root@$IP"
  echo "  Пустило без пароля — всё, можно закрывать."
  echo "  Не пустило — прямо в ЭТОМ окне верни как было: rm $DROPIN && systemctl reload ssh"
  exit 0
fi

say "1/3 · fail2ban (защита SSH от подбора пароля)"
apt-get update -q >/dev/null || warn "apt-get update не прошёл (нет интернета?) — пробую поставить из того, что есть"
apt-get install -yq fail2ban >/dev/null
# на части образов нет /var/log/auth.log (журнал только в systemd) — тогда читаем журнал напрямую
BACKEND=auto
if [ ! -f /var/log/auth.log ]; then BACKEND=systemd; apt-get install -yq python3-systemd >/dev/null 2>&1 || true; fi
cat > /etc/fail2ban/jail.d/komik.local <<EOF
# КОМИК (migrate/harden.sh): 6 неверных входов по SSH за 10 минут — бан адреса на час
[sshd]
enabled  = true
backend  = $BACKEND
maxretry = 6
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || true
sleep 2
if fail2ban-client status sshd >/dev/null 2>&1; then
  echo "  fail2ban работает ✓ (сейчас заблокировано адресов: $(fail2ban-client status sshd | sed -n 's/.*Currently banned:[[:space:]]*//p'))"
else
  warn "fail2ban не запустился — пришли программисту: systemctl status fail2ban --no-pager | tail -20"
fi

say "2/3 · Автоматические обновления безопасности"
apt-get install -yq unattended-upgrades >/dev/null
# по умолчанию в Ubuntu ставятся только обновления безопасности; сервер сам НЕ перезагружается
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
echo "  обновления безопасности ставятся сами, раз в сутки ✓"
echo "  новое ядро начинает работать после перезагрузки: раз в месяц-два — reboot (сайт поднимется сам через пару минут)"

say "3/3 · Какие порты открыты в интернет"
# всё, что слушает не только 127.0.0.1/::1, видно снаружи (порты Docker обходят ufw)
PUB=$(ss -Htlnp | awk '$4 !~ /^(127\.|\[::1\]|::1)/ {print $4, $6}' | sort -u)
echo "$PUB" | sed 's/users:((//; s/"\([^"]*\)".*/\1/; s/^/  /'
EXTRA=$(echo "$PUB" | awk '{n=split($1,a,":"); print a[n]}' | grep -vxE '22|80|443' | sort -un | paste -sd' ' || true)
echo "  Нормально: 22 (SSH), 80 и 443 (Caddy — сайт облака)."
if [ -n "$EXTRA" ]; then
  warn "открыты ещё порты: $EXTRA — закрой их в панели хостинга (облачный фаервол): оставь только 22, 80, 443"
else
  echo "  Лишних открытых портов нет ✓"
fi

say "Вход по SSH-ключу вместо пароля (сделай сам, когда будет время)"
# пароль принимают два способа входа: PasswordAuthentication и keyboard-interactive (через PAM) —
# на части образов хостингов второй включён, и тогда «PasswordAuthentication no» пароль не выключает
PWSTATE=$(sshd -T 2>/dev/null | awk '
  $1=="passwordauthentication"{p=$2} $1=="kbdinteractiveauthentication"||$1=="challengeresponseauthentication"{if(k=="")k=$2}
  END{ if(p=="") print "не удалось узнать (sshd -T)";
       else print ((p=="yes"||k=="yes")?"включён":"выключен") " (PasswordAuthentication " p ", KbdInteractiveAuthentication " (k==""?"?":k) ")" }' || true)
echo "Сейчас вход по паролю: $PWSTATE"
key_howto
echo "Если сам себя заблокировал паролями — подожди час или в консоли хостинга: fail2ban-client set sshd unbanip ТВОЙ_IP"
