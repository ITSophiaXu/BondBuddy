#!/bin/sh
# BB_EGRESS_ALLOW: space/comma separated host names (exact match) the worker may reach over HTTPS.
set -eu
allow=$(printf '%s' "${BB_EGRESS_ALLOW:-api.deepseek.com}" | tr ',' ' ')
conf=/tmp/squid.conf
{
  echo "http_port 3128"
  echo "pid_filename none"
  echo "cache deny all"
  echo "cache_dir null /tmp"
  echo "access_log stdio:/dev/stdout"
  echo "cache_log stdio:/dev/stderr"
  echo "logfile_rotate 0"
  echo "coredump_dir /tmp"
  echo "acl SSL_ports port 443"
  echo "acl CONNECT method CONNECT"
  echo "acl allowed_hosts dstdomain $allow"
  echo "http_access deny !CONNECT"
  echo "http_access deny CONNECT !SSL_ports"
  echo "http_access allow CONNECT allowed_hosts"
  echo "http_access deny all"
  echo "forwarded_for delete"
  echo "via off"
} > "$conf"
echo "egress allow-list: $allow" >&2
exec squid -N -f "$conf"
