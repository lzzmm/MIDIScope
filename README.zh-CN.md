<div align="center">

# 🎼 MIDIScope

**一款现代的、纯浏览器运行的 MIDI 可视化与播放器。**
拖入一个 `.mid` 文件 → 立刻看到它以多声部钢琴卷帘的方式动起来，
通过采样乐器原声播放，并可导出为可打印的乐谱图或可分析的 CSV / XLSX 表格。

[![在线演示](https://img.shields.io/badge/在线演示-MIDIScope-6cc4ff?style=flat-square)](https://lzzmm.github.io/MIDIScope/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![无需构建](https://img.shields.io/badge/build-none-brightgreen.svg?style=flat-square)](#开发)

[**English**](README.md) · [**简体中文**](README.zh-CN.md)

</div>

---

## ✨ 亮点

- 🎹 **钢琴卷帘可视化** — 高 DPI 的 Canvas 2D 渲染，每个声部独立配色，
  带平滑的旋律连线、和弦垂线、和弦根音轨迹和迷你地图。
- 🪄 **13 个可独立开关的视觉图层** — 脉冲、彗尾、涟漪、辉光、极光、
  实时轨迹、播放头光柱…… 另外还有 10 套现成预设
  （Score / Print / Neon / Pulse / Comet / Ripple / Glow / Aurora /
  Live trace / Minimal）。
- 🎼 **智能声部拆分** — 钢琴轨道会自动聚类成低音 / 和声 / 旋律；
  和弦名带转位识别（例如 `Em7/G`）。
- 🎚 **现代化播放控制** — 大号 BAR · BEAT · TEMPO · TIME-SIG · KEY
  状态显示；缩放范围 4 – 2000 px/s；每个滑块都可直接输入数字 +
  ± 微调按钮。
- 🔊 **真实音色播放** — 通过 Tone.js 加载 Salamander Grand Piano
  (A0–C8) 钢琴和 nbrosowsky 长笛采样，带主混响。失败时自动回退到
  PolySynth。
- 🖼 **图像导出** — 多行 PNG / PDF 乐谱，长曲会自动折成 N 行以保持
  可打印的画幅比例。
- 📊 **数据导出** — CSV / XLSX 共四种行布局
  （Notes 长表 / 每拍栅格 / **每乐器栅格（新）** / 和弦进行），
  外加一个可完全自定义的列选择器。
- 🌗 **明 / 暗主题** 自动切换混合模式 — 动画在白底上依然清晰可读。

## 🚀 在线试用

无需安装，任何现代浏览器都可以打开：

> **<https://lzzmm.github.io/MIDIScope/>**

第一次以 *Realistic*（采样）音色按下播放时，页面会下载约 10 MB 的钢琴
+ 长笛采样（之后会缓存）。如果选 *Synth*，则零下载即可发声。

## 💻 离线运行

从 **Releases** 标签下载发行版 ZIP，然后双击对应的启动器：

| 操作系统 | 双击           |
| -------- | -------------- |
| macOS    | `start.command`|
| Windows  | `start.bat`    |
| Linux    | `./start.sh`   |

启动器内置了一个约 3 MB 的小型静态服务器，会在
`http://127.0.0.1:5173` 启动并自动打开浏览器，**不需要 Python 或
Node**。如果杀毒软件拦截了内置二进制，脚本会自动回退到系统已有的工
具（`python3 -m http.server`、`python -m http.server`、`npx serve`）。

<details>
<summary>macOS Gatekeeper 提示</summary>

第一次运行 `start.command` 时，macOS 可能弹出"无法验证开发者"的提示。
右键点击文件 → 打开，或者在终端执行：

```bash
xattr -dr com.apple.quarantine /路径/到/MIDIScope-folder
```
</details>

## ⌨️ 键盘快捷键

| 按键        | 作用                                              |
| ----------- | ------------------------------------------------- |
| `Space`     | 播放 / 暂停                                       |
| `Esc`       | 停止并回到开头                                    |
| `← / →`     | 后退 / 前进 2 秒（按住 `Shift` 为 10 秒）         |
| `Home / End`| 跳到开头 / 结尾                                   |
| `+ / −`     | 放大 / 缩小（每次 1.25×）                         |
| `F`         | 一览全曲；再按一次恢复之前的缩放                  |
| `T`         | 切换明 / 暗主题                                   |
| `M / S`     | （悬停某声部时）静音 / 独奏                       |

## 🧭 侧边栏说明

每一栏都可折叠（点击标题），开关状态会被记住。把鼠标移到任何控件上
都会显示一行简短说明。

| 分区          | 用途                                                              |
| ------------- | ----------------------------------------------------------------- |
| Voices        | 静音 (M) 或独奏 (S) 各个乐器声部。                                 |
| Preset        | 应用预设视觉风格（Score / Neon / Pulse / Aurora …）。              |
| Layers        | 单独开关每一种视觉图层；悬停查看说明。                             |
| Style         | 音符圆点大小 · 连线粗细 · 连线透明度。                             |
| Sound         | 音色（Realistic / Synth）+ 混响量。                                |
| Analysis      | Bass cutoff — 在没检测到和弦时退化用的左右手分割阈值。             |
| Image export  | 多行 PNG / PDF 乐谱，可附带乐器配色图例。                          |
| Data export   | CSV / XLSX 表格导出，支持预设布局或自由选列。                      |

## 📊 数据导出 — 示例

**Notes（长表，每个音符一行，无损）：**

```csv
time,bar,beat,voice,pitch,midi,duration_sec,velocity,chord_name
0,1,1,Chords,C4,60,0.5,0.7,C
0,1,1,Chords,E4,64,0.5,0.7,C
0,1,1,Chords,G4,67,0.5,0.7,C
2,1,3,Chords,A3,57,0.5,0.7,Am
```

**Per-instrument grid（新增）** — 每行是一个最小拍（或 ½ / ¼ / 整小节），
每列是一个声部，单元格里是该时间点正在响的音符（含识别到的和弦名）：

```csv
time,bar,beat,Melody,Harmony,Bass,Flute
0.000,1,1,E4,C4+E4+G4 (C),C2,
0.500,1,1.5,F4,C4+E4+G4 (C),C2,
1.000,1,2,G4,C4+E4+G4 (C),C2,A5
```

**Chord progression（每个和弦变化一行）：**

```csv
time,bar,beat,chord_name,chord_root,chord_quality,chord_bass,duration_sec
0,1,1,C,C,,,2
2,1,3,Am,A,m,,0.5
```

XLSX 输出与 CSV 完全等价，会写成真正的 Excel 工作簿（仅在选择 XLSX
时才会按需加载 [SheetJS](https://sheetjs.com/)）。

## 🛠 开发

整个应用是纯 ES 模块 + CDN 引用，**无需任何打包工具**。任何静态服务
器都能跑：

```bash
cd MIDIScope
python3 -m http.server 5173
# 打开 http://127.0.0.1:5173/
```

项目结构：

```
index.html
style.css
src/
  main.js          UI 接线 + 工具提示 + 折叠 + 导出
  midiLoader.js    MIDI 解析（基于 @tonejs/midi）
  voicing.js       声部 / 和弦拆分 + 配色
  chordName.js     带转位识别的和弦命名
  render.js        Canvas 渲染（主图 + 迷你地图）
  scoreExport.js   多行 PNG / PDF 导出
  dataExport.js    CSV / XLSX 构建 + 序列化
  player.js        Tone.js 采样器 / 合成器播放
midi/              演示 MIDI 文件
scripts/           start.{sh,bat,command} 启动器
```

## 🌐 浏览器兼容

Chrome · Edge · Safari · Firefox 最新版。音频解锁需要一次用户手势
（点一下"播放"就够了）。

## 📜 协议

MIT — 详见 [LICENSE](LICENSE)。

## 🙏 鸣谢

- [Tone.js](https://tonejs.github.io/) — Web Audio 框架 + 采样器
- [@tonejs/midi](https://github.com/Tonejs/Midi) — MIDI 解析
- [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3)
  — 钢琴采样（CC-BY）
- [SheetJS Community Edition](https://sheetjs.com/) — XLSX 导出
- [jsPDF](https://github.com/parallax/jsPDF) — PDF 包装

---

<div align="center">
由 <a href="https://github.com/lzzmm">lzzmm</a> 用 ♪ 制作
</div>
