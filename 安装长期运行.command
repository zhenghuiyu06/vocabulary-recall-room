#!/bin/zsh

set -eu

project_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
service_label="com.yuzhenghui.kaoyan-vocab-recall"
service_domain="gui/$(id -u)"
runtime_dir="$HOME/Library/Application Support/KaoyanVocabRecall"
log_dir="$HOME/Library/Logs/KaoyanVocabRecall"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/$service_label.plist"
source_file="$project_dir/$service_label.plist"
app_url="http://localhost:3000/"

/bin/mkdir -p "$agent_dir" "$runtime_dir" "$log_dir"
/bin/chmod +x "$project_dir/vocab-service.sh" "$project_dir/启动背词程序.command" "$project_dir/停止长期运行.command" "$project_dir/安装长期运行.command"

if [[ ! -f "$project_dir/dist/server/index.js" ]]; then
  (cd -- "$project_dir" && /usr/local/bin/npm run build)
fi

# macOS 不允许登录后的后台服务直接读取 Documents，所以将运行所需文件同步到系统允许的专用目录。
/usr/bin/ditto "$project_dir/dist" "$runtime_dir/dist"
/usr/bin/ditto "$project_dir/node_modules" "$runtime_dir/node_modules"
/bin/cp "$project_dir/package.json" "$runtime_dir/package.json"
if [[ -f "$project_dir/package-lock.json" ]]; then
  /bin/cp "$project_dir/package-lock.json" "$runtime_dir/package-lock.json"
fi
/bin/cp "$project_dir/vocab-service.sh" "$runtime_dir/vocab-service.sh"
/bin/chmod +x "$runtime_dir/vocab-service.sh"

if [[ -f "$agent_file" ]]; then
  backup_file="$agent_file.bak-$(/bin/date +%Y%m%d-%H%M%S)"
  /bin/cp -p "$agent_file" "$backup_file"
fi

/bin/launchctl bootout "$service_domain/$service_label" >/dev/null 2>&1 || true
/bin/cp "$source_file" "$agent_file"
/bin/chmod 644 "$agent_file"
/bin/launchctl bootstrap "$service_domain" "$agent_file"
/bin/launchctl enable "$service_domain/$service_label"
/bin/launchctl kickstart -k "$service_domain/$service_label"

for attempt_number in {1..30}; do
  if /usr/bin/curl -fsS --max-time 1 "$app_url" >/dev/null 2>&1; then
    /usr/bin/open "$app_url"
    /usr/bin/osascript -e 'display notification "以后登录 Mac 会自动启动，无需保留终端窗口。" with title "词汇回忆室已长期运行"'
    exit 0
  fi
  /bin/sleep 1
done

/usr/bin/osascript -e 'display alert "长期服务安装完成，但网页暂未响应" message "请重新双击“安装长期运行.command”；若仍无法打开，请联系我继续修复。" as critical'
exit 1
