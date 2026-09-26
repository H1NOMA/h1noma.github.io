#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  КОМИК · защита самого сервера (один раз, по желанию; повторный запуск безопасен)
#  Запуск на сервере (root): bash <(curl -fsS https://komikdnd.ru/migrate/harden.sh)
#  Ставит:
#   · fail2ban — после 6 неверных паролей SSH за 10 минут адрес блокируется на час;
#   · unattended-upgrades — обновления безопасности Ubuntu ставятся сами каждый день.
#  Показывает, какие порты сервера открыты в интернет.
#  НЕ отключает вход по паролю и НЕ меняет порт SSH (так легко закрыть дверь и перед собой) —
#  в конце печатает, как перейти на вход по ключу с Windows.
# ══════════════════════════════════════════════════════════════════
set -euo pipefail
say(){ printf '\n\033[1;32m══ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root: ssh root@<IP>"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

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
IP=$(hostname -I 2>/dev/null | awk '{print $1}'); IP=${IP:-<IP-сервера>}
cat <<EOF
Сейчас вход по паролю: $(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print ($2=="yes")?"включён":"выключен"}' || true)
На своём компьютере (Windows) открой PowerShell:
  1) ssh-keygen -t ed25519
     (Enter на все вопросы; ключ появится в папке .ssh твоего пользователя)
  2) type \$env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh root@$IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
     (последний раз спросит пароль сервера)
  3) ssh root@$IP — должен пустить БЕЗ пароля.
Только если шаг 3 сработал, можно выключить вход по паролю (на сервере):
  echo 'PasswordAuthentication no' > /etc/ssh/sshd_config.d/00-komik.conf && sshd -t && systemctl restart ssh
  и, НЕ закрывая это окно, проверь вход в новом окне PowerShell: ssh root@$IP
Ключ живёт на этом компьютере: скопируй папку .ssh в надёжное место. Потерял ключ и пароль выключен —
вход только через консоль в панели хостинга (там же вернуть пароль: rm /etc/ssh/sshd_config.d/00-komik.conf && systemctl restart ssh).
Если сам себя заблокировал паролями — подожди час или в консоли хостинга: fail2ban-client set sshd unbanip ТВОЙ_IP
EOF
