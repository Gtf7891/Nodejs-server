#!/bin/bash
set -e
BACKUP_ROOT=/opt/server/data/backups
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_ROOT"
tar -czf "$BACKUP_ROOT/users_$STAMP.tar.gz" -C /opt/server/data users.json shared 2>/dev/null || true
ls -t "$BACKUP_ROOT"/users_*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
