#!/bin/bash
# TraderGze Intel: one-shot install on a fresh Ubuntu server (Google Cloud e2-micro, Oracle Cloud, any VPS).
# Needs these variables (the cloud-init block sets them): REPO, ACCESS_KEY; optional TELEGRAM_BOT_TOKEN,
# ANTHROPIC_API_KEY, TRONGRID_KEY, BTC_MIN, STABLE_MIN, PERP_MIN, RPC_ETHEREUM, RPC_BSC, RPC_POLYGON.
set -euo pipefail
exec > >(tee -a /var/log/tradergze-install.log) 2>&1
: "${REPO:?set REPO, e.g. https://github.com/you/tradergze-intel}"
: "${ACCESS_KEY:?set ACCESS_KEY (8+ characters)}"
export DEBIAN_FRONTEND=noninteractive
echo "== TraderGze Intel install $(date -u)"

# small servers (1 GB memory): add 1 GB of swap so installs and the database never run out of memory
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 1. Node.js 22 and Caddy (automatic HTTPS)
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https iptables-persistent
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy

# 2. The code and its settings
id tradergze >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/tradergze tradergze
rm -rf /opt/tradergze && git clone --depth 1 "$REPO" /opt/tradergze
# two layouts work: the full project (server/server.js) or the 3 uploaded files side by side
if [ -f /opt/tradergze/server/server.js ]; then MAIN=/opt/tradergze/server/server.js; APP=/opt/tradergze/dist/tradergze-intel.html
else MAIN=$(find /opt/tradergze -name tradergze-server.js | head -1); APP=$(find /opt/tradergze -name tradergze-intel.html | head -1); fi
[ -n "$MAIN" ] && [ -n "$APP" ] || { echo "!! tradergze-server.js and tradergze-intel.html are not in $REPO yet: upload them, then run this again"; exit 1; }
umask 077
cat > /etc/tradergze.env <<CONF
ACCESS_KEY=${ACCESS_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
TRONGRID_KEY=${TRONGRID_KEY:-}
BTC_MIN=${BTC_MIN:-100}
STABLE_MIN=${STABLE_MIN:-5000000}
PERP_MIN=${PERP_MIN:-1000000}
RPC_ETHEREUM=${RPC_ETHEREUM:-}
RPC_BSC=${RPC_BSC:-}
RPC_POLYGON=${RPC_POLYGON:-}
DB_FILE=/var/lib/tradergze/intel.db
APP_FILE=${APP}
PORT=8787
NODE_NO_WARNINGS=1
CONF
sed -i '/=$/d' /etc/tradergze.env
chown root:tradergze /etc/tradergze.env && chmod 640 /etc/tradergze.env

# 3. Run it forever (restarts on crash and on reboot)
cat > /etc/systemd/system/tradergze.service <<UNIT
[Unit]
Description=TraderGze Intel
After=network-online.target
Wants=network-online.target
[Service]
User=tradergze
EnvironmentFile=/etc/tradergze.env
WorkingDirectory=/opt/tradergze
ExecStart=/usr/bin/node ${MAIN}
Restart=always
RestartSec=5
MemoryMax=2G
[Install]
WantedBy=multi-user.target
UNIT

# 4. HTTPS on <ip>.sslip.io, no domain to buy
IP=$(curl -fsS -m 3 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)
[ -n "$IP" ] || IP=$(curl -fsS -m 3 -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/vnics/ 2>/dev/null | grep -o '"publicIp" *: *"[0-9.]*"' | grep -o '[0-9.]*$' | head -1 || true)
[ -n "$IP" ] || IP=$(curl -fsS https://api.ipify.org)
HOST="${IP}.sslip.io"
cat > /etc/caddy/Caddyfile <<CADDY
${HOST} {
  encode gzip
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
CADDY

# 5. Oracle's Ubuntu image blocks every port but SSH: open 80 and 443
# (only Oracle needs this; on other providers the rule is harmless, and a failure never stops the install)
for p in 443 80; do iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport $p -j ACCEPT || true; done
netfilter-persistent save || true
command -v ufw >/dev/null && ufw status | grep -q "Status: active" && { ufw allow 80/tcp; ufw allow 443/tcp; } || true

# 6. Updates: `sudo tradergze-update` pulls the latest code and restarts
cat > /usr/local/bin/tradergze-update <<'UPD'
#!/bin/bash
set -e
git -C /opt/tradergze pull --ff-only && systemctl restart tradergze && echo "updated: $(git -C /opt/tradergze log -1 --format=%h\ %s)"
UPD
chmod +x /usr/local/bin/tradergze-update

systemctl daemon-reload
systemctl enable --now tradergze
systemctl restart caddy
echo "https://${HOST}/" > /root/tradergze-url.txt
echo "== Done. Open https://${HOST}/ and enter your ACCESS_KEY."
