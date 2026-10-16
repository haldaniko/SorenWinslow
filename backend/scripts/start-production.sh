#!/bin/sh
set -eu
uid="$(stat -c %u /data)"
gid="$(stat -c %g /data)"
exec su-exec "$uid:$gid" node dist/index.js
