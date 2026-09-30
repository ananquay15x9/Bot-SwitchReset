#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# swbot service setup (Raspberry Pi)
#
#  run:   sudo ./setup-service.sh            (auto-detects the USB drive)
#
# What it does:
#   1. Mounts the USB drive at /mnt/usb permanently (by UUID, "nofail" so the Pi
#      still boots if the stick is unplugged).
#   2. Moves logs/ and netgear_session/ (Chromium profile = most writes) to the USB
#      and leaves symlinks, so no code paths change.
#   3. Installs a systemd service "swbot" that runs src/master.js 24/7 under a
#      virtual screen (xvfb), restarts on crash, and starts on boot.
#   4. Sends all bot output to a log file on the USB, rotated by logrotate.
#   5. Keeps the system journal in RAM instead of on the SD card.
#
# Safe to run again: steps that are already done are skipped.
# ------------------------------------------------------------------------------
set -euo pipefail

MOUNT=/mnt/usb
SERVICE=swbot
TZ_NAME=America/Chicago

say()  { echo -e "\033[1;36m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[!]\033[0m $*"; }
die()  { echo -e "\033[1;31m[x]\033[0m $*" >&2; exit 1; }

# ---------- preflight ----------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run with sudo:  sudo $0 $*"
SERVICE_USER="${SUDO_USER:-}"
[[ -n "$SERVICE_USER" && "$SERVICE_USER" != root ]] || die "Run via sudo from your normal user (not as root directly)."
USER_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$PROJECT_DIR/src/master.js" ]] || die "src/master.js not found. Put this script in the project root."
[[ -f "$PROJECT_DIR/.env" ]] || die ".env not found in $PROJECT_DIR. Put this script in the project root."

if pgrep -u "$SERVICE_USER" -f "master.js|swbot.js|sw-list.js" >/dev/null; then
    die "The bot is running right now. Stop it first (Ctrl+C / 'exit' in Telegram), then re-run."
fi

# node: may come from nvm, so ask the user's own shell where it is
NODE_BIN="$(sudo -u "$SERVICE_USER" -i bash -c 'command -v node' 2>/dev/null || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(sudo -u "$SERVICE_USER" bash -ic 'command -v node' 2>/dev/null | tail -n1 || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
[[ -x "$NODE_BIN" ]] || die "Couldn't find node for user $SERVICE_USER."
NODE_DIR="$(dirname "$NODE_BIN")"
say "Project : $PROJECT_DIR"
say "User    : $SERVICE_USER"
say "Node    : $NODE_BIN ($("$NODE_BIN" -v))"

if ! command -v xvfb-run >/dev/null; then
    say "Installing xvfb (virtual screen for the non-headless browser)..."
    apt-get update -qq && apt-get install -y -qq xvfb
fi

# ---------- 1. USB drive -------------------------------------------------------
USB_DEV="${1:-}"
ROOT_DISK="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null || true)"

if [[ -z "$USB_DEV" ]]; then
    mapfile -t CANDS < <(
        lsblk -rpno NAME,TYPE,TRAN | awk '$2=="disk" && $3=="usb"{print $1}' | while read -r disk; do
            [[ "$(basename "$disk")" == "$ROOT_DISK" ]] && continue
            lsblk -rpno NAME,TYPE "$disk" | awk '$2=="part"{print $1}'
        done
    )
    if [[ ${#CANDS[@]} -ne 1 ]]; then
        lsblk -o NAME,SIZE,FSTYPE,LABEL,TRAN,MOUNTPOINTS
        die "Found ${#CANDS[@]} USB partitions. Re-run with the one to use, e.g.:  sudo $0 /dev/sda1"
    fi
    USB_DEV="${CANDS[0]}"
fi
[[ -b "$USB_DEV" ]] || die "$USB_DEV is not a block device."
[[ "$(lsblk -no PKNAME "$USB_DEV")" != "$ROOT_DISK" ]] || die "$USB_DEV is on the same disk as / - refusing."

FSTYPE="$(blkid -s TYPE -o value "$USB_DEV" || true)"
UUID="$(blkid -s UUID -o value "$USB_DEV" || true)"
say "USB     : $USB_DEV  ($FSTYPE, $(lsblk -no SIZE "$USB_DEV" | head -1))"

if [[ "$FSTYPE" != "ext4" ]]; then
    warn "The USB is '$FSTYPE', not ext4."
    warn "Chromium's session folder needs symlinks + Linux permissions, which FAT32/exFAT/NTFS don't support."
    warn "To format it (THIS ERASES THE STICK - copy off anything you need first):"
    echo  "     sudo umount $USB_DEV 2>/dev/null; sudo mkfs.ext4 -L SWBOT $USB_DEV"
    die  "Then run this script again."
fi
[[ -n "$UUID" ]] || die "Couldn't read UUID of $USB_DEV."

# unmount desktop auto-mount (/media/...) so we can mount at a fixed path
CUR_MNT="$(findmnt -rno TARGET "$USB_DEV" || true)"
if [[ -n "$CUR_MNT" && "$CUR_MNT" != "$MOUNT" ]]; then
    say "Unmounting desktop auto-mount at $CUR_MNT"
    umount "$USB_DEV"
fi

mkdir -p "$MOUNT"
if ! grep -q "UUID=$UUID" /etc/fstab; then
    cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
    echo "UUID=$UUID  $MOUNT  ext4  defaults,noatime,nofail,x-systemd.device-timeout=10s  0  2" >> /etc/fstab
    say "Added USB to /etc/fstab (backup saved as /etc/fstab.bak.*)"
fi
systemctl daemon-reload
mountpoint -q "$MOUNT" || mount "$MOUNT"
mountpoint -q "$MOUNT" || die "Mounting $MOUNT failed."

DATA="$MOUNT/swbot"
mkdir -p "$DATA/tmp"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA"

# ---------- 2. move write-heavy folders to USB --------------------------------
STAMP="$(date +%Y%m%d)"
for d in logs netgear_session; do
    SRC="$PROJECT_DIR/$d"
    DST="$DATA/$d"
    if [[ -L "$SRC" ]]; then
        say "$d/ already points to $(readlink "$SRC") - skipping"
        continue
    fi
    mkdir -p "$DST"
    if [[ -d "$SRC" ]]; then
        say "Copying $d/ to USB..."
        cp -a "$SRC/." "$DST/"
        mv "$SRC" "$SRC.sd-backup-$STAMP"
    fi
    chown -R "$SERVICE_USER:$SERVICE_USER" "$DST"
    sudo -u "$SERVICE_USER" ln -s "$DST" "$SRC"
    say "$d/ -> $DST"
done

# ---------- 3. systemd service -------------------------------------------------
MOUNTPOINT_BIN="$(command -v mountpoint)"
FIND_BIN="$(command -v find)"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Netgear switch reset bot (Telegram listener + 7AM/2PM scheduler)
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$MOUNT

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
Environment=TZ=$TZ_NAME
Environment=HOME=$USER_HOME
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Chromium temp profiles (sw-list.js) go to the USB, not the SD card
Environment=TMPDIR=$DATA/tmp

# refuse to start if the USB isn't mounted (otherwise logs would land on the SD)
ExecStartPre=$MOUNTPOINT_BIN -q $MOUNT
ExecStartPre=/bin/mkdir -p $DATA/tmp
ExecStartPre=$FIND_BIN $DATA/tmp -mindepth 1 -delete
# systemd already guarantees a single instance; clear a stale lock left by a crash/power cut
ExecStartPre=/bin/rm -f $PROJECT_DIR/.bot.lock

# xvfb gives the non-headless browser a virtual screen
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1366x900x24" $NODE_BIN $PROJECT_DIR/src/master.js

Restart=always
RestartSec=15
KillMode=control-group
TimeoutStopSec=20

StandardOutput=append:$DATA/service.log
StandardError=append:$DATA/service.log

[Install]
WantedBy=multi-user.target
EOF
say "Wrote /etc/systemd/system/$SERVICE.service"

# ---------- 4. log rotation ----------------------------------------------------
cat > "/etc/logrotate.d/$SERVICE" <<EOF
$DATA/service.log {
    weekly
    maxsize 20M
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
say "Wrote /etc/logrotate.d/$SERVICE (weekly or 20MB, keep 4)"

# ---------- 5. system journal in RAM ------------------------------------------
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/90-protect-sd.conf <<EOF
[Journal]
Storage=volatile
RuntimeMaxUse=50M
EOF
systemctl restart systemd-journald
say "System journal now kept in RAM (max 50MB)"

# ---------- start --------------------------------------------------------------
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 5

if systemctl is-active --quiet "$SERVICE"; then
    say "✅ $SERVICE is running. You should get the 'I am online' message in Telegram."
else
    warn "$SERVICE did not stay up. Last log lines:"
    tail -n 30 "$DATA/service.log" 2>/dev/null || true
    journalctl -u "$SERVICE" -n 20 --no-pager || true
    exit 1
fi

cat <<EOF

Useful commands:
  tail -f $DATA/service.log          # watch the bot live
  sudo systemctl status $SERVICE     # is it running?
  sudo systemctl restart $SERVICE    # restart it
  sudo systemctl stop $SERVICE       # stop it (Telegram 'exit' only restarts it)

Once you've confirmed everything works, you can delete the old SD copies:
  rm -rf $PROJECT_DIR/logs.sd-backup-* $PROJECT_DIR/netgear_session.sd-backup-*
EOF
