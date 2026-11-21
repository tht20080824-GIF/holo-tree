# 第三方依赖与许可

本项目（`index.html` / `css/` / `js/` 下的全部代码）为自研代码，未拷贝任何第三方项目。
`vendor/` 下是原样分发的依赖库，许可如下。

---

## three.js 0.160.0

- 主页：<https://threejs.org>
- 源码：<https://github.com/mrdoob/three.js>
- 许可：MIT
- 位置：`vendor/three.module.js`、`vendor/three-addons/**`
- 说明：本项目用到的 addon 为 `OrbitControls`、`RoomEnvironment`、`EffectComposer`、
  `RenderPass`、`ShaderPass`、`MaskPass`、`Pass`、`UnrealBloomPass`、`OutputPass`
  及其着色器文件，均来自 three.js 官方 `examples/jsm`。

```
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## MediaPipe Tasks Vision 0.10.3

- 文档：<https://developers.google.com/mediapipe/solutions/vision/hand_landmarker>
- 源码：<https://github.com/google-ai-edge/mediapipe>
- 许可：Apache License 2.0
- 位置：`vendor/tasks-vision.js`、`vendor/mediapipe/wasm/**`、`vendor/mediapipe/hand_landmarker.task`
- 说明：负责从摄像头画面里取出手部 21 个关键点。模型文件来自 Google 的
  `hand_landmarker/float16/1` 公共分发地址。

许可证全文：<https://www.apache.org/licenses/LICENSE-2.0>

---

## 关于"手势圣诞树"这个点子

这个玩法最早由国内一位产品经理在 2025 年 11 月底用 AI 生成单文件 HTML 带火，
原作者仓库：<https://github.com/ymqf/tree>。

本项目的**代码与实现完全独立**（粒子布局、手势映射、平滑策略、UI 均为自写），
但概念上受其启发，使用时请知悉这一点；如果要在公开场合声称是原创创意，请避开。
