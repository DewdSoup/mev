#!/usr/bin/env bash
set -euo pipefail

# Load optional env overrides
if [ -f "config/.env" ]; then
  # shellcheck disable=SC1091
  source "config/.env"
fi

# Auto-detect primary interface if not set
IFACE="${NETWORK_IFACE:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')}"

echo "=== Interface detection ==="
echo "Selected interface: ${IFACE:-<none>}"
echo

echo "=== Device status ==="
ip -br addr show 2>/dev/null | grep -E "^(eth|en|ex)" || true
echo

echo "=== Link details (requires sudo for ethtool) ==="
if [ -n "${IFACE:-}" ]; then
  sudo ethtool "$IFACE" | grep -E 'Speed:|Duplex:|Link detected:' || true
fi
echo

# Find router/gateway IP
ROUTER_IP="$(ip route | awk '/default/ {print $3; exit}')"
echo "Default route via: ${ROUTER_IP:-<unknown>}"
echo

echo "=== Routing check ==="
ip route get 1.1.1.1 || true
echo

echo "=== DNS (resolvectl) ==="
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl status | sed -n '1,120p'
else
  cat /etc/resolv.conf || true
fi
echo

echo "=== Ping tests ==="
if [ -n "${ROUTER_IP:-}" ]; then
  echo "- Router (${ROUTER_IP})"
  ping -c 50 "$ROUTER_IP" | tail -n 2
fi
echo
echo "- Internet (1.1.1.1)"
ping -c 50 1.1.1.1 | tail -n 2
echo

echo "=== Summary ==="
if [ -n "${IFACE:-}" ]; then
  SPEED="$(sudo ethtool "$IFACE" 2>/dev/null | awk -F': ' '/Speed:/ {print $2}')"
  echo "Link Speed: ${SPEED:-unknown}"
fi
echo "Router ping: see above"
echo "Internet ping: see above"
