#!/bin/bash
# dev 模式 Electron 专用 bundle id（E-10）：避免与其它 Electron 项目（默认 com.github.Electron）
# 在 Launch Services 中抢占 aionui:// 协议。bun install / electron dist 重装后需重跑一次。
set -euo pipefail
cd "$(dirname "$0")/../.."
E="$(node -e "console.log(require('path').dirname(require.resolve('electron')))")/dist/Electron.app"
[ -d "$E" ] || { echo "Electron.app 未找到：$E"; exit 1; }
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.aionui.dev" "$E/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName AionUi-Dev" "$E/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName AionUi-Dev" "$E/Contents/Info.plist" 2>/dev/null || true
codesign --force --deep --sign - "$E"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$E"
echo "bundle id -> $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$E/Contents/Info.plist")（重签名+LS 注册完成）"
