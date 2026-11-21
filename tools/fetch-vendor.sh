#!/usr/bin/env bash
# 重新拉取 vendor 依赖（版本都钉死了，别用 latest）。
# 用法： bash tools/fetch-vendor.sh
#
# 拉取后 vendor/ 大约 20MB，之后整个站点可以完全离线运行，不再依赖任何 CDN。
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p vendor/three-addons vendor/mediapipe/wasm

THREE=0.160.0
MP=0.10.3
JSD=https://cdn.jsdelivr.net/npm

echo "→ three.js $THREE"
curl -fsSL --retry 3 -o vendor/three.module.js "$JSD/three@$THREE/build/three.module.js"

# 用到的 addon（含它们自己的相对依赖）
for f in \
  controls/OrbitControls.js \
  environments/RoomEnvironment.js \
  postprocessing/EffectComposer.js \
  postprocessing/RenderPass.js \
  postprocessing/ShaderPass.js \
  postprocessing/MaskPass.js \
  postprocessing/Pass.js \
  postprocessing/UnrealBloomPass.js \
  postprocessing/OutputPass.js \
  shaders/CopyShader.js \
  shaders/LuminosityHighPassShader.js \
  shaders/OutputShader.js
do
  mkdir -p "vendor/three-addons/$(dirname "$f")"
  echo "  · $f"
  curl -fsSL --retry 3 -o "vendor/three-addons/$f" "$JSD/three@$THREE/examples/jsm/$f"
done

echo "→ MediaPipe tasks-vision $MP"
curl -fsSL --retry 3 -o vendor/tasks-vision.js "$JSD/@mediapipe/tasks-vision@$MP/+esm"

# WASM：SIMD 与非 SIMD 两套都存，老浏览器会自动挑非 SIMD 的
for f in vision_wasm_internal.js vision_wasm_internal.wasm \
         vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm
do
  echo "  · wasm/$f"
  curl -fsSL --retry 3 -o "vendor/mediapipe/wasm/$f" "$JSD/@mediapipe/tasks-vision@$MP/wasm/$f"
done

echo "→ 手部模型（约 8MB）"
curl -fsSL --retry 3 -o vendor/mediapipe/hand_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"

echo "✓ 完成，vendor 大小：$(du -sh vendor | cut -f1)"
echo "  下次启动：python3 -m http.server 8767"
