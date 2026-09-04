#!/bin/zsh

set -u

service_label="com.yuzhenghui.kaoyan-vocab-recall"
service_target="gui/$(id -u)/$service_label"
app_url="http://localhost:3000/"

if ! /usr/bin/curl -fsS --max-time 2 "$app_url" >/dev/null 2>&1; then
  /bin/launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true

  for attempt_number in {1..20}; do
    if /usr/bin/curl -fsS --max-time 1 "$app_url" >/dev/null 2>&1; then
      break
    fi
    /bin/sleep 1
  done
fi

if /usr/bin/curl -fsS --max-time 2 "$app_url" >/dev/null 2>&1; then
  /usr/bin/open "$app_url"
else
  /usr/bin/osascript -e 'display alert "词汇回忆室没有启动" message "请双击“安装长期运行.command”修复后台服务。" as critical'
fi
