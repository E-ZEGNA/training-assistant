#!/bin/sh
set -eu

if ! /www/server/nginx/sbin/nginx -t >/dev/null 2>&1; then
  /www/server/nginx/sbin/nginx -t
  exit 1
fi
/www/server/nginx/sbin/nginx -s reload
