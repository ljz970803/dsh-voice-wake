# 架构说明（dsh-voice-wake）

一页纸讲清楚：这套东西由哪几块组成、一句话从麦克风到会话经过什么、你想改某个行为该去哪个文件。

## 目标与非目标

- **目标**：在 DSH 里常听麦克风；只喊唤醒词确认后，把「请讲」窗口里说的正文发到会话；有 HUD 能看到状态。
- **非目标**：对话式连续问答、TTS、操作电脑、云端识别。音频只在本机内存里转一圈，不落盘、不出网。

## 三块运行时

| 块 | 文件 | 跑在哪 | 职责 |
|---|---|---|---|
| Host 插件 | `lib/*.js` | DSH 主进程 | 配置、ASR 调用、唤醒匹配、会话投递、HTTP 接口 |
| 浏览器半 | `client.js` | 主窗口页面 | 采集麦克风、VAD 切段、请讲窗口、设置页、驱动 HUD |
| HUD 组件 | `hud.js` | 主窗口页面（Shadow DOM） | 纯展示：状态点 + 状态文字 + 音量条 |

`client.js` 由 DSH 当普通脚本注入；`hud.js` 由 Host 通过 `GET /.dsh-voice-wake/hud.js` 发出来，再被 `import()` 加载。所以 `hud.js` 可以单独给别的宿主用。

## 一句话的旅程

```
麦克风
  → AudioContext（client.js，每 85ms 一块）
  → RMS/VAD 判定「有声 / 静音」
  → 静音够久或到「单句最长」→ 切成一段
  → 转成 16kHz 单声道 WAV
  → POST /.dsh-voice-wake/utterance（probe=1 只探唤醒词）
  → Host：本地 SenseVoice 识别出文本
  → 唤醒匹配（lib/pinyin.js：拼音/同音 + 编辑距离，且必须「整段只有唤醒词」）
  → 确认唤醒：浏览器半响「叮」，开 5 秒「请讲」窗口，HUD 保持「已唤醒」
  → 窗口内下一段带 follow=1 → Host 跳过唤醒匹配，直接投递正文
  → 送达后响「嗒」，回到聆听中
```

HUD 的状态由浏览器半算：`off`（开关关）/ `listening`（聆听中）/ `conversing`（已唤醒，含请讲窗口）。

## 文件职责

| 文件 | 负责 | 不负责 |
|---|---|---|
| `lib/index.js` | 插件生命周期、HTTP 路由、状态机、把下面几块接起来 | 音频采集、界面 |
| `lib/config.js` | 配置 schema、默认值、迁移、补丁校验 | 业务逻辑 |
| `lib/pinyin.js` | 拼音表、规范化、唤醒词匹配与拒绝原因 | 会话、音频 |
| `lib/paths.js` | 模型目录 / 数据目录的候选与探测 | 其它 |
| `client.js` | 采集、切段、设置页、诊断、HUD 装配 | ASR、会话投递 |
| `hud.js` | 悬浮卡片（纯展示，文案由宿主注入） | 任何网络/配置 |
| `test/*.test.js` | 纯函数回归测试（配置、唤醒匹配） | 麦克风、UI、ASR |

## HTTP 接口（Host 提供）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/hud.js` | 把 HUD 组件原样发给浏览器 |
| GET | `/state` | 当前状态 + 依赖体检摘要（每 700ms 轮询） |
| GET / POST | `/config` | 读配置 / 提交部分字段补丁 |
| POST | `/utterance` | 上传一段 WAV；`probe=1` 只判唤醒词，`test=1` 是设置页测试 |
| GET / POST | `/jump` | 主窗口取「该切到哪个会话」/ 确认已切 |
| POST / GET | `/log` | 浏览器半上报日志 / 拉最近日志 |
| GET | `/diagnostics` | 导出诊断报告 |

所有响应都带 `cache-control: no-store`；请求沿用主窗口登录态做来源校验。

## 配置与持久化

- 配置：`<插件数据目录>/config.json`，由 `lib/config.js` 的 `CONFIG_SCHEMA` 驱动（默认值、迁移、校验都在这一张表里）。
- 位置 / 折叠：`localStorage` 的 `dsh-voice-wake.hud.position` / `dsh-voice-wake.hud.collapsed`（键名与 `hud.js` 保持一致）。
- 音频：只在一次请求的 Buffer 里存在，识别完即丢。

## 测试

```bash
node --test                 # 普通终端
node --test --test-isolation=none   # 受限沙箱里（不允许 fork 子进程时）
```

覆盖范围：配置默认值/迁移/越界/坏类型、`resetSession`、唤醒词拆分、唤醒匹配（含金鱼同音、段首规则）、
严格唤醒判定（整段只有唤醒词才算，标点/空格不影响，多一个字就不算）。

**不覆盖**：麦克风采集、VAD 切段（含 0.6 秒快切）、真实识别质量、请讲窗口的定时与取消、
HUD 渲染与层级、会话投递。这些改动需要手动验证（说一句话看结果）。

新增测试请放进 `test/`，命名 `*.test.js`；测试文件不会被打进发布包（见 `package.json` 的 `files` 白名单）。

## 想改行为时去哪

| 想改什么 | 改哪里 |
|---|---|
| 唤醒词、默认值、配置项 | `lib/config.js` 的 `CONFIG_SCHEMA` |
| 唤醒匹配宽容度 / 同音容错 | `lib/pinyin.js`（先跑 `test/wake.test.js`） |
| 识别引擎 / 超时 | `lib/index.js` 的 `transcribe()` |
| 投递目标、打断策略 | `lib/index.js` 的 `resolveTargetSession()` / `deliver()` |
| 采集、切段、设置页 | `client.js` |
| 卡片外观、状态色、z-index | `hud.js` 顶部 `LOOK` / `COLOR`，层级由 `hudZIndex` 配置 |

## 扩展配方（给用户的 agent 看）

四个最常见的定制。原则：**能加文件就不要改文件**；改完先跑 `npm test`。
另外，Market 更新会整包覆盖代码，长期定制请 fork 自己的版本。

### 1. 换 HUD 配色 / 尺寸 / 文案

- 颜色、尺寸：`hud.js` 顶部的 `COLOR` / `LOOK`，只动这两个表；
- 文案：`client.js` 的 `zh` 字典里 `hud*` 开头的键，经 `hudStrings()` 注入；
- 不要在 `client.js` 里写 HUD 样式，否则会破坏“组件可以独立使用”。

### 2. 把 HUD 放到独立置顶窗口

`hud.js` 是纯 ESM、只依赖标准 DOM：

```js
import { createHud } from './dsh-voice-wake/hud.js'

const hud = createHud({
  mount: document.body,
  strings: { /* 用中文或英文文案 */ },
  options: { shadow: true, storage: null, initialPosition: { x: 24, y: 24 } },
  onRequestMute: () => {}, // 接到主进程后可以转发给 /config
})
hud.update({ state: 'listening', level: 0 })
```

窗口的创建、置顶、跟随由宿主负责（Electron 的 `alwaysOnTop`），组件本身不管。

### 3. 换语音识别模型

入口只有 `lib/index.js` 的 `transcribe(ctx, wav)`：

- 输入：16 kHz、单声道、PCM16 的 WAV `Buffer`；
- 输出：识别文本 `string`；
- 失败：抛错并带 `code`（如 `transcribe-failed`），上层会写日志并回退。

换成云端模型时注意：音频会离开本机，需要在 README 的隐私说明里讲清楚。

### 4. 换提示音

两个声音都是 `client.js` 里现场合成的，没有音频文件依赖：

- 唤醒音：`playWakeChime()` —— 默认 988 → 1319 Hz，约 0.36 秒；
- 送达音：`playSentChime()` —— 默认 660 Hz，约 0.18 秒。

**只改音高/时长**：直接改这两个函数里的频率和秒数即可；音量仍由设置页的「提示音音量」统一控制。

**换成音频文件**（用户自己的 wav/mp3）：

```js
// 在 playWakeChime() 里用采集的 AudioContext 播放
const ctx = audio.capture?.context
const res = await fetch('/你的音频地址')
const buf = await res.arrayBuffer()
const decoded = await ctx.decodeAudioData(buf)
const src = ctx.createBufferSource()
src.buffer = decoded
src.connect(ctx.destination)
src.start()
```

注意：

- 建议短音（0.5 秒以内）、体积小，避免唤醒时等加载；
- 远程地址可能被 CSP/网络拦截，优先随包放本地文件（`assets/`）；
- 播放失败要**静默回退**到合成音或直接不响，不能阻塞唤醒和发送流程。
