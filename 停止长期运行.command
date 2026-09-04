#!/bin/zsh

set -u

service_label="com.yuzhenghui.kaoyan-vocab-recall"
service_domain="gui/$(id -u)"

/bin/launchctl bootout "$service_domain/$service_label" >/dev/null 2>&1 || true
/usr/bin/osascript -e 'display notification "下次双击“安装长期运行.command”即可恢复。" with title "词汇回忆室已停止"'
