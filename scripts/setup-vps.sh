#!/usr/bin/env bash
# =============================================================================
# One-time VPS setup (Ubuntu 22.04). Run as root ON THE VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/Smaxhy/super-secret-weapon/main/scripts/setup-vps.sh -o setup-vps.sh
#   bash setup-vps.sh
#
# What it does:
#   1. Updates the system, turns on automatic security updates
#   2. Creates a non-root user "bot" (the bot never runs as root)
#   3. Copies root's SSH key to "bot", then disables password logins
#      (only if a key is present — it won't lock you out)
#   4. Firewall: only SSH (22) and the dashboard API (8080) are open
#   5. fail2ban: bans IPs that brute-force SSH
#   6. Installs Docker + docker compose
# =============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root"; exit 1; fi

echo "==> 1/6 System update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> 2/6 Create user 'bot'"
if ! id bot &>/dev/null; then
  adduser --disabled-password --gecos "" bot
  usermod -aG sudo bot
fi

echo "==> 3/6 SSH hardening"
if [[ -s /root/.ssh/authorized_keys ]]; then
  mkdir -p /home/bot/.ssh
  cp /root/.ssh/authorized_keys /home/bot/.ssh/authorized_keys
  chown -R bot:bot /home/bot/.ssh && chmod 700 /home/bot/.ssh && chmod 600 /home/bot/.ssh/authorized_keys
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  systemctl restart ssh || systemctl restart sshd
  echo "    Password login disabled. Log in with: ssh bot@<ip>"
else
  echo "    !! No SSH key in /root/.ssh/authorized_keys — password login left ON."
  echo "    !! Add your key (ssh-copy-id root@<ip> from your PC) and re-run this script."
fi

echo "==> 4/6 Firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 8080/tcp
ufw --force enable

echo "==> 5/6 fail2ban"
systemctl enable --now fail2ban

echo "==> 6/6 Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker bot
systemctl enable --now docker

# Docker publishes ports by editing iptables directly, which bypasses ufw.
# Our compose file binds Postgres/Redis to 127.0.0.1, so they stay private anyway.

echo
echo "Done. Next, as user 'bot':"
echo "  git clone https://github.com/Smaxhy/super-secret-weapon.git solana-trading-bot"
echo "  cd solana-trading-bot && cp .env.example .env && nano .env"
echo "  docker compose up -d --build && docker compose logs -f bot"
