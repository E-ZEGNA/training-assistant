#!/usr/bin/env bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")" && pwd)"
bin_root="$native_root/bin"
arch="${1:-$(uname -m)}"

case "$arch" in
  x64|x86_64) target="x86_64-apple-macos13.0" ;;
  arm64|aarch64) target="arm64-apple-macos13.0" ;;
  *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac

mkdir -p "$bin_root"
swiftc \
  -O \
  -parse-as-library \
  -target "$target" \
  -framework AudioToolbox \
  -framework CoreMedia \
  -framework Foundation \
  -framework ScreenCaptureKit \
  "$native_root/AudioCapture.swift" \
  -o "$bin_root/InterviewAudioCapture"
chmod 755 "$bin_root/InterviewAudioCapture"
echo "Built $bin_root/InterviewAudioCapture for $target"
