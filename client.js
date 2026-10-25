/**
 * 语音唤醒（dsh-voice-wake）浏览器半：采集 + 界面装配。
 *
 * 这里负责：
 *  1. 采麦克风：getUserMedia -> AudioContext -> ScriptProcessor 取原始 float 采样；
 *  2. 切段：能量 VAD，攒够一段人声就重采样成 16 kHz 单声道 PCM16 WAV（只在内存里）；
 *  3. 把这一段 POST 给 Host（Host 里跑本地 SenseVoice 识别与唤醒词匹配）；
 *  4. 收到「切到这个会话」的目标就调用主窗口的 uiWorkspace.openSession()；
 *  5. 设置页分区（导航名「语音唤醒」），以及把状态/音量/识别文本喂给 HUD 卡片。
 *
 * 这里不负责：HUD 长什么样、怎么拖动/折叠（那些在 hud.js，纯展示组件）；
 * 也不负责识别、唤醒词匹配、会话投递（那些在 Host 半 lib/index.js）。
 *
 * 这一版最重要的变化是**可观测性**：客户端每个阶段都通过 POST /.dsh-voice-wake/log
 * 写进 Host 的 run.log（时间戳 + 阶段名）。日志里永远没有音频数据；
 * 识别文本由 Host 侧写入并截断到 120 字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-wake',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** 路由前缀，必须与 Host 半一致。 */
    const PREFIX = '/.dsh-voice-wake'
    /** 设置页分区 id。 */
    const SECTION_ID = 'voice-wake'
    /** 兜底版本号；真实版本由 Host 的 /state 返回。 */
    const LOCAL_VERSION = '0.7.0'

    /**
     * 全部界面文案集中在这里。以后要加英文，复制一份 en 即可。
     */
    const zh = {
      nav: '语音唤醒',
      intro: '常听麦克风、本地识别；喊唤醒词就把接下来这句话发进语音会话。',

      // ---------------- 一层：常用
      enable: '启用语音唤醒',
      deviceTitle: '麦克风',
      deviceHint: '选错设备会导致听不到声音。',
      deviceDefault: '系统默认输入设备',
      deviceUnnamed: '麦克风 {n}',
      deviceRefresh: '刷新',
      wakeLabel: '唤醒词',
      wakePlaceholder: '鲸鱼',
      wordsHint: '多个说法用英文逗号分隔；建议 2–3 个字，越短唤醒越快。',
      vadLevel: '灵敏度',
      vadValue: '第 {value} 档',
      vadMoreSensitive: '更灵敏',
      vadLessSensitive: '更保守',
      vadHint: '只影响唤醒；对话中按环境噪声自适应。',
      calibrate: '校准',
      calibrating: '校准中：请保持安静 3 秒…',
      calibrated: '已按环境底噪选到第 {level} 档（底噪 {floor}）。',
      calibrateEmpty: '没采到音频，检查麦克风后重试。',
      calibrateFail: '校准失败：',
      silenceLabel: '说完后静音',
      silenceHint: '对话中只按这个时长判断说完。',
      silenceOption: '{n} 毫秒',
      maxSegLabel: '单句最长',
      maxSegHint: '连续说话超过这个时长就强制切段发送；「不限」只受内存与上传大小限制。',
      maxSegOption: '{n} 分钟',
      maxSegUnlimited: '不限',
      chimeLabel: '提示音音量',
      chimeHint: '唤醒和发送时的提示音；0 为静音。',
      chimeValue: '{n}%',
      hudTitle: '显示 HUD 卡片',
      hudHint: '可拖动，位置会记住；被挡住时点「归位」。',
      hudReopen: '归位',
      hudErrorPrefix: 'HUD 加载失败：',
      saveErrorPrefix: '保存失败：',
      wakeAtStartTitle: '要求唤醒词在段首',
      wakeAtStartHint: '避免聊天里提到唤醒词就误触发。',
      advancedNote: '唤醒词必须在段首，句中顺带提到「鲸鱼」不会误唤醒。',
      probeTitle: '快速唤醒探测',
      probeHint: '每段开头多跑最多 3 次短识别，命中就尽快切段确认，提示音响得更快；吃 CPU（约 0.2–0.5 秒/段），机器慢可以关掉。',
      followTitle: '发到当前会话',
      followHint: '开启：语音消息跟着你当前打开的会话走；关闭：固定发到「语音唤醒会话」，切到别的会话也不变。',
      micTestTitle: '麦克风测试',
      micTestHint: '录 3 秒只做识别，不会发进会话；会顺带估环境底噪。',
      micPreviewOn: '开始预览',
      micPreviewOff: '停止预览',
      micTestRun: '测试识别（3 秒）',
      micTesting: '正在录音…',
      micSending: '正在识别…',
      micDevice: '设备',
      micRate: '采样率',
      micPermission: '权限',
      micPeak: '峰值',
      micResultTitle: '识别结果',
      micResultEmpty: '（空）',
      micNoResult: '还没测过。',
      permissionGranted: '已授权',
      permissionDenied: '被拒绝',
      permissionPrompt: '未授权（会弹窗询问）',
      permissionUnknown: '未知',
      hintSilent: '完全没有音量（峰值 {peak}）：先看设备选对没、系统有没有静音、Windows 隐私设置是否允许。',
      hintNoText: '有音量（峰值 {peak}）但识别为空：可能这段只有噪声，或说得太短。',
      hintModels: '识别服务没就绪：先在「设置 → 语音输入」确认已安装/启用，且本地模型可用。',
      hintOk: '链路正常：录音 → 识别都通了。',
      hintError: '识别失败：{detail}',
      diagInfoTitle: '诊断信息',
      diagCopy: '复制诊断信息',
      diagCopied: '已复制到剪贴板。',
      diagCopyFailed: '复制失败，请手动选中下面的文本。',
      diagExport: '导出文件',
      diagSelfCheck: '链路自检',
      diagSelfChecking: '正在自检…',
      diagSelfCheckOk: '自检通过：Host 收到 0.5 秒静音并完成识别（文本为空是正常的）。',
      diagSelfCheckFail: '自检失败：{detail}',
      diagVersion: '插件版本',
      diagEnabled: 'enabled',
      diagDevice: 'deviceId',
      diagRate: '采样率',
      diagMode: '状态机',
      diagSession: '语音会话',
      diagPeak: '最后音量峰值',
      diagAsr: '最后识别文本',
      diagWake: '最后唤醒匹配',
      diagAudio: '最后一段音频',
      diagError: '最后一条错误',
      diagNone: '（无）',
      diagNotYet: '（还没跑过）',
      silenceShort: '静音切段',

      // ---------------- 状态 / 错误
      statusStalled: '麦克风没出数据：检查设备是否选对、系统是否静音。',
      modelsMissingTitle: '识别还不能用',
      modelsMissingHint: '需要 DSH 的语音输入（本地 SenseVoice）可用；没装的话先去「设置 → 语音输入」安装/启用官方插件。',
      loadError: '读取语音唤醒设置失败：',
      retry: '重试',
      micDenied: '打不开麦克风：{detail}',
      micUnsupported: '这个窗口不支持麦克风采集。',
      transcribeError: '识别失败：',
      errorCodes: {
        'speech-service-missing': 'Host 里没有语音识别服务（speechToText），请确认 DSH 的语音输入依赖已启用。',
        'model-missing': '找不到本地 SenseVoice 模型。',
        'provider-unavailable': '语音识别 provider 不可用。',
        'transcribe-failed': '本地识别失败。',
        'session-create-failed': '创建语音会话失败。',
        'send-failed': '把文字发进会话失败。',
        'bad-audio': '录音格式不对（需要 16 kHz 单声道）。',
      },

      // ---------------- HUD（悬浮卡片）
      // HUD 组件本身不写死任何中文：这些键会作为 strings 传给 hud.js。
      hudLabel: '语音唤醒 HUD',
      hudStateOff: '未启用',
      hudStateListening: '聆听中',
      hudStateConversing: '已唤醒',
      hudMute: '静音（暂停常听）',
      hudUnmute: '恢复常听',
      hudCollapse: '收起',
      hudExpand: '展开',
      hudClose: '关闭悬浮卡片',
    }


    // ------------------------------------------------------------ 日志

    /**
     * 待发日志队列。批量、限流、去重：
     *  - 同一阶段 800 ms 内完全相同的两条只留一条，避免「音量」类日志刷屏；
     *  - 每 250 ms 最多发一批，且最多攒 40 条；
     *  - 发不出去就丢（Host 没起来时不能反过来拖垮界面）。
     */
    const logBox = { queue: [], sending: false, timer: 0, last: new Map() }

    /**
     * 记一条客户端日志（Host 会写进 run.log）。
     * @param {string} stage 阶段名，必须在 Host 白名单里
     * @param {string} [detail] 细节；不能放音频数据或整段聊天内容
     */
    function clog(stage, detail) {
      let text = ''
      if (detail !== undefined && detail !== null) {
        text = String(detail).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
        if (text.length > 200) text = `${text.slice(0, 200)}…`
      }
      const now = Date.now()
      const previous = logBox.last.get(stage)
      if (previous !== undefined && previous.text === text && now - previous.at < 800) return
      logBox.last.set(stage, { at: now, text })
      logBox.queue.push({ stage, detail: text })
      if (logBox.queue.length > 40) logBox.queue.splice(0, logBox.queue.length - 40)
      try {
        window.console?.debug?.(`[语音唤醒] ${stage}${text === '' ? '' : ` ${text}`}`)
      } catch {
        // 控制台不可用无所谓。
      }
      if (logBox.timer !== 0) return
      logBox.timer = window.setTimeout(() => {
        logBox.timer = 0
        void flushLogs()
      }, 250)
    }

    /** 把攒着的日志发给 Host。失败静默（不能因为日志挂掉主流程）。 */
    async function flushLogs() {
      if (logBox.sending) return
      const entries = logBox.queue.splice(0, logBox.queue.length)
      if (entries.length === 0) return
      logBox.sending = true
      try {
        await fetch(`${PREFIX}/log`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries }),
        })
      } catch {
        // Host 还没挂上或正在重启，这批日志丢掉。
      } finally {
        logBox.sending = false
        if (logBox.queue.length > 0 && logBox.timer === 0) {
          logBox.timer = window.setTimeout(() => {
            logBox.timer = 0
            void flushLogs()
          }, 250)
        }
      }
    }

    // ------------------------------------------------------------ HTTP

    /**
     * 带超时的同源请求。
     * @param {string} path 以 / 开头的路径
     * @param {object} [init] fetch 参数
     * @param {number} [timeoutMs] 超时
     * @returns {Promise<Response>} 响应
     */
    async function request(path, init, timeoutMs = 10000) {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      try {
        return await fetch(`${PREFIX}${path}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          ...init,
        })
      } finally {
        window.clearTimeout(timer)
      }
    }

    async function requestJson(path, init, timeoutMs = 10000) {
      const response = await request(path, init, timeoutMs)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    function postJson(path, body) {
      return requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    // ------------------------------------------------- 共享状态（供设置页显示）

    const status = {
      version: LOCAL_VERSION,
      enabled: false,
      mode: 'off',
      deviceId: '',
      wakeWords: '',
      wakeAtStart: true,
      wakeSensitivity: 5,
      silenceMs: 2000,
      maxSegmentMs: 60000,
      chimeVolume: 32,
      probeEnabled: true,
      followActive: false,
      /** HUD：开关 + 四个初值（位置/折叠/透明度/层级），来自 Host 的 /state。 */
      hudEnabled: true,
      hudPosition: null,
      hudCollapsed: false,
      hudOpacity: 1,
      hudZIndex: 2147483000,
      /** HUD 自己的错误（组件加载失败等），只显示在设置页。 */
      hudError: '',
      lastHeard: '',
      lastError: '',
      lastCode: '',
      localError: '',
      sessionId: '',
      modelsReady: true,
      problems: [],
      lastAsrText: '',
      lastWake: '',
      lastBytes: 0,
      lastPeak: 0,
      lastUtteranceAt: 0,
      lastUtteranceSource: '',
      // 以下由浏览器半自己维护
      level: 0,
      peak: 0,
      sampleRate: 0,
      deviceLabel: '',
      permission: 'unknown',
      micState: 'idle',
      test: { phase: 'idle', text: '', code: '', ms: 0, peak: 0, at: 0, error: '', durationMs: 0 },
      selfCheck: { phase: 'idle', detail: '' },
    }
    const listeners = new Set()

    function publish(patch) {
      Object.assign(status, patch)
      for (const listener of listeners) {
        try {
          listener({ ...status })
        } catch {
          // 单个订阅者出错不影响别人。
        }
      }
    }

    function applyServerState(payload) {
      const state = payload?.state
      if (!state) return
      // 唤醒结果：命中只负责把 HUD 切到「已唤醒」；
      // 「叮」要等完整识别确认“整段只有唤醒词”之后才由 beginFollowup 播。
      const nextWake = typeof state.lastWake === 'string' ? state.lastWake : ''
      if (nextWake !== status.lastWake && nextWake.startsWith('hit:')) {
        audio.awake = true
        audio.awakeAt = Date.now()
      }
      const nextMode = typeof state.mode === 'string' ? state.mode : 'off'
      // 可调参数：Host 是唯一真相，值变了立刻同步到本地采集循环（无重启）。
      const wakeSensitivity = Number.isFinite(state.wakeSensitivity) ? clampSensitivity(state.wakeSensitivity) : tuning.wakeSensitivity
      const silenceMs = Number.isFinite(state.silenceMs) ? clampSilenceMs(state.silenceMs) : tuning.silenceMs
      const maxSegmentMs = Number.isFinite(state.maxSegmentMs) ? clampMaxSegment(state.maxSegmentMs) : tuning.maxSegmentMs
      tuning.wakeSensitivity = wakeSensitivity
      tuning.silenceMs = silenceMs
      tuning.maxSegmentMs = maxSegmentMs
      // 唤醒词长度变了，探测时间点跟着重算（不用重启、不用设置项）。
      if (typeof state.wakeWords === 'string' && state.wakeWords !== status.wakeWords) {
        tuning.probeSchedule = probeScheduleFor(state.wakeWords)
      }
      publish({
        version: typeof state.version === 'string' && state.version !== '' ? state.version : status.version,
        enabled: state.enabled === true,
        mode: nextMode,
        deviceId: typeof state.deviceId === 'string' ? state.deviceId : '',
        wakeWords: typeof state.wakeWords === 'string' ? state.wakeWords : '',
        wakeAtStart: state.wakeAtStart !== false,
        wakeSensitivity,
        silenceMs,
        maxSegmentMs,
        chimeVolume: Number.isFinite(state.chimeVolume) ? Math.max(0, Math.min(100, Math.round(state.chimeVolume))) : status.chimeVolume,
        probeEnabled: state.probeEnabled !== false,
        followActive: state.followActive !== false,
        hudEnabled: state.hudEnabled !== false,
        hudPosition: normalizeHudPosition(state.hudPosition),
        hudCollapsed: state.hudCollapsed === true,
        hudOpacity: clampHudOpacity(state.hudOpacity),
        hudZIndex: clampHudZIndex(state.hudZIndex),
        lastHeard: typeof state.lastHeard === 'string' ? state.lastHeard : '',
        lastError: typeof state.lastError === 'string' ? state.lastError : '',
        lastCode: typeof state.lastCode === 'string' ? state.lastCode : '',
        sessionId: typeof state.sessionId === 'string' ? state.sessionId : '',
        modelsReady: payload?.health?.modelsReady !== false,
        problems: Array.isArray(payload?.health?.problems) ? payload.health.problems : [],
        lastAsrText: typeof state.lastAsrText === 'string' ? state.lastAsrText : '',
        lastWake: typeof state.lastWake === 'string' ? state.lastWake : '',
        lastBytes: Number.isFinite(state.lastBytes) ? state.lastBytes : 0,
        lastPeak: Number.isFinite(state.lastPeak) ? state.lastPeak : 0,
        lastUtteranceAt: Number.isFinite(state.lastUtteranceAt) ? state.lastUtteranceAt : 0,
        lastUtteranceSource: typeof state.lastUtteranceSource === 'string' ? state.lastUtteranceSource : '',
      })
    }

    // ------------------------------------------------------------ 音频采集

    /** ScriptProcessor 一次给 4096 个样本（48 kHz 下约 85 ms）。 */
    const BLOCK = 4096
    /**
     * 单句最长：连续说话超过这个时长就强制切段发送。
     * 档位与 Host 的 lib/config.js 一致；0 = 不设上限（只受内存与上传大小限制）。
     */
    const MAX_SEGMENT_OPTIONS = [60000, 120000, 300000, 0]
    const MAX_SEGMENT_DEFAULT = 60000
    const MAX_SEGMENT_MAX = 3600000
    /** 起始段预录，避免把第一个字切掉。 */
    const PRE_ROLL_BLOCKS = 3

    /** 内部保险：有声时长低于这个值的片段直接丢（避免纯噪声进识别）；不再是配置项。 */
    const MIN_VOICED_MS = 150
    /** 「说完后静音」的档位与安全范围，必须与 Host 的 lib/config.js 一致。 */
    const SILENCE_OPTIONS = [500, 800, 1200, 1600, 2000, 3000, 4000, 5000, 6000, 8000]
    const SILENCE_DEFAULT = 2000
    const SILENCE_MIN = 400
    const SILENCE_MAX = 8000
    /**
     * 唤醒灵敏度：1–10 档，必须与 Host 的 lib/config.js 一致。
     * 每档给一个「绝对下限」和一个「底噪倍数」：
     *  - 绝对下限：安静房间里不能低于它，否则呼吸/风扇就会被当成说话；
     *  - 倍数：吵闹环境里阈值跟着底噪一起抬高，档位越高越保守。
     * 默认第 5 档 ≈ 旧版的 0.0032 阈值 + 2.8 倍底噪。
     */
    const SENSITIVITY_MIN = 1
    const SENSITIVITY_MAX = 10
    const SENSITIVITY_DEFAULT = 5
    const SENSITIVITY_FLOORS = [0.0008, 0.0012, 0.0016, 0.0022, 0.0032, 0.0042, 0.0055, 0.0070, 0.0090, 0.0120]
    const SENSITIVITY_FACTORS = [2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8]
    /**
     * 快速唤醒探测的时间点：**按唤醒词长度自动算**，不用给用户加设置。
     * 一个字约 200ms，再留 150ms 余量（2 字「鲸鱼」→ 0.55 秒首探，4 字 → 0.95 秒）；
     * 后面两次是兜底：首探太早、第二个字还没说完时，靠 +450ms / +900ms 那两次补上。
     * @param {string} words 配置里的唤醒词
     * @returns {number[]} 毫秒时间点
     */
    function probeScheduleFor(words) {
      const first = String(words ?? '').split(/[,，;；]/)[0] ?? ''
      const chars = first.replace(/[^\u4e00-\u9fa5a-zA-Z]/g, '').length
      const count = Math.max(1, Math.min(8, chars))
      const base = Math.max(450, count * 200 + 150)
      return [base, base + 450, base + 900]
    }
    const PROBE_MIN_VOICED_MS = 300
    /** 探测请求超时：短音频识别通常几百毫秒，给足余量但不至于卡住。 */
    const PROBE_TIMEOUT_MS = 8000
    /**
     * 唤醒确认用的静音长度：比普通切段（2 秒）短得多。
     * 探测命中后本段按 0.6 秒切，让「叮」尽快响；代价是唤醒词中间不能长停顿。
     */
    const WAKE_CONFIRM_SILENCE_MS = 600
    /** 「请讲」窗口：唤醒后这么久没有有效说话，就认为误触发，自动收回聆听中。 */
    const FOLLOWUP_WINDOW_MS = 5000
    /** 可调参数。由 /state 轮询和 POST /config 的返回同步，采集循环每块现读。 */
    const tuning = {
      wakeSensitivity: SENSITIVITY_DEFAULT,
      silenceMs: SILENCE_DEFAULT,
      maxSegmentMs: MAX_SEGMENT_DEFAULT,
      probeSchedule: [860, 1560, 2260],
    }

    /**
     * 串行化灵敏度保存：滑杆连续拖动时，保证最后落盘的是用户最后选的那一档，
     * 也避免旧请求的响应把新值覆盖回去。
     */
    let tuningSaveQueue = Promise.resolve()
    let tuningSaveSeq = 0
    function queueTuningPatch(patch) {
      const seq = ++tuningSaveSeq
      const run = tuningSaveQueue.then(() => postJson('/config', patch))
      tuningSaveQueue = run.then(
        () => undefined,
        () => undefined,
      )
      return { seq, run }
    }

    /**
     * 把任意输入收敛成合法的灵敏度档位（1–10，取整）。
     * @param {number} value 原始值
     * @returns {number} 1–10
     */
    function clampSensitivity(value) {
      if (!Number.isFinite(value)) return SENSITIVITY_DEFAULT
      return Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, Math.round(value)))
    }

    /**
     * 按测到的环境底噪推荐一档：选「绝对下限 ≥ 底噪 × 2」的最低档。
     * 越安静的房间档位越低（越灵敏），越吵的档位越高。
     * @param {number} floor 底噪 RMS
     * @returns {number} 1–10
     */
    function levelForFloor(floor) {
      const target = Math.max(0.0005, Number.isFinite(floor) ? floor : 0.0015) * 2
      for (let index = 0; index < SENSITIVITY_FLOORS.length; index += 1) {
        if (SENSITIVITY_FLOORS[index] >= target) return index + 1
      }
      return SENSITIVITY_MAX
    }

    /**
     * 把任意输入收敛成合法的静音切段毫秒数（400–8000，取整）。
     * @param {number} value 原始值
     * @returns {number} 合法毫秒数
     */
    function clampSilenceMs(value) {
      if (!Number.isFinite(value)) return SILENCE_DEFAULT
      return Math.min(SILENCE_MAX, Math.max(SILENCE_MIN, Math.round(value)))
    }

    /**
     * 把任意输入收敛成合法的单句最长毫秒数（0–3600000，0 表示不限）。
     * @param {number} value 原始值
     * @returns {number} 合法毫秒数
     */
    function clampMaxSegment(value) {
      if (!Number.isFinite(value)) return MAX_SEGMENT_DEFAULT
      return Math.min(MAX_SEGMENT_MAX, Math.max(0, Math.round(value)))
    }

    /**
     * 单句最长档位的显示文案：0 = 不限，其它按分钟显示（非整分钟保留一位小数）。
     * @param {number} ms 毫秒
     * @returns {string} 文案
     */
    function maxSegmentLabel(ms) {
      if (ms === 0) return zh.maxSegUnlimited
      const minutes = Math.round((ms / 60000) * 10) / 10
      return zh.maxSegOption.replaceAll('{n}', String(minutes))
    }

    /**
     * 把任意输入收敛成合法的 HUD 不透明度（0.2–1）。
     * 0.2 是下限：再低就等于把卡片藏起来了，不如直接关掉开关。
     * @param {unknown} value 原始值
     * @returns {number} 0.2–1
     */
    function clampHudOpacity(value) {
      if (!Number.isFinite(value)) return 1
      return Math.min(1, Math.max(0.2, value))
    }

    /**
     * 把任意输入收敛成合法的 z-index（0–2147483647）。
     * 配置写坏了就回默认值，别让一次手误把卡片藏到所有东西后面。
     * @param {unknown} value 原始值
     * @returns {number} 0–2147483647
     */
    function clampHudZIndex(value) {
      if (!Number.isFinite(value)) return 2147483000
      return Math.min(2147483647, Math.max(0, Math.round(value)))
    }

    /**
     * 校验 HUD 的初始坐标：只接受 {x,y} 都是有限数字，否则当作「没有初值」。
     * @param {unknown} value 原始值
     * @returns {{x: number, y: number}|null} 合法坐标
     */
    function normalizeHudPosition(value) {
      if (value === null || typeof value !== 'object') return null
      if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null
      return { x: value.x, y: value.y }
    }

    /**
     * 实际生效的触发阈值：取「该档的绝对下限」和「底噪 × 该档倍数」的较大者。
     * 档位越低，下限和倍数都越小（越灵敏）；对话中完全不看档位，只跟底噪走。
     * @returns {number} RMS 阈值
     */
    function effectiveThreshold() {
      // 对话中：灵敏度档位不参与判定，只跟环境噪声地板走。
      // 这样「说完后静音」才是唯一的切段条件；说话轻一点、换气掉音量都不会被当成说完。
      if (status.mode === 'conversing') {
        // 地板 0.002 是关键：不少麦克风的底噪就在 0.001x 附近，门槛压到 0.001 会让
        // 底噪一直被当成「有声」，静音永远攒不满，最后只能撞单句上限，
        // 长段噪声还容易被 ASR 幻听成「鲸鱼结束」之类的词。
        return Math.min(0.05, Math.max(0.002, audio.vad.noiseFloor * 2.2))
      }
      const index = clampSensitivity(tuning.wakeSensitivity) - 1
      return Math.min(0.05, Math.max(SENSITIVITY_FLOORS[index], audio.vad.noiseFloor * SENSITIVITY_FACTORS[index]))
    }

    /** 多久往 run.log 写一次当前音量（证明麦克风到底有没有在出数据）。 */
    const LEVEL_LOG_MS = 10000
    /** 测试录音时长。 */
    const TEST_MS = 3000
    const POST_TIMEOUT_MS = 75000

    /**
     * 一段 WAV 发出去后等识别结果的上限；首次识别要加载本地模型，给足 75 秒。
     * 长录音（单句最长可到「不限」）按音频时长放宽，避免 5 分钟的话还没识别完就超时。
     * @param {number} durationMs 这段录音的时长
     * @returns {number} 超时毫秒数
     */
    function postTimeoutFor(durationMs) {
      return Math.max(POST_TIMEOUT_MS, Math.round(durationMs * 1.2) + 45000)
    }
    /** 切完一段后的这段时间不写 audio.level，否则日志看起来像「每段都跟一条」。 */
    const LEVEL_QUIET_AFTER_SEGMENT_MS = 3000
    /** 音量条刷新间隔：10 次/秒足够跟手，也不会每帧都改 DOM。 */
    const METER_TICK_MS = 100
    /** 常听时超过这么久没有任何音频回调，就认定 AudioContext 卡住了。 */
    const AUDIO_STALL_MS = 2500
    /** 「audio.stalled」日志的重发间隔，避免每轮循环刷一条。 */
    const AUDIO_STALL_LOG_MS = 20000
    /** 主窗口轮询 Host（状态 + 切会话目标）的间隔。 */
    const POLL_INTERVAL_MS = 700
    /** 「复制诊断信息」时附带最近多少条 Host 日志。 */
    const DIAG_LOG_LIMIT = 60

    /**
     * 当前的采集对象。Host 只有一份，浏览器也只有一份常听。
     * @type {null | object}
     */
    const audio = {
      capture: null,
      running: false,
      starting: false,
      /** 测试录音时把原始块抓出来（不影响常听的 VAD）。 */
      tap: null,
      /** 正在跑「测试识别」：这段时间暂停常听 VAD，避免测试时真的把话发进会话。 */
      testing: false,
      busy: false,
      vad: { speaking: false, frames: [], preRoll: [], durationMs: 0, voicedMs: 0, silenceMs: 0, noiseFloor: 0.0015, peak: 0, lastLevelLogAt: 0, probeIndex: 0 },
      /** 上一段切段的时间。切段后 3 秒不再打 audio.level，避免日志看起来像「每段一条」。 */
      lastSegmentAt: 0,
      /** 最近一次唤醒提示音响的时间：送达音要跟它错开，别叠成一声。 */
      wakeChimeAt: 0,
      /** 探测命中后本段按更短的静音判定切段，尽快拿到「只有唤醒词」的确认。 */
      wakeCut: false,
      /** 「请讲」窗口；非 null 表示唤醒已确认、正在等用户说正文。 */
      followup: null,
      /** 是否有探测请求在飞：同一时间只跑一个，避免多个探测互相排队拖慢。 */
      probeInFlight: false,
      /** 本轮是否已叫醒：HUD 的「已唤醒」保持到这句发完为止。 */
      awake: false,
      /** 叫醒时间：保证极短句也能让「已唤醒」至少显示 1.2 秒，不至于一闪而过。 */
      awakeAt: 0,
    }
    /** 预览用的一次性采集（开关没打开时也能看音量）。 */
    let monitor = null
    let meterRaf = 0
    let meterTickAt = 0

    function copyBlock(data) {
      const out = new Float32Array(data.length)
      out.set(data)
      return out
    }

    /**
     * 把 0..1 的 RMS 映射成 0..100 的「音量」，用 dBFS 更符合人耳：
     * -60 dB 以下算 0，0 dB 算 100。
     * @param {number} rms 均方根
     * @returns {number} 0-100 的整数
     */
    function rmsToLevel(rms) {
      if (!Number.isFinite(rms) || rms <= 0) return 0
      const db = 20 * Math.log10(rms)
      const level = ((db + 60) / 60) * 100
      return Math.max(0, Math.min(100, Math.round(level)))
    }

    function rmsOf(samples) {
      let sum = 0
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index]
        sum += value * value
      }
      return Math.sqrt(sum / Math.max(1, samples.length))
    }

    function peakOf(samples) {
      let peak = 0
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.abs(samples[index])
        if (value > peak) peak = value
      }
      return peak
    }

    /** 把麦克风错误翻译成「该看哪里」的日志 + 本地提示。 */
    function reportMicFailure(error) {
      const name = typeof error?.name === 'string' ? error.name : ''
      const detail = `${name === '' ? 'Error' : name}: ${error instanceof Error ? error.message : String(error)}`
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        clog('mic.denied', detail)
        publish({ permission: 'denied', micState: 'error', localError: zh.micDenied.replaceAll('{detail}', detail) })
        return
      }
      clog('mic.error', detail)
      publish({ micState: 'error', localError: zh.micDenied.replaceAll('{detail}', detail) })
    }

    /**
     * 让被浏览器挂起的 AudioContext 恢复。**不阻塞建图**：resume() 在没有用户手势时
     * 可能一直不 resolve，以前 await 它会让 startEngine 永远卡住（麦克风开着但一个回调都没有）。
     * @param {AudioContext} context 上下文
     */
    function resumeContext(context) {
      const timer = new Promise((resolve) => window.setTimeout(resolve, 1200))
      Promise.race([
        context
          .resume()
          .then(() => 'resumed')
          .catch(() => 'rejected'),
        timer.then(() => 'timeout'),
      ])
        .then((outcome) => {
          clog(outcome === 'resumed' ? 'audio.resumed' : 'audio.suspended', `state=${context.state} outcome=${outcome}`)
          if (context.state !== 'running') armGestureResume(context)
        })
        .catch(() => undefined)
    }

    /** 等用户下一次点击再 resume 一次。 */
    function armGestureResume(context) {
      const handler = () => {
        document.removeEventListener('pointerdown', handler, true)
        void context.resume().catch(() => undefined)
      }
      document.addEventListener('pointerdown', handler, true)
    }

    /**
     * 打开一路麦克风采集。所有建图都在 resume() 之前完成，保证「上下文被挂起」时
     * 恢复后立刻有数据，而不是永远没有回调。
     * @param {string} deviceId 设备 id，空串表示系统默认
     * @returns {Promise<object>} 采集对象
     */
    async function openCapture(deviceId) {
      const media = navigator.mediaDevices
      if (media === undefined || typeof media.getUserMedia !== 'function') {
        clog('mic.error', 'navigator.mediaDevices.getUserMedia 不可用')
        throw new Error(zh.micUnsupported)
      }
      const wanted = typeof deviceId === 'string' ? deviceId : ''
      clog('mic.request', `device=${wanted === '' ? 'default' : wanted}`)
      publish({ micState: 'starting' })
      const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      let stream
      try {
        stream = await media.getUserMedia({
          audio: wanted === '' ? base : { ...base, deviceId: { exact: wanted } },
          video: false,
        })
      } catch (error) {
        const name = typeof error?.name === 'string' ? error.name : ''
        if ((name === 'OverconstrainedError' || name === 'NotFoundError') && wanted !== '') {
          // 设备被拔掉/换过 id 时，不要就此报废：退回系统默认设备。
          clog('mic.fallback', `device-unusable ${name} → system default`)
          try {
            stream = await media.getUserMedia({ audio: base, video: false })
          } catch (second) {
            reportMicFailure(second)
            throw second
          }
        } else {
          reportMicFailure(error)
          throw error
        }
      }
      const track = stream.getAudioTracks()[0]
      const label = typeof track?.label === 'string' ? track.label : ''
      clog('mic.granted', `label=${label === '' ? '(no-label)' : label}`)

      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (typeof AudioCtor !== 'function') {
        for (const item of stream.getTracks()) item.stop()
        clog('mic.error', 'AudioContext 不可用')
        throw new Error(zh.micUnsupported)
      }
      let context
      try {
        context = new AudioCtor({ latencyHint: 'interactive' })
      } catch {
        context = new AudioCtor()
      }
      const sampleRate = context.sampleRate
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.5
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(BLOCK, 1, 1)
      // 0 增益接到 destination，只为了让 ScriptProcessor 持续被驱动，不发出声音。
      const sink = context.createGain()
      sink.gain.value = 0
      source.connect(analyser)
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)

      const capture = {
        stream,
        context,
        source,
        analyser,
        processor,
        sink,
        sampleRate,
        deviceLabel: label,
        meterBuf: new Float32Array(analyser.fftSize),
        openedAt: Date.now(),
        lastBlockAt: 0,
        blocks: 0,
        peak: 0,
        closed: false,
        lastStallLogAt: 0,
        onBlock: null,
      }

      processor.onaudioprocess = (event) => {
        if (capture.closed) return
        const channels = event.inputBuffer.numberOfChannels
        // 只取声道 0 会踩到「只有右声道有信号」的声卡；多声道时做一次平均。
        let mono = event.inputBuffer.getChannelData(0)
        if (channels > 1) {
          const mixed = new Float32Array(mono.length)
          for (let channel = 0; channel < channels; channel += 1) {
            const data = event.inputBuffer.getChannelData(channel)
            for (let index = 0; index < mixed.length; index += 1) mixed[index] += data[index] / channels
          }
          mono = mixed
        }
        // 必须拷贝：AudioBuffer 的内存可能在回调返回后被复用。
        const block = copyBlock(mono)
        capture.blocks += 1
        capture.lastBlockAt = Date.now()
        if (audio.running && capture === audio.capture) feedBlock(block, capture)
        if (audio.tap !== null) audio.tap(block)
      }

      // 设备被拔掉/系统抢走时及时收尾，别留一个静默的「监听中」。
      for (const item of stream.getTracks()) {
        item.addEventListener('ended', () => {
          if (capture.closed) return
          clog('mic.ended', `label=${label === '' ? '(no-label)' : label}`)
          if (capture === audio.capture) {
            stopEngine()
          } else if (capture === monitor) {
            stopMonitor()
          }
          publish({ micState: 'error', localError: zh.micDenied.replaceAll('{detail}', '设备已断开（ended）') })
        })
      }

      clog(
        'audio.running',
        `sampleRate=${sampleRate} device=${label === '' ? '(no-label)' : label} state=${context.state} block=${BLOCK}`,
      )
      publish({ sampleRate, deviceLabel: label, micState: 'running', localError: '' })
      if (context.state === 'suspended') {
        clog('audio.suspended', 'created-suspended → resume()')
        resumeContext(context)
      }
      void refreshPermission()
      return capture
    }

    /**
     * 关掉一路采集。
     * @param {object|null} capture 采集对象
     */
    function closeCapture(capture) {
      if (capture === null || capture === undefined || capture.closed) return
      capture.closed = true
      clog('mic.stopped', `blocks=${capture.blocks} label=${capture.deviceLabel === '' ? '(no-label)' : capture.deviceLabel}`)
      try {
        capture.processor.onaudioprocess = null
        capture.processor.disconnect()
      } catch {
        // 已经断开就无所谓。
      }
      try {
        capture.source.disconnect()
      } catch {
        // 同上。
      }
      try {
        capture.sink.disconnect()
      } catch {
        // 同上。
      }
      try {
        void capture.context.close()
      } catch {
        // 同上。
      }
      try {
        for (const track of capture.stream.getTracks()) track.stop()
      } catch {
        // 同上。
      }
    }

    /**
     * 唤醒成功提示音：一轻一重两声「叮-咚」，用采集的 AudioContext 现场合成。
     * 不读音频文件、不加依赖；失败也不影响主流程。
     */
    function playWakeChime() {
      const context = audio.capture?.context
      if (!context) return
      // 音量来自设置（0–100），0 = 完全静音。
      const volume = Math.max(0, Math.min(100, Number(status.chimeVolume) || 0)) / 100
      if (volume <= 0) return
      try {
        if (context.state === 'suspended') void context.resume()
        const now = context.currentTime
        const master = context.createGain()
        master.gain.setValueAtTime(0.0001, now)
        master.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.015)
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.36)
        master.connect(context.destination)
        const ding = context.createOscillator()
        ding.type = 'sine'
        ding.frequency.setValueAtTime(988, now)
        ding.connect(master)
        ding.start(now)
        ding.stop(now + 0.12)
        const dong = context.createOscillator()
        dong.type = 'sine'
        dong.frequency.setValueAtTime(1319, now + 0.12)
        dong.connect(master)
        dong.start(now + 0.12)
        dong.stop(now + 0.36)
        audio.wakeChimeAt = Date.now()
        clog('wake.chime', 'played')
      } catch {
        // 提示音失败不影响主流程。
      }
    }

    /**
     * 送达提示音：比唤醒音更低、更短的一声「嗒」，表示这句话已经发进会话。
     * 如果唤醒音刚响过（探测没命中、由完整识别补响），延后到 350ms 之后，保证两声分得开。
     */
    function playSentChime() {
      const context = audio.capture?.context
      if (!context) return
      const volume = Math.max(0, Math.min(100, Number(status.chimeVolume) || 0)) / 100
      if (volume <= 0) return
      try {
        if (context.state === 'suspended') void context.resume()
        const delayMs = Math.max(0, 350 - (Date.now() - audio.wakeChimeAt))
        const start = context.currentTime + delayMs / 1000
        const master = context.createGain()
        master.gain.setValueAtTime(0.0001, start)
        master.gain.exponentialRampToValueAtTime(Math.max(0.001, volume * 0.7), start + 0.012)
        master.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
        master.connect(context.destination)
        const tone = context.createOscillator()
        tone.type = 'sine'
        tone.frequency.setValueAtTime(660, start)
        tone.connect(master)
        tone.start(start)
        tone.stop(start + 0.18)
        clog('send.chime', `delay=${Math.round(delayMs)}ms`)
      } catch {
        // 提示音失败不影响主流程。
      }
    }

    /** 清空一段的 VAD 状态。 */
    function resetVad() {
      audio.vad.speaking = false
      audio.vad.frames = []
      audio.vad.preRoll = []
      audio.vad.durationMs = 0
      audio.vad.voicedMs = 0
      audio.vad.silenceMs = 0
      audio.vad.peak = 0
      audio.vad.probeIndex = 0
      // 快切只对“探测命中的那一段”有效，任何一次重置都清掉，别带到下一段。
      audio.wakeCut = false
    }

    /**
     * 每来一块原始采样就跑一次：能量 VAD + 切段。
     * @param {Float32Array} samples 单声道采样（已拷贝）
     * @param {object} capture 采集对象
     */
    function feedBlock(samples, capture) {
      // 「测试识别」期间暂停常听 VAD：测试说的话只走 /utterance?test=1，
      // 绝不参与切段、唤醒匹配，更不会发进会话。
      if (audio.testing) return
      const vad = audio.vad
      const blockMs = (samples.length / capture.sampleRate) * 1000
      const level = rmsOf(samples)
      const peak = peakOf(samples)
      const threshold = effectiveThreshold()
      const voiced = level > threshold
      // 「请讲」窗口里一检测到说话，就取消 5 秒超时：接下来按“说完静音”切段。
      if (voiced && audio.followup !== null) markFollowupSpeech()

      // 噪声地板缓慢跟随「安静时」的音量，阈值再跟着地板走。
      if (!vad.speaking && !voiced) {
        vad.noiseFloor = Math.min(0.02, Math.max(0.0003, vad.noiseFloor * 0.95 + level * 0.05))
      }

      if (!vad.speaking) {
        vad.preRoll.push(samples)
        if (vad.preRoll.length > PRE_ROLL_BLOCKS) vad.preRoll.shift()
        if (!voiced) {
          maybeLogLevel(level, peak, threshold, capture)
          return
        }
        vad.speaking = true
        vad.frames = vad.preRoll.slice()
        vad.preRoll = []
        vad.durationMs = vad.frames.length * blockMs
        vad.voicedMs = blockMs
        vad.silenceMs = 0
        vad.peak = peak
        clog('vad.start', `rms=${level.toFixed(4)} threshold=${threshold.toFixed(4)}`)
        return
      }

      vad.frames.push(samples)
      vad.durationMs += blockMs
      if (peak > vad.peak) vad.peak = peak
      if (voiced) {
        vad.voicedMs += blockMs
        vad.silenceMs = 0
      } else {
        vad.silenceMs += blockMs
      }
      // 快速唤醒探测：时间点由唤醒词长度自动算（见 probeScheduleFor）；
      // 命中后立刻响「叮」并停止后续探测。
      const nextProbeAt = tuning.probeSchedule[vad.probeIndex]
      if (
        status.probeEnabled !== false &&
        nextProbeAt !== undefined &&
        vad.durationMs >= nextProbeAt &&
        vad.voicedMs >= PROBE_MIN_VOICED_MS &&
        audio.probeInFlight !== true
      ) {
        vad.probeIndex += 1
        audio.probeInFlight = true
        void probeWake(vad.frames.slice()).finally(() => {
          audio.probeInFlight = false
        })
      }
      // 唤醒确认阶段用更短的静音；普通阶段仍按设置里的「说完后静音」。
      const silenceLimit = audio.wakeCut ? WAKE_CONFIRM_SILENCE_MS : tuning.silenceMs
      if (vad.silenceMs >= silenceLimit || (tuning.maxSegmentMs > 0 && vad.durationMs >= tuning.maxSegmentMs)) {
        void flushSegment()
      }
    }

    /**
     * 把一段开头音频发给 Host 做「只找唤醒词」的快速识别。
     * 命中不直接响铃，只把本段切成 0.6 秒静音，等完整识别确认“只有唤醒词”。
     * 任何失败都静默忽略——正式识别仍然会正常跑。
     * @param {Float32Array[]} frames 开头这段的音频块
     */
    async function probeWake(frames) {
      const capture = audio.capture
      if (capture === null || frames.length === 0) return
      try {
        const wave = await toWave16k(frames, capture.sampleRate)
        const response = await request(
          '/utterance?probe=1',
          { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wave },
          PROBE_TIMEOUT_MS,
        )
        if (!response.ok) return
        const result = await response.json()
        if (result?.wake === true) {
          // 只是「可能在叫醒」：先让本段快点切（0.6 秒静音），等完整识别确认
          // “只有唤醒词”之后再响「叮」、再进「请讲」窗口。
          audio.wakeCut = true
          audio.vad.probeIndex = tuning.probeSchedule.length
          clog('wake.probe-hit', `bytes=${wave.byteLength}`)
        }
      } catch {
        // 探测失败不影响正式识别。
      }
    }

    /**
     * 安静时也要定期把音量写进日志，才能区分「麦克风没数据」和「声音太小」。
     * 两条约束：全局最多每 10 秒一条；刚切完段的 3 秒内不打，
     * 否则日志看起来就像「每段都跟着一条 audio.level」。
     * @param {number} level 当前块 RMS
     * @param {number} peak 当前块峰值
     * @param {number} threshold 当前 VAD 阈值
     * @param {object} capture 采集对象
     */
    function maybeLogLevel(level, peak, threshold, capture) {
      const now = Date.now()
      if (now - audio.vad.lastLevelLogAt < LEVEL_LOG_MS) return
      if (now - audio.lastSegmentAt < LEVEL_QUIET_AFTER_SEGMENT_MS) return
      audio.vad.lastLevelLogAt = now
      clog(
        'audio.level',
        `rms=${level.toFixed(4)} peak=${peak.toFixed(4)} floor=${audio.vad.noiseFloor.toFixed(4)}` +
          ` threshold=${threshold.toFixed(4)} rate=${capture.sampleRate}` +
          `${peak >= 0.99 ? ' clip=1' : ''}`,
      )
    }

    /**
     * 用 OfflineAudioContext 做高质量重采样，再手写 44 字节 WAV 头。全程内存，不落盘。
     * @param {Float32Array[]} chunks 原始块
     * @param {number} sampleRate 原始采样率
     * @returns {Promise<ArrayBuffer>} 16 kHz 单声道 PCM16 WAV
     */
    async function toWave16k(chunks, sampleRate) {
      let total = 0
      for (const chunk of chunks) total += chunk.length
      if (total === 0) throw new Error('empty-audio')
      const flat = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        flat.set(chunk, offset)
        offset += chunk.length
      }
      const target = Math.max(1, Math.floor((flat.length * 16000) / sampleRate))
      const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext
      if (typeof OfflineCtor !== 'function') throw new Error('OfflineAudioContext-unavailable')
      const offline = new OfflineCtor(1, target, 16000)
      const buffer = offline.createBuffer(1, flat.length, sampleRate)
      buffer.copyToChannel(flat, 0)
      const node = offline.createBufferSource()
      node.buffer = buffer
      node.connect(offline.destination)
      node.start()
      const rendered = await offline.startRendering()
      return encodeWave(rendered.getChannelData(0))
    }

    /**
     * 编码成 16 kHz 单声道 PCM16 WAV。
     * @param {Float32Array} samples 16 kHz 采样
     * @returns {ArrayBuffer} WAV 字节
     */
    function encodeWave(samples) {
      const length = samples.length
      const buffer = new ArrayBuffer(44 + length * 2)
      const view = new DataView(buffer)
      const writeAscii = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      writeAscii(0, 'RIFF')
      view.setUint32(4, 36 + length * 2, true)
      writeAscii(8, 'WAVE')
      writeAscii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, 'data')
      view.setUint32(40, length * 2, true)
      let offset = 44
      for (let index = 0; index < length; index += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
        offset += 2
      }
      return buffer
    }

    /** 一段录好的音频：能复用已打开的那一路（常听或预览）就复用，否则临时开一路。 */
    async function recordClip(milliseconds) {
      const blocks = []
      let release = () => {}
      let sampleRate = 0
      const existing = activeCapture()
      if (existing !== null) {
        sampleRate = existing.sampleRate
        audio.tap = (block) => blocks.push(block)
        release = () => {
          audio.tap = null
        }
      } else {
        const capture = await openCapture(status.deviceId)
        sampleRate = capture.sampleRate
        audio.tap = (block) => blocks.push(block)
        release = () => {
          audio.tap = null
          closeCapture(capture)
        }
      }
      try {
        await new Promise((resolve) => window.setTimeout(resolve, milliseconds))
      } finally {
        release()
      }
      const frames = blocks.reduce((sum, block) => sum + block.length, 0)
      return { blocks, sampleRate, durationMs: sampleRate === 0 ? 0 : (frames / sampleRate) * 1000 }
    }

    /**
     * 把一段 WAV 发给 Host 识别。
     * @param {ArrayBuffer} wave WAV 字节
     * @param {object} query 额外查询参数
     * @param {number} timeoutMs 超时
     * @returns {Promise<object>} Host 返回
     */
    async function postWave(wave, query, timeoutMs) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null) params.set(key, String(value))
      }
      const suffix = params.toString()
      const response = await request(`/utterance${suffix === '' ? '' : `?${suffix}`}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wave,
      }, timeoutMs)
      return response
    }

    /**
     * 唤醒确认后开「请讲」窗口：响「叮」、HUD 保持已唤醒，5 秒内等用户说正文。
     * @param {string} sessionId 唤醒时选定的会话（后续正文发到这里）
     */
    function beginFollowup(sessionId) {
      if (audio.followup !== null) endFollowup('reopen')
      playWakeChime()
      audio.awake = true
      audio.awakeAt = Date.now()
      audio.followup = {
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        speaking: false,
        timer: null,
      }
      audio.followup.timer = window.setTimeout(() => endFollowup('no-speech'), FOLLOWUP_WINDOW_MS)
      clog('followup.open', `ms=${FOLLOWUP_WINDOW_MS}`)
    }

    /** 结束「请讲」窗口：清掉定时器，HUD 回到聆听中。 */
    function endFollowup(reason) {
      if (audio.followup === null) return
      if (audio.followup.timer !== null) window.clearTimeout(audio.followup.timer)
      audio.followup = null
      audio.awake = false
      clog('followup.close', `reason=${reason}`)
    }

    /** 窗口内检测到说话：取消 5 秒超时，改成「说完静音就发」。 */
    function markFollowupSpeech() {
      if (audio.followup === null || audio.followup.speaking) return
      audio.followup.speaking = true
      if (audio.followup.timer !== null) {
        window.clearTimeout(audio.followup.timer)
        audio.followup.timer = null
      }
      clog('followup.speech', 'timeout-cancelled')
    }

    /** 处理一段常听音频：切好了就发去识别。 */
    async function flushSegment() {
      const vad = audio.vad
      const frames = vad.frames
      const durationMs = vad.durationMs
      const voicedMs = vad.voicedMs
      const peak = vad.peak
      const capture = audio.capture
      const sampleRate = capture === null ? 0 : capture.sampleRate
      const followMode = audio.followup !== null && audio.followup.speaking === true
      const silenceUsed = audio.wakeCut ? WAKE_CONFIRM_SILENCE_MS : tuning.silenceMs
      audio.wakeCut = false
      resetVad()
      if (frames.length === 0 || voicedMs < MIN_VOICED_MS) {
        if (frames.length > 0) clog('vad.skip', `voiced=${Math.round(voicedMs)}ms < ${MIN_VOICED_MS}ms`)
        if (audio.followup !== null) endFollowup('too-short')
        return
      }
      if (audio.busy) {
        clog('vad.drop', `busy dur=${Math.round(durationMs)}ms voiced=${Math.round(voicedMs)}ms`)
        if (audio.followup !== null) endFollowup('busy')
        return
      }
      audio.busy = true
      audio.lastSegmentAt = Date.now()
      try {
        let wave
        try {
          wave = await toWave16k(frames, sampleRate)
        } catch (error) {
          clog('resample.failed', error instanceof Error ? error.message : String(error))
          throw error
        }
        clog(
          'vad.segment',
          `dur=${Math.round(durationMs)}ms voiced=${Math.round(voicedMs)}ms peak=${peak.toFixed(4)}` +
            ` silence=${silenceUsed}ms rate=${sampleRate} bytes=${wave.byteLength}${peak >= 0.99 ? ' clip=1' : ''}`,
        )
        clog('post.sent', `bytes=${wave.byteLength} dur=${Math.round(durationMs)} follow=${followMode ? 1 : 0}`)
        const query = {
          dur: Math.round(durationMs),
          peak: peak.toFixed(4),
          voiced: Math.round(voicedMs),
          session: followMode && audio.followup.sessionId !== '' ? audio.followup.sessionId : activeSessionId,
        }
        if (followMode) query.follow = 1
        let response
        try {
          // voiced 也一起上报：Host 在识别为空时用它区分「没说话」和「削波」。
          response = await postWave(wave, query, postTimeoutFor(durationMs))
        } catch (error) {
          clog('post.failed', `network ${error instanceof Error ? error.message : String(error)}`)
          throw error
        }
        if (!response.ok) {
          clog('post.failed', `status=${response.status}`)
          throw new Error(`HTTP ${response.status}`)
        }
        const result = await response.json()
        applyServerState(result)
        if (result?.code === 'woken' && result.sent === false) {
          // 严格确认：整段只有唤醒词 → 响「叮」、开「请讲」窗口。
          beginFollowup(result.sessionId)
        } else if (result?.sent === true) {
          // 送达音：这句话已经成功发进会话。
          playSentChime()
          if (audio.followup !== null) endFollowup('sent')
        } else if (followMode) {
          // 窗口里这段没识别出正文 / 被拦下：当作误触发，收回聆听中。
          endFollowup(`follow-${result?.code ?? 'unknown'}`)
        }
        publish({ localError: '', lastPeak: peak })
        if (typeof result?.sessionId === 'string' && result.sessionId !== '') switchTo(result.sessionId)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        publish({ localError: `${zh.transcribeError}${detail}` })
        if (audio.followup !== null) endFollowup('send-error')
      } finally {
        audio.busy = false
        // 「请讲」窗口期间 HUD 必须保持「已唤醒」，不要按 1.2 秒的短句逻辑收回。
        if (audio.followup === null) {
          // 这句处理完：HUD 从「已唤醒」回到「监听中」。
          // 极短句（叫醒和发送几乎同时）也保留 1.2 秒，避免绿灯一闪而过看不见。
          const holdMs = audio.awake ? Math.max(0, 1200 - (Date.now() - audio.awakeAt)) : 0
          if (holdMs > 0) {
            window.setTimeout(() => {
              audio.awake = false
            }, holdMs)
          } else {
            audio.awake = false
          }
        }
      }
    }

    /** 每次 start/stop 都 +1，避免「打开到一半又被关掉」时留下僵尸采集。 */
    let engineGeneration = 0

    /** 启动常听。 */
    async function startEngine(deviceId) {
      if (audio.running || audio.starting) return
      audio.starting = true
      const generation = ++engineGeneration
      try {
        const capture = await openCapture(deviceId)
        if (generation !== engineGeneration) {
          // 等待权限/设备的过程中用户已经关掉了开关：这次采集直接释放。
          closeCapture(capture)
          return
        }
        audio.capture = capture
        audio.running = true
        resetVad()
        publish({ localError: '', micState: 'running' })
      } finally {
        audio.starting = false
      }
    }

    /** 停止常听。 */
    function stopEngine() {
      engineGeneration += 1
      // 停听时把「请讲」窗口一起收掉，别留下一个永远等不到正文的已唤醒状态。
      endFollowup('engine-stop')
      if (!audio.running && audio.capture === null) return
      const capture = audio.capture
      audio.running = false
      audio.capture = null
      audio.tap = null
      resetVad()
      if (capture !== null) closeCapture(capture)
      publish({ micState: monitor === null ? 'idle' : 'running', level: 0, peak: 0, sampleRate: monitor === null ? 0 : status.sampleRate })
    }

    // ------------------------------------------------- 麦克风预览（音量条）

    /** 打开预览采集（常听已开时直接复用，不重复占用设备）。 */
    async function startMonitor() {
      if (audio.capture !== null || monitor !== null || audio.starting) return
      try {
        monitor = await openCapture(status.deviceId)
        publish({ micState: 'running' })
      } catch {
        monitor = null
        publish({ micState: 'error' })
      }
    }

    function stopMonitor() {
      if (monitor === null) return
      closeCapture(monitor)
      monitor = null
      if (!audio.running) publish({ micState: 'idle', level: 0, peak: 0, sampleRate: 0 })
    }

    /** 当前用于看/测的那一路采集。 */
    function activeCapture() {
      if (audio.capture !== null && !audio.capture.closed) return audio.capture
      if (monitor !== null && !monitor.closed) return monitor
      return null
    }

    /**
     * 音量循环。用 analyser（而不是 ScriptProcessor 的回调）读数，
     * 这样即使处理器一个回调都没来，也能看出「有没有信号」和「是不是卡住了」。
     */
    function meterLoop() {
      const capture = activeCapture()
      const now = Date.now()
      if (capture !== null) {
        capture.analyser.getFloatTimeDomainData(capture.meterBuf)
        const rms = rmsOf(capture.meterBuf)
        const peak = peakOf(capture.meterBuf)
        if (peak > capture.peak) capture.peak = peak
        if (now - meterTickAt >= METER_TICK_MS) {
          meterTickAt = now
          const level = rmsToLevel(rms)
          const shownPeak = Math.max(status.peak * 0.92, peak)
          publish({ level, peak: Number(shownPeak.toFixed(4)) })
        }
        // 常听时如果处理器长时间不回调，说明 AudioContext 卡住了：写日志 + 尝试恢复。
        if (audio.running && capture === audio.capture) {
          const last = capture.lastBlockAt === 0 ? capture.openedAt : capture.lastBlockAt
          if (now - last > AUDIO_STALL_MS && now - capture.lastStallLogAt > AUDIO_STALL_LOG_MS) {
            capture.lastStallLogAt = now
            clog(
              'audio.stalled',
              `no-blocks ${Math.round(now - last)}ms blocks=${capture.blocks} state=${capture.context.state}`,
            )
            publish({ micState: 'stalled' })
            if (capture.context.state !== 'running') resumeContext(capture.context)
          }
        }
      } else if (status.level !== 0 || status.peak !== 0) {
        publish({ level: 0, peak: 0 })
      }
      meterRaf = window.requestAnimationFrame(meterLoop)
    }

    function startMeterLoop() {
      if (meterRaf !== 0) return
      meterRaf = window.requestAnimationFrame(meterLoop)
    }

    function stopMeterLoop() {
      if (meterRaf === 0) return
      window.cancelAnimationFrame(meterRaf)
      meterRaf = 0
    }

    /** 读一下浏览器给的麦克风权限状态（有的环境不支持，忽略即可）。 */
    async function refreshPermission() {
      try {
        if (navigator.permissions !== undefined && typeof navigator.permissions.query === 'function') {
          const result = await navigator.permissions.query({ name: 'microphone' })
          if (typeof result?.state === 'string') publish({ permission: result.state })
        }
      } catch {
        // Firefox/旧版本不支持 microphone 查询，保持 unknown。
      }
    }

    // ------------------------------------------------------- 设置页里的两个动作

    /**
     * 「测试识别」：录 3 秒 → 走完整识别链路 → 原样显示识别文本。
     * 不做唤醒词匹配，也不往会话里发任何东西。
     */
    async function runMicTest() {
      const test = { phase: 'recording', text: '', code: '', ms: 0, peak: 0, floor: 0, at: Date.now(), error: '', durationMs: TEST_MS }
      publish({ test, localError: '' })
      clog('test.start', `ms=${TEST_MS} device=${status.deviceId === '' ? 'default' : status.deviceId} enabled=${status.enabled}`)
      let clip
      // 录音期间把常听 VAD 关掉：测试里说的话不会切段、不会唤醒、不会发进会话。
      audio.testing = true
      resetVad()
      try {
        clip = await recordClip(TEST_MS)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        clog('test.failed', `capture ${detail}`)
        publish({ test: { ...test, phase: 'error', error: detail } })
        return
      } finally {
        audio.testing = false
        resetVad()
      }
      let peak = 0
      for (const block of clip.blocks) {
        const blockPeak = peakOf(block)
        if (blockPeak > peak) peak = blockPeak
      }
      // 底噪估算：取能量最低的 20% 分位——说话间隙的环境噪声就落在这里。
      const levels = clip.blocks.map((block) => rmsOf(block)).sort((a, b) => a - b)
      const floor = levels.length === 0 ? 0 : levels[Math.floor(levels.length * 0.2)]
      test.floor = floor
      if (clip.blocks.length === 0) {
        clog('test.failed', 'no-audio-blocks')
        publish({ test: { ...test, phase: 'error', error: '没有采到任何音频块', peak: 0 } })
        return
      }
      publish({ test: { ...test, phase: 'sending', peak, durationMs: Math.round(clip.durationMs) } })
      let wave
      try {
        wave = await toWave16k(clip.blocks, clip.sampleRate)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        clog('test.failed', `resample ${detail}`)
        publish({ test: { ...test, phase: 'error', error: detail, peak } })
        return
      }
      clog('vad.segment', `test dur=${Math.round(clip.durationMs)}ms peak=${peak.toFixed(4)} bytes=${wave.byteLength}`)
      clog('post.sent', `test bytes=${wave.byteLength} peak=${peak.toFixed(4)}`)
      let response
      try {
        response = await postWave(wave, { test: 1, dur: Math.round(clip.durationMs), peak: peak.toFixed(4) }, POST_TIMEOUT_MS)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        clog('post.failed', `test network ${detail}`)
        publish({ test: { ...test, phase: 'error', error: detail, peak } })
        return
      }
      if (!response.ok) {
        clog('post.failed', `test status=${response.status}`)
        publish({ test: { ...test, phase: 'error', error: `HTTP ${response.status}`, peak } })
        return
      }
      let result
      try {
        result = await response.json()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        clog('test.failed', `json ${detail}`)
        publish({ test: { ...test, phase: 'error', error: 'Host 返回的不是 JSON', peak } })
        return
      }
      applyServerState(result)
      if (result?.code === 'test-ok') {
        const text = typeof result.text === 'string' ? result.text : ''
        clog('test.done', `ok text=${text === '' ? 'empty' : text.slice(0, 120)}`)
        publish({ test: { ...test, phase: 'done', text, code: 'test-ok', peak, ms: Number(result.ms) || 0 } })
        return
      }
      const detail = typeof result?.error === 'string' && result.error !== '' ? result.error : String(result?.code ?? 'failed')
      clog('test.failed', `host ${detail}`)
      publish({ test: { ...test, phase: 'error', error: detail, peak } })
    }

    /**
     * 「链路自检」：发 0.5 秒静音。能收到 200 + code=test-ok 就说明
     * 路由、认证、WAV 校验、识别服务这条链路都是通的（文本为空是正常的）。
     */
    async function runSelfCheck() {
      publish({ selfCheck: { phase: 'running', detail: '' } })
      const frames = Math.round(16000 * 0.5)
      const wave = encodeWave(new Float32Array(frames))
      clog('selfcheck.sent', `bytes=${wave.byteLength}`)
      try {
        const response = await postWave(wave, { test: 1, dur: 500, peak: 0 }, POST_TIMEOUT_MS)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const result = await response.json()
        if (result?.code !== 'test-ok') throw new Error(String(result?.error ?? result?.code ?? 'failed'))
        applyServerState(result)
        publish({ selfCheck: { phase: 'ok', detail: '' } })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        clog('test.failed', `selfcheck ${detail}`)
        publish({ selfCheck: { phase: 'error', detail } })
      }
    }

    // ------------------------------------------------------- 切到专用会话

    let mainContext = null
    /** 主窗口当前打开的会话 id；空串表示没取到（发语音时就不带，走默认语音会话）。 */
    let activeSessionId = ''
    let lastJumpKey = ''

    /**
     * 让主窗口显示指定会话。只切换显示：不抢焦点、不弹窗口。
     * @param {string} sessionId 会话 id
     * @returns {boolean} 是否切成功
     */
    function switchTo(sessionId) {
      if (sessionId === '' || mainContext === null) return false
      let workspace
      try {
        workspace = mainContext.get('uiWorkspace')
      } catch {
        workspace = undefined
      }
      if (workspace === undefined || workspace === null || typeof workspace.openSession !== 'function') {
        clog('jump.retry', 'uiWorkspace.openSession 不可用')
        return false
      }
      try {
        workspace.openSession(sessionId)
        lastJumpKey = `${sessionId}`
        return true
      } catch {
        // 会话可能还没出现在列表里，等轮询再试一次。
        return false
      }
    }

    /** 轮询 Host 上的「切会话」目标并消费它，同时刷新状态文字。 */
    /**
     * 读「主窗口当前打开的会话」id。
     * 客户端宿主把当前视图挂在 `uiSession` 服务上（`current` 是一个 store），
     * 取法对几种可能的形状都试一下；取不到就返回空串（退回默认语音会话）。
     * @returns {string} 会话 id；空串表示不知道
     */
    function readActiveSessionId() {
      try {
        const ctx = mainContext
        if (ctx === null || typeof ctx.get !== 'function') return ''
        const svc = ctx.get('uiSession')
        if (svc === null || svc === undefined) return ''
        const source = svc.current
        const snapshot = typeof source?.getSnapshot === 'function' ? source.getSnapshot() : source
        const id = snapshot?.value?.key ?? snapshot?.key ?? snapshot?.value?.sessionId ?? snapshot?.sessionId
        return typeof id === 'string' ? id : ''
      } catch {
        return ''
      }
    }

    function startPoller() {
      let stopped = false
      let timer = 0
      const tick = async () => {
        if (stopped) return
        // 跟随当前窗口：每次轮询都刷新一次「主视图会话 id」，发语音时带上。
        const nextActive = readActiveSessionId()
        if (nextActive !== activeSessionId) {
          activeSessionId = nextActive
          clog('diag.service', `uiSession.current=${nextActive === '' ? '(unknown)' : nextActive}`)
        }
        try {
          const target = await requestJson('/jump')
          const sessionId = typeof target?.sessionId === 'string' ? target.sessionId : ''
          if (sessionId !== '') {
            const key = `${sessionId}:${typeof target.at === 'number' ? target.at : 0}`
            if (key !== lastJumpKey && switchTo(sessionId)) lastJumpKey = key
            if (key === lastJumpKey) await postJson('/jump', { sessionId }).catch(() => undefined)
          } else {
            lastJumpKey = ''
          }
          const payload = await requestJson('/state')
          applyServerState(payload)
        } catch {
          // Host 还没挂上或正在重启，下一轮继续。
        }
        timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS)
      }
      void tick()
      return () => {
        stopped = true
        window.clearTimeout(timer)
      }
    }

    // ------------------------------------------------------ 开关（共用）

    /**
     * 打开 / 关闭常听。设置页的开关和 HUD 卡片上的「静音」都走这里，
     * 保证两个入口的行为完全一致（改配置、起停引擎、刷新状态都在一处）。
     * @param {boolean} next 目标开关状态
     * @returns {Promise<void>} 失败时抛出，由调用方决定怎么显示错误
     */
    async function setVoiceEnabled(next) {
      applyServerState(await postJson('/config', { enabled: next }))
      if (next) {
        try {
          await startEngine(status.deviceId)
        } catch {
          // startEngine 内部已经写了 mic.denied / mic.error 日志；
          // 不自动把开关关掉：用户能看到错误，修好权限/设备后重新开关即可。
          stopEngine()
        }
      } else {
        stopEngine()
        // 关掉常听之后把预览接上，音量条还能继续用来说「设备是好的」。
        void startMonitor()
      }
      applyServerState(await requestJson('/state'))
    }

    // ------------------------------------------------------------ HUD 卡片

    /** HUD 组件在 Host 侧的地址（Host 用 GET /.dsh-voice-wake/hud.js 原样发出来）。 */
    const HUD_MODULE_PATH = '/hud.js'
    /** 挂载点 id：整页只需要一个。 */
    const HUD_MOUNT_ID = 'dsh-voice-wake-hud-mount'
    /** hud.js 记住的「位置 / 折叠」状态（键名与 hud.js 的 STORAGE_PREFIX 一致）。 */
    const HUD_STORAGE_KEYS = ['dsh-voice-wake.hud.position', 'dsh-voice-wake.hud.collapsed']

    /** HUD 模块只加载一次（版本不变就一直复用）。 */
    let hudModulePromise = null
    /** 当前 HUD 实例；null 表示没建或已销毁。 */
    let hudInstance = null
    /** HUD 挂载容器；destroyHud() 会把它一起摘掉。 */
    let hudMount = null
    /** 已经生效的 z-index；配置 hudZIndex 变了就必须重建卡片。 */
    let hudZIndexApplied = null
    /** 正在加载中，避免并发重复 import。 */
    let hudLoading = false
    /** 加载失败过就暂停自动重试，等用户再点开关 / 「归位」。 */
    let hudSuspended = false

    /**
     * 注入给 HUD 的文案。hud.js 自己不写死任何中文，
     * 以后要做英文界面，只需要在这里换成另一份字典。
     * @returns {object} HUD 的 strings 表
     */
    function hudStrings() {
      return {
        label: zh.hudLabel,
        stateOff: zh.hudStateOff,
        stateListening: zh.hudStateListening,
        stateConversing: zh.hudStateConversing,
        mute: zh.hudMute,
        unmute: zh.hudUnmute,
        collapse: zh.hudCollapse,
        expand: zh.hudExpand,
        close: zh.hudClose,
      }
    }

    /**
     * 动态加载 hud.js。
     *
     * 为什么用 import() 而不是静态 import：client.js 是被宿主当普通脚本执行的，
     * 没有「自己所在的模块地址」；Host 提供同源绝对地址，浏览器里才能 import()。
     * 同一个 hud.js 也可以被独立置顶窗口直接 import（它是纯 ESM）。
     * @returns {Promise<object>} 模块对象（含 createHud）
     */
    async function loadHudModule() {
      if (hudModulePromise === null) {
        const url = `${PREFIX}${HUD_MODULE_PATH}?v=${encodeURIComponent(status.version)}`
        hudModulePromise = import(url).catch((error) => {
          // 失败不缓存：下次「归位」还能再试一次。
          hudModulePromise = null
          throw error
        })
      }
      return await hudModulePromise
    }

    /**
     * 建 HUD 挂载点（整个页面只建一次）。
     * @returns {HTMLElement} 挂载容器
     */
    function ensureHudMount() {
      if (hudMount !== null && hudMount.isConnected !== false) return hudMount
      const existing = document.getElementById(HUD_MOUNT_ID)
      hudMount = existing === null ? document.createElement('div') : existing
      hudMount.id = HUD_MOUNT_ID
      if (existing === null) document.body.append(hudMount)
      return hudMount
    }

    /** 销毁 HUD 实例与挂载点；可以重复调用。 */
    function destroyHud() {
      if (hudInstance !== null) {
        try {
          hudInstance.destroy()
        } catch {
          // 组件销毁失败不应该影响关开关。
        }
        hudInstance = null
      }
      if (hudMount !== null) {
        try {
          hudMount.remove()
        } catch {
          // 已经不在文档里也无所谓。
        }
        hudMount = null
      }
      hudZIndexApplied = null
    }

    /**
     * HUD 显示哪一种状态：关（灰）/ 聆听中 / 已唤醒。
     * 识别、投递都发生在「已唤醒」这一段时间里，不再单独显示「处理中」。
     * @param {object} state 浏览器半的共享状态
     * @returns {'off'|'listening'|'conversing'} HUD 状态
     */
    function hudStateOf(state) {
      if (state.enabled !== true) return 'off'
      // 唤醒命中后一直显示「已唤醒」，直到这句完整说完、发出去（flushSegment 结束）才回「聆听中」。
      if (audio.awake === true) return 'conversing'
      return state.mode === 'conversing' ? 'conversing' : 'listening'
    }

    /**
     * 把浏览器半的状态压成 HUD 需要的快照（音量 0–100 换算成 0–1）。
     * @returns {{state: string, level: number, deviceName: string}} 快照
     */
    function hudSnapshot() {
      return {
        state: hudStateOf(status),
        level: Math.min(1, Math.max(0, status.level / 100)),
        deviceName: status.deviceLabel,
      }
    }

    /**
     * 按配置让 HUD 出现 / 消失，并把最新状态推给它。幂等，每次状态变化都可以调。
     * @param {{force?: boolean}} [options] force=true 时忽略「上次加载失败」的暂停状态
     * @returns {Promise<void>}
     */
    async function syncHud(options) {
      const force = options?.force === true
      if (status.hudEnabled !== true) {
        if (hudInstance !== null || hudMount !== null) {
          destroyHud()
          clog('hud.closed', 'config')
        }
        hudSuspended = false
        return
      }
      if (hudInstance !== null) {
        if (hudZIndexApplied === status.hudZIndex) {
          hudInstance.update(hudSnapshot())
          return
        }
        // 层级改了：卡片在 Shadow DOM 里，外面够不到它的样式，只能重建。
        destroyHud()
      }
      if (hudSuspended && !force) return
      if (hudLoading) return
      hudLoading = true
      try {
        const module = await loadHudModule()
        // 等模块的这段时间里用户可能又关掉了开关。
        if (status.hudEnabled !== true || hudInstance !== null) return
        if (typeof module?.createHud !== 'function') throw new Error('hud.js 未导出 createHud')
        hudInstance = module.createHud({
          mount: ensureHudMount(),
          strings: hudStrings(),
          options: {
            zIndex: status.hudZIndex,
            opacity: status.hudOpacity,
            // 配置里的位置/折叠只是初值：localStorage 有记录时以记录为准。
            initialPosition: status.hudPosition,
            initialCollapsed: status.hudCollapsed,
          },
          onRequestMute: () => void toggleVoiceFromHud(),
          onRequestClose: () => void setHudEnabled(false),
        })
        hudInstance.update(hudSnapshot())
        hudZIndexApplied = status.hudZIndex
        hudSuspended = false
        if (status.hudError !== '') publish({ hudError: '' })
        clog('hud.mounted', `version=${status.version} opacity=${status.hudOpacity}`)
      } catch (error) {
        hudSuspended = true
        const detail = error instanceof Error ? error.message : String(error)
        publish({ hudError: `${zh.hudErrorPrefix}${detail}` })
        clog('hud.load-failed', detail)
      } finally {
        hudLoading = false
      }
    }

    /** HUD 单击音量区：正在听就静音，已静音就恢复。 */
    async function toggleVoiceFromHud() {
      const next = status.enabled !== true
      try {
        await setVoiceEnabled(next)
        clog('hud.mute', next ? 'unmuted' : 'muted')
      } catch (error) {
        publish({ localError: `${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}` })
      }
    }

    /**
     * 显示 / 隐藏 HUD，并把开关写进配置（Host 是唯一真相，刷新后仍然记得）。
     * @param {boolean} next 目标开关
     * @returns {Promise<void>}
     */
    async function setHudEnabled(next) {
      try {
        // 用户主动要求显示时，允许重新尝试加载之前失败的模块。
        if (next) hudSuspended = false
        applyServerState(await postJson('/config', { hudEnabled: next }))
        if (!next) clog('hud.closed', 'user')
      } catch (error) {
        publish({ hudError: `${zh.hudErrorPrefix}${error instanceof Error ? error.message : String(error)}` })
      }
    }

    // ------------------------------------------------------------ 设置页

    /** 列出真实输入设备。没有权限时标签是空的，用序号兜底。 */
    async function listInputs() {
      if (navigator.mediaDevices === undefined || typeof navigator.mediaDevices.enumerateDevices !== 'function') return []
      let devices = []
      try {
        devices = await navigator.mediaDevices.enumerateDevices()
      } catch {
        return []
      }
      return devices
        .filter((device) => device.kind === 'audioinput')
        .filter((device) => !/stereo mix|立体声混音|loopback|monitor of/i.test(device.label ?? ''))
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: typeof device.label === 'string' && device.label !== '' ? device.label : zh.deviceUnnamed.replaceAll('{n}', String(index + 1)),
        }))
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: `dw-switch${props.checked ? ' is-on' : ''}`,
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked),
      })
    }

    function errorText(state) {
      const code = state.lastCode
      if (typeof code === 'string' && code !== '' && zh.errorCodes[code] !== undefined) {
        return `${zh.errorCodes[code]}${state.lastError === '' ? '' : ` ${state.lastError}`}`
      }
      if (state.lastError !== '') return `${zh.transcribeError}${state.lastError}`
      return ''
    }

    function permissionText(permission) {
      if (permission === 'granted') return zh.permissionGranted
      if (permission === 'denied') return zh.permissionDenied
      if (permission === 'prompt') return zh.permissionPrompt
      return zh.permissionUnknown
    }

    function micStateText(state) {
      const key = `micState${state.charAt(0).toUpperCase()}${state.slice(1)}`
      return zh[key] ?? state
    }

    /** 把测试结果翻译成「下一步该怎么办」。 */
    function testHint(test) {
      if (test.phase === 'error') {
        if (/NotAllowed|Permission|权限/i.test(test.error)) {
          return zh.hintSilent.replaceAll('{peak}', test.peak.toFixed(4))
        }
        return zh.hintError.replaceAll('{detail}', test.error === '' ? '（未知）' : test.error)
      }
      if (test.phase !== 'done') return ''
      if (status.modelsReady === false) return zh.hintModels
      if (test.peak < 0.004) return zh.hintSilent.replaceAll('{peak}', test.peak.toFixed(4))
      if (test.text === '') return zh.hintNoText.replaceAll('{peak}', test.peak.toFixed(4))
      return zh.hintOk
    }

    /** 诊断信息（纯文本，可直接贴）。 */
    function diagnosticsText() {
      const state = status
      const lines = [
        `插件: 语音唤醒 dsh-voice-wake ${state.version}`,
        `时间: ${new Date().toISOString()}`,
        `enabled: ${state.enabled}`,
        `deviceId: ${state.deviceId === '' ? '(系统默认)' : state.deviceId}${state.deviceLabel === '' ? '' : ` / ${state.deviceLabel}`}`,
        `采样率: ${state.sampleRate === 0 ? '(未打开)' : `${state.sampleRate} Hz`}`,
        `状态机: ${state.mode}（麦克风: ${state.micState}）`,
        `唤醒词: ${state.wakeWords === '' ? '(未设置)' : state.wakeWords}`,
        `工作方式: 单次指令（唤醒词 + 内容，发完回监听）`,
        `段首要求: ${state.wakeAtStart ? '开' : '关'}`,
        `灵敏度: 第 ${state.wakeSensitivity} 档 / 10`,
        `静音切段: ${state.silenceMs} 毫秒`,
        `权限: ${state.permission}`,
        `最后音量峰值: ${state.peak}`,
        `最后一段音频: ${state.lastUtteranceAt === 0 ? '(还没收到过)' : `${new Date(state.lastUtteranceAt).toISOString()} / ${state.lastUtteranceSource} / ${state.lastBytes} 字节`}`,
        `最后识别文本: ${state.lastAsrText === '' ? '(空)' : state.lastAsrText}`,
        `最后唤醒匹配: ${state.lastWake === '' ? '(还没跑过)' : state.lastWake}`,
        `最后错误: ${state.lastError === '' ? (state.localError === '' ? '(无)' : state.localError) : state.lastError}`,
        `Host 模型: ${state.modelsReady ? '就绪' : '缺失'}`,
      ]
      return lines.join('\n')
    }

    /** 复制文本：优先剪贴板 API，失败退回隐藏 textarea。 */
    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 没有权限就退回去。
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.append(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    function SettingsSection() {
      const [snapshot, setSnapshot] = React.useState({ ...status })
      const [devices, setDevices] = React.useState([])
      const [wakeDraft, setWakeDraft] = React.useState('')
      const [wakeAtStartDraft, setWakeAtStartDraft] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [loadError, setLoadError] = React.useState('')
      const [copied, setCopied] = React.useState('')

      React.useEffect(() => {
        const listener = (next) => setSnapshot(next)
        listeners.add(listener)
        let alive = true
        void (async () => {
          try {
            const payload = await requestJson('/config')
            if (!alive) return
            applyServerState(payload)
            setWakeDraft(typeof payload?.config?.wakeWords === 'string' ? payload.config.wakeWords : '')
            setWakeAtStartDraft(payload?.config?.wakeAtStart !== false)
            setLoadError('')
          } catch (error) {
            if (alive) setLoadError(error instanceof Error ? error.message : String(error))
          }
          const inputs = await listInputs()
          if (alive) setDevices(inputs)
        })()
        // 进这个区块就顺手把预览打开，音量条才有数字；离开时关掉。
        void refreshPermission()
        void startMonitor()
        return () => {
          alive = false
          listeners.delete(listener)
          stopMonitor()
        }
      }, [])

      const save = async (patch, message) => {
        setBusy(true)
        setNotice('')
        try {
          const payload = await postJson('/config', patch)
          applyServerState(payload)
          if (typeof payload?.config?.wakeWords === 'string') setWakeDraft(payload.config.wakeWords)
          if (typeof payload?.config?.wakeAtStart === 'boolean') setWakeAtStartDraft(payload.config.wakeAtStart)
          if (message !== undefined) setNotice(message)
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      /**
       * 自动保存：唤醒词 / 段首要求都是「改完就该生效」的，
       * 不再让用户点保存。停止输入 600ms 后提交一次，避免每敲一个字发一次请求。
       */
      const autoPayload = () => ({
        wakeWords: wakeDraft,
        wakeAtStart: wakeAtStartDraft,
      })

      const autoTimer = React.useRef(null)
      const draftsDirty =
        wakeDraft !== (snapshot.wakeWords ?? '') ||
        wakeAtStartDraft !== (snapshot.wakeAtStart !== false)

      React.useEffect(() => {
        if (!draftsDirty) return undefined
        if (autoTimer.current !== null) clearTimeout(autoTimer.current)
        autoTimer.current = setTimeout(() => {
          autoTimer.current = null
          // 静默保存：成功不打扰，失败才由 save() 把错误写进顶部提示。
          void save(autoPayload())
        }, 600)
        return () => {
          if (autoTimer.current !== null) clearTimeout(autoTimer.current)
          autoTimer.current = null
        }
      }, [wakeDraft, wakeAtStartDraft, draftsDirty])

      /**
       * 灵敏度档位：先本地生效（采集循环下一块就按新档算），再串行落盘。
       * Host 会写一行 calibrate/threshold 日志；/state 轮询也会把值同步回来。
       */
      const changeSensitivity = async (value) => {
        const next = clampSensitivity(value)
        if (next === tuning.wakeSensitivity) return
        tuning.wakeSensitivity = next
        publish({ wakeSensitivity: next })
        const { seq, run } = queueTuningPatch({ wakeSensitivity: next })
        try {
          const payload = await run
          if (seq === tuningSaveSeq) applyServerState(payload)
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      /**
       * 「校准」：录 3 秒环境声，按底噪推荐一档并立即保存。
       * 录音期间暂停常听 VAD（audio.testing），这 3 秒不会被当成一句话。
       */
      const calibrateSensitivity = async () => {
        if (busy) return
        setBusy(true)
        setNotice(zh.calibrating)
        try {
          let clip
          audio.testing = true
          resetVad()
          try {
            clip = await recordClip(TEST_MS)
          } finally {
            audio.testing = false
            resetVad()
          }
          if (clip.blocks.length === 0) {
            setNotice(zh.calibrateEmpty)
            return
          }
          // 底噪取能量最低的 20% 分位，与「测试识别」里的估算方式一致。
          const levels = clip.blocks.map((block) => rmsOf(block)).sort((a, b) => a - b)
          const floor = levels[Math.floor(levels.length * 0.2)]
          const level = levelForFloor(floor)
          applyServerState(await postJson('/config', { wakeSensitivity: level }))
          setNotice(zh.calibrated.replaceAll('{level}', String(level)).replaceAll('{floor}', floor.toFixed(4)))
          clog('calibrate.done', `floor=${floor.toFixed(4)} level=${level}`)
        } catch (error) {
          setNotice(`${zh.calibrateFail}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      /** 最短语音下拉已移除：每句话都带唤醒词，短噪声过不了唤醒匹配。 */

      /** 说完后静音下拉：先本地生效、再落盘。下一次切段就按新值算。 */
      const changeSilence = async (value) => {
        const next = clampSilenceMs(value)
        if (next === tuning.silenceMs) return
        tuning.silenceMs = next
        publish({ silenceMs: next })
        const { seq, run } = queueTuningPatch({ silenceMs: next })
        try {
          const payload = await run
          if (seq === tuningSaveSeq) applyServerState(payload)
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      /**
       * 单句最长下拉：先本地生效（下一次切段就按新值算），再串行落盘。
       * 0 表示不设上限。
       */
      const changeMaxSegment = async (value) => {
        const next = clampMaxSegment(value)
        if (next === tuning.maxSegmentMs) return
        tuning.maxSegmentMs = next
        publish({ maxSegmentMs: next })
        const { seq, run } = queueTuningPatch({ maxSegmentMs: next })
        try {
          const payload = await run
          if (seq === tuningSaveSeq) applyServerState(payload)
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      /** 提示音音量：本地立即生效（下一声就按新音量），再落盘。 */
      const changeChime = async (value) => {
        const next = Math.max(0, Math.min(100, Math.round(Number(value))))
        if (!Number.isFinite(next) || next === status.chimeVolume) return
        publish({ chimeVolume: next })
        try {
          const payload = await postJson('/config', { chimeVolume: next })
          applyServerState(payload)
          playWakeChime()
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const toggleEnabled = async (next) => {
        setBusy(true)
        setNotice('')
        try {
          await setVoiceEnabled(next)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const selectDevice = async (deviceId) => {
        const wasRunning = audio.running
        if (wasRunning) stopEngine()
        await save({ deviceId })
        if (wasRunning || status.enabled) {
          try {
            await startEngine(deviceId)
          } catch {
            stopEngine()
          }
        }
        const inputs = await listInputs()
        setDevices(inputs)
      }

      /** 快速唤醒探测开关：只写配置，采集循环下一块就按新值走。 */
      const toggleProbe = async (next) => {
        publish({ probeEnabled: next })
        try {
          applyServerState(await postJson('/config', { probeEnabled: next }))
        } catch (error) {
          publish({ probeEnabled: !next })
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      /** 发到当前会话开关：只写配置，Host 下次投递就按新值走。 */
      const toggleFollow = async (next) => {
        publish({ followActive: next })
        try {
          applyServerState(await postJson('/config', { followActive: next }))
        } catch (error) {
          publish({ followActive: !next })
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      /** HUD 开关：只写配置，真正的创建/销毁交给统一的 syncHud()。 */
      const toggleHud = async (next) => {
        setBusy(true)
        setNotice('')
        try {
          applyServerState(await postJson('/config', { hudEnabled: next }))
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      /**
       * 「归位」：把悬浮卡片放回默认位置，并压到同层级浮层的最上面。
       *
       * 做法：打开开关 + 把记住的位置/折叠状态复原 + 重建卡片。
       * 重建会先把挂载点从 body 上摘掉再重新 append，所以同 z-index 的浮层里
       * 它是后插入的那个，会盖在别人上面（别的插件把自己叠上来也不会盖住它）。
       */
      const resetHudPlacement = async () => {
        setBusy(true)
        setNotice('')
        try {
          // 位置/折叠的「初值」也在配置里，一并恢复默认，避免下次启动又被旧值带走。
          applyServerState(await postJson('/config', { hudEnabled: true, hudPosition: null, hudCollapsed: false }))
          for (const key of HUD_STORAGE_KEYS) {
            try {
              window.localStorage.removeItem(key)
            } catch {
              // 隐私模式/沙箱里可能不给用；清不掉就沿用旧位置，不影响显示。
            }
          }
          destroyHud()
          await syncHud({ force: true })
          clog('hud.reset', 'placement reset')
        } catch (error) {
          setNotice(`${zh.saveErrorPrefix}${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const copyDiagnostics = async () => {
        setCopied('')
        clog('ui.copy', 'diagnostics')
        let tail = ''
        try {
          const response = await request(`/log?limit=${DIAG_LOG_LIMIT}`, undefined, 8000)
          if (response.ok) tail = await response.text()
        } catch {
          // 日志拉不到也无所谓，关键字段还是能贴。
        }
        const text = `${diagnosticsText()}\n\n最近日志:\n${tail.trim() === '' ? '(空)' : tail.trim()}`
        const ok = await copyText(text)
        setCopied(ok ? zh.diagCopied : zh.diagCopyFailed)
      }

      const exportDiagnostics = async () => {
        try {
          const response = await request('/diagnostics', undefined, 15000)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const text = await response.text()
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'dsh-voice-wake-diagnostics.txt'
          document.body.append(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 10000)
        } catch (error) {
          setCopied(`${zh.transcribeError}${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const enabled = snapshot.enabled === true
      const error = errorText(snapshot) || snapshot.localError
      const test = snapshot.test
      const hint = testHint(test)
      const active = activeCapture()
      // 触发阈值画在音量条上，用户能直接看到「说话音量有没有高过线」。
      const thresholdLevel = Math.max(0, Math.min(100, rmsToLevel(effectiveThreshold())))
      const selfCheck = snapshot.selfCheck
      const testPhaseText =
        test.phase === 'recording' ? zh.micTesting : test.phase === 'sending' ? zh.micSending : zh.micTestRun

      /** 一行设置：左边标题（可选一句说明），右边控件。 */
      const item = (key, title, hintText, control) =>
        h(
          'div',
          { className: 'dw-item', key },
          h(
            'div',
            { className: 'dw-col' },
            h('span', { className: 'dw-label' }, title),
            hintText === undefined ? null : h('span', { className: 'dw-muted' }, hintText),
          ),
          control,
        )

      /** 一行开关：标题 + 说明 + 右侧 Switch。 */
      const switchItem = (key, title, hintText, checked, onChange) =>
        item(key, title, hintText, h(Switch, { checked, disabled: busy, label: title, onChange }))

      /** 一行数值下拉：values 是候选档位，labelOf 负责把值变成文案。 */
      const selectItem = (key, title, hintText, values, current, labelOf, onChange) =>
        item(
          key,
          title,
          hintText,
          h(
            'select',
            {
              className: 'dw-select',
              value: String(current),
              onChange: (event) => onChange(Number(event.target.value)),
            },
            ...values.map((value) => h('option', { key: String(value), value: String(value) }, labelOf(value))),
            // 手改 config.json 填了非标准值时，也要能显示出来，别让下拉空着。
            values.includes(current) ? null : h('option', { key: 'current', value: String(current) }, labelOf(current)),
          ),
        )

      /** 一行滑杆：标题行带当前值（可附带一个动作按钮），可选两端标签与一句说明。 */
      const rangeItem = (key, title, valueText, hintText, range, labels, action) =>
        h(
          'div',
          { className: 'dw-item dw-item-col', key },
          h(
            'div',
            { className: 'dw-row' },
            h('span', { className: 'dw-label' }, title),
            action === undefined
              ? h('span', { className: 'dw-value' }, valueText)
              : h('div', { className: 'dw-row dw-tight' }, h('span', { className: 'dw-value' }, valueText), action),
          ),
          h('input', {
            className: 'dw-range',
            type: 'range',
            min: range.min,
            max: range.max,
            step: range.step,
            value: range.value,
            'aria-label': title,
            'aria-valuetext': valueText,
            onChange: (event) => range.onChange(Number(event.target.value)),
          }),
          labels === undefined
            ? null
            : h(
                'div',
                { className: 'dw-row' },
                h('span', { className: 'dw-muted' }, labels[0]),
                h('span', { className: 'dw-muted' }, labels[1]),
              ),
          hintText === undefined ? null : h('span', { className: 'dw-muted' }, hintText),
        )

      // ---------------- 设置项（单页平铺，不再分三层菜单）
      const commonItems = [
        switchItem('enable', zh.enable, undefined, enabled, (value) => void toggleEnabled(value)),
        item(
          'device',
          zh.deviceTitle,
          zh.deviceHint,
          h(
            'div',
            { className: 'dw-row dw-tight' },
            h(
              'select',
              {
                className: 'dw-select',
                value: snapshot.deviceId ?? '',
                disabled: busy,
                onChange: (event) => void selectDevice(event.target.value),
              },
              h('option', { value: '' }, zh.deviceDefault),
              ...devices.map((device) => h('option', { key: device.deviceId, value: device.deviceId }, device.label)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dw-button dw-ghost',
                disabled: busy,
                onClick: async () => setDevices(await listInputs()),
              },
              zh.deviceRefresh,
            ),
          ),
        ),
        item(
          'wake',
          zh.wakeLabel,
          zh.wordsHint,
          h('input', {
            className: 'dw-input',
            type: 'text',
            value: wakeDraft,
            placeholder: zh.wakePlaceholder,
            onChange: (event) => setWakeDraft(event.target.value),
          }),
        ),
        rangeItem(
          'vad',
          zh.vadLevel,
          zh.vadValue.replaceAll('{value}', String(snapshot.wakeSensitivity)),
          zh.vadHint,
          {
            min: SENSITIVITY_MIN,
            max: SENSITIVITY_MAX,
            step: 1,
            value: snapshot.wakeSensitivity,
            onChange: (value) => void changeSensitivity(value),
          },
          [zh.vadMoreSensitive, zh.vadLessSensitive],
          h(
            'button',
            {
              type: 'button',
              className: 'dw-button dw-ghost',
              disabled: busy,
              onClick: () => void calibrateSensitivity(),
            },
            zh.calibrate,
          ),
        ),
        selectItem(
          'silence',
          zh.silenceLabel,
          zh.silenceHint,
          SILENCE_OPTIONS,
          snapshot.silenceMs,
          (ms) => zh.silenceOption.replaceAll('{n}', String(ms)),
          (value) => void changeSilence(value),
        ),
        selectItem(
          'maxSegment',
          zh.maxSegLabel,
          zh.maxSegHint,
          MAX_SEGMENT_OPTIONS,
          snapshot.maxSegmentMs,
          maxSegmentLabel,
          (value) => void changeMaxSegment(value),
        ),
        rangeItem(
          'chime',
          zh.chimeLabel,
          zh.chimeValue.replaceAll('{n}', String(snapshot.chimeVolume)),
          zh.chimeHint,
          {
            min: 0,
            max: 100,
            step: 5,
            value: snapshot.chimeVolume,
            onChange: (value) => void changeChime(value),
          },
          undefined,
        ),
        item(
          'hud',
          zh.hudTitle,
          zh.hudHint,
          h(
            'div',
            { className: 'dw-row dw-tight' },
            h(
              'button',
              {
                type: 'button',
                className: 'dw-button dw-ghost',
                disabled: busy,
                title: '放回右下角默认位置，并放到最上层',
                onClick: () => void resetHudPlacement(),
              },
              zh.hudReopen,
            ),
            h(Switch, {
              checked: snapshot.hudEnabled === true,
              disabled: busy,
              label: zh.hudTitle,
              onChange: (value) => void toggleHud(value),
            }),
          ),
        ),
        snapshot.hudError === '' ? null : h('p', { className: 'dw-error', role: 'alert' }, snapshot.hudError),
      ]

      // ---------------- 更多设置（平铺）
      const advancedItems = [
        switchItem('wakeAtStart', zh.wakeAtStartTitle, zh.wakeAtStartHint, wakeAtStartDraft, (value) => setWakeAtStartDraft(value)),
        switchItem('probe', zh.probeTitle, zh.probeHint, snapshot.probeEnabled !== false, (value) => void toggleProbe(value)),
        switchItem('follow', zh.followTitle, zh.followHint, snapshot.followActive !== false, (value) => void toggleFollow(value)),
        h('p', { className: 'dw-muted' }, zh.advancedNote),
      ]

      // ---------------- 诊断（平铺）
      const diagItems = [
          h('h3', { className: 'dw-sub' }, zh.micTestTitle),
          h('span', { className: 'dw-muted' }, zh.micTestHint),
          h(
            'div',
            { className: 'dw-meter-row' },
            h(
              'div',
              { className: 'dw-meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': snapshot.level },
              h('div', { className: 'dw-meter-fill', style: { width: `${Math.max(0, Math.min(100, snapshot.level))}%` } }),
              h('span', {
                className: 'dw-meter-mark',
                style: { left: `${thresholdLevel}%` },
                title: `${zh.vadLevel} ${effectiveThreshold().toFixed(4)}`,
              }),
            ),
            h('span', { className: 'dw-meter-value' }, String(snapshot.level)),
          ),
          h(
            'div',
            { className: 'dw-row dw-row-start' },
            enabled
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dw-button dw-ghost',
                    onClick: () => (activeCapture() === null ? void startMonitor() : stopMonitor()),
                  },
                  activeCapture() === null ? zh.micPreviewOn : zh.micPreviewOff,
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'dw-button dw-primary',
                disabled: test.phase === 'recording' || test.phase === 'sending',
                onClick: () => void runMicTest(),
              },
              testPhaseText,
            ),
          ),
          h(
            'div',
            { className: 'dw-test' },
            h('h4', null, zh.micResultTitle),
            h(
              'p',
              { className: 'dw-test-text' },
              test.phase === 'done' ? (test.text === '' ? zh.micResultEmpty : test.text) : zh.micNoResult,
            ),
            test.phase === 'done'
              ? h(
                  'p',
                  { className: 'dw-muted' },
                  `${zh.micPeak} ${test.peak.toFixed(4)} · 底噪 ${Number(test.floor ?? 0).toFixed(4)} · ${Math.round(test.durationMs)} ms · ${test.ms} ms`,
                )
              : null,
            hint === '' ? null : h('p', { className: test.phase === 'done' && test.text !== '' ? 'dw-hint is-ok' : 'dw-hint' }, hint),
          ),
          h(
            'dl',
            { className: 'dw-kv' },
            h('dt', null, zh.micDevice),
            h('dd', null, active === null ? zh.diagNone : active.deviceLabel === '' ? zh.deviceDefault : active.deviceLabel),
            h('dt', null, zh.micRate),
            h('dd', null, active === null ? zh.diagNone : `${active.sampleRate} Hz`),
            h('dt', null, zh.micPermission),
            h('dd', null, `${permissionText(snapshot.permission)}（${micStateText(snapshot.micState)}）`),
          ),
          h('h3', { className: 'dw-sub' }, zh.diagInfoTitle),
          h(
            'dl',
            { className: 'dw-kv' },
            h('dt', null, zh.diagVersion),
            h('dd', null, snapshot.version),
            h('dt', null, zh.diagEnabled),
            h('dd', null, String(enabled)),
            h('dt', null, zh.diagDevice),
            h('dd', null, snapshot.deviceId === '' ? zh.deviceDefault : snapshot.deviceId),
            h('dt', null, zh.diagRate),
            h('dd', null, snapshot.sampleRate === 0 ? zh.diagNone : `${snapshot.sampleRate} Hz`),
            h('dt', null, zh.diagMode),
            h('dd', null, `${snapshot.mode} / ${snapshot.micState}`),
            h('dt', null, zh.vadLevel),
            h(
              'dd',
              null,
              `${snapshot.wakeSensitivity}/10 / ${zh.silenceShort} ${snapshot.silenceMs}ms`,
            ),
            h('dt', null, zh.diagSession),
            h('dd', null, snapshot.sessionId === '' ? zh.diagNone : snapshot.sessionId),
            h('dt', null, zh.diagPeak),
            h('dd', null, String(snapshot.peak)),
            h('dt', null, zh.diagAsr),
            h('dd', null, snapshot.lastAsrText === '' ? zh.diagNone : snapshot.lastAsrText),
            h('dt', null, zh.diagWake),
            h('dd', null, snapshot.lastWake === '' ? zh.diagNotYet : snapshot.lastWake),
            h('dt', null, zh.diagAudio),
            h(
              'dd',
              null,
              snapshot.lastUtteranceAt === 0
                ? zh.diagNotYet
                : `${new Date(snapshot.lastUtteranceAt).toLocaleString()} / ${snapshot.lastUtteranceSource} / ${snapshot.lastBytes} B`,
            ),
            h('dt', null, zh.diagError),
            h('dd', null, snapshot.lastError === '' ? (snapshot.localError === '' ? zh.diagNone : snapshot.localError) : snapshot.lastError),
          ),
          h(
            'div',
            { className: 'dw-row dw-row-start' },
            h('button', { type: 'button', className: 'dw-button dw-primary', onClick: () => void copyDiagnostics() }, zh.diagCopy),
            h('button', { type: 'button', className: 'dw-button dw-ghost', onClick: () => void exportDiagnostics() }, zh.diagExport),
            h(
              'button',
              {
                type: 'button',
                className: 'dw-button dw-ghost',
                disabled: selfCheck.phase === 'running',
                onClick: () => void runSelfCheck(),
              },
              selfCheck.phase === 'running' ? zh.diagSelfChecking : zh.diagSelfCheck,
            ),
          ),
          copied === '' ? null : h('p', { className: 'dw-banner', role: 'status' }, copied),
          selfCheck.phase === 'ok'
            ? h('p', { className: 'dw-hint is-ok' }, zh.diagSelfCheckOk)
            : selfCheck.phase === 'error'
              ? h('p', { className: 'dw-hint' }, zh.diagSelfCheckFail.replaceAll('{detail}', selfCheck.detail))
              : null,
      ]

      return h(
        'div',
        { className: 'dw-set' },
        h('h2', { className: 'dw-title' }, zh.nav),
        h('p', { className: 'dw-intro' }, zh.intro),
        loadError === ''
          ? null
          : h(
              'div',
              { className: 'dw-warn' },
              h('p', null, `${zh.loadError}${loadError}`),
              h('button', { type: 'button', className: 'dw-button dw-ghost', onClick: () => window.location.reload() }, zh.retry),
            ),
        notice === '' ? null : h('p', { className: 'dw-banner', role: 'status' }, notice),
        error === '' ? null : h('p', { className: 'dw-error', role: 'alert' }, error),
        enabled && snapshot.micState === 'stalled'
          ? h('div', { className: 'dw-warn' }, h('p', null, zh.statusStalled))
          : null,
        enabled && !snapshot.modelsReady
          ? h(
              'div',
              { className: 'dw-warn' },
              h('h4', null, zh.modelsMissingTitle),
              h('p', null, zh.modelsMissingHint),
              ...(snapshot.problems ?? []).map((entry, index) => h('p', { className: 'dw-muted', key: `p${index}` }, entry)),
            )
          : null,
        h(
          'section',
          { className: 'dw-card', key: 'settings' },
          ...commonItems,
          ...advancedItems,
          ...diagItems,
        ),
      )
    }

    // ------------------------------------------------------------ 样式

    const style = `
.dw-set { display: flex; flex-direction: column; gap: 14px; max-width: 720px; color: inherit; }
.dw-title { margin: 0; font-size: 20px; }
.dw-intro { margin: 0; font-size: 13px; line-height: 1.5; color: color-mix(in srgb, currentColor 72%, transparent); }
.dw-card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.dw-card h3 { margin: 0; font-size: 14px; }
.dw-card h4 { margin: 0; font-size: 13px; }
.dw-muted { margin: 0; font-size: 13px; line-height: 1.45; color: color-mix(in srgb, currentColor 62%, transparent); overflow-wrap: anywhere; }
.dw-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dw-row-end { justify-content: flex-end; }
.dw-row-start { justify-content: flex-start; flex-wrap: wrap; }
.dw-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dw-label { font-size: 13.5px; font-weight: 600; }
.dw-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 0; border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.dw-card > .dw-item:first-child, .dw-fold-body > .dw-item:first-child { border-top: 0; }
.dw-item-col { flex-direction: column; align-items: stretch; gap: 6px; }
.dw-item .dw-input { flex: 0 1 320px; }
.dw-item .dw-select { flex: 0 1 240px; }
.dw-tight { gap: 10px; justify-content: flex-end; }
.dw-value { font-size: 12.5px; font-variant-numeric: tabular-nums; color: color-mix(in srgb, currentColor 72%, transparent); }
.dw-statusbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dw-fold { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; }
.dw-fold > summary { display: flex; align-items: center; gap: 8px; padding: 10px 16px; font-size: 13.5px; font-weight: 600; cursor: pointer; list-style: none; }
.dw-fold > summary::-webkit-details-marker { display: none; }
.dw-fold > summary::before { content: '▸'; font-size: 11px; color: color-mix(in srgb, currentColor 55%, transparent); }
.dw-fold[open] > summary::before { content: '▾'; }
.dw-fold-body { display: flex; flex-direction: column; gap: 8px; padding: 4px 16px 12px; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.dw-sub { margin: 6px 0 0; font-size: 13px; font-weight: 600; }
.dw-choice { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.dw-choice input { margin: 0; accent-color: var(--dsw-alias-button-info-fill, #2f6fed); }
.dw-choice strong { font-size: 13.5px; font-weight: 600; }
.dw-switch { width: 40px; height: 24px; border-radius: 999px; border: 0; background: color-mix(in srgb, currentColor 18%, transparent); position: relative; flex: none; cursor: pointer; padding: 0; }
.dw-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-static-neutral-bluish-00, #fff); transition: transform .16s ease; }
.dw-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.dw-switch.is-on::after { transform: translateX(16px); }
.dw-switch:disabled { opacity: .5; cursor: default; }
.dw-status { margin: 0; font-size: 15px; font-weight: 600; }
.dw-status.is-listening { color: var(--dsw-alias-state-success-primary, #12b76a); }
.dw-status.is-conversing { color: var(--dsw-alias-button-info-fill, #2f6fed); }
.dw-status.is-off { color: color-mix(in srgb, currentColor 55%, transparent); }
.dw-banner { margin: 0; font-size: 13px; color: color-mix(in srgb, currentColor 72%, transparent); }
.dw-warn { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc6803) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #dc6803) 8%, transparent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dw-error { margin: 0; font-size: 13px; color: var(--dsw-alias-state-error-primary, #d92d20); overflow-wrap: anywhere; }
.dw-input, .dw-select { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; min-width: 0; }
.dw-input { width: 100%; }
.dw-select { flex: 1; }
.dw-button { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.dw-button:disabled { opacity: .55; cursor: default; }
.dw-ghost { border-color: transparent; }
.dw-primary { background: var(--dsw-alias-button-info-fill, #2f6fed); color: var(--dsw-static-neutral-bluish-00, #fff); border-color: transparent; }
.dw-meter-row { display: flex; align-items: center; gap: 10px; }
.dw-meter { flex: 1; height: 10px; border-radius: 999px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; position: relative; }
.dw-meter-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #12b76a, #f5b301 70%, #d92d20); transition: width .08s linear; }
.dw-meter-mark { position: absolute; top: 0; bottom: 0; width: 2px; border-radius: 1px; background: color-mix(in srgb, var(--dsw-static-neutral-bluish-00, #fff) 82%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 45%, transparent); transform: translateX(-1px); pointer-events: none; }
.dw-meter-value { min-width: 28px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; color: color-mix(in srgb, currentColor 75%, transparent); }
.dw-range { flex: 1; width: 100%; margin: 0; accent-color: var(--dsw-alias-button-info-fill, #2f6fed); cursor: pointer; }
.dw-select-narrow { flex: none; min-width: 104px; }
.dw-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12.5px; }
.dw-kv dt { color: color-mix(in srgb, currentColor 58%, transparent); }
.dw-kv dd { margin: 0; overflow-wrap: anywhere; }
.dw-test { display: flex; flex-direction: column; gap: 4px; border: 1px dashed color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 10px 12px; }
.dw-test-text { margin: 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.dw-hint { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-state-warn-primary, #b54708); }
.dw-hint.is-ok { color: var(--dsw-alias-state-success-primary, #12b76a); }
`

    function mountStyle() {
      let node = document.getElementById('dsh-voice-wake-style')
      if (node === null) {
        node = document.createElement('style')
        node.id = 'dsh-voice-wake-style'
        document.head.append(node)
      }
      node.textContent = style
    }

    // ------------------------------------------------------------ 入口

    const inject = ['slots']

    /** 启动时按已保存的开关恢复常听（不需要用户再点一次）。 */
    async function boot() {
      try {
        const payload = await requestJson('/config')
        applyServerState(payload)
        const deviceId = typeof payload?.config?.deviceId === 'string' ? payload.config.deviceId : ''
        clog(
          'config.loaded',
          `enabled=${payload?.config?.enabled === true} device=${deviceId === '' ? 'default' : deviceId}` +
            ` models=${payload?.health?.modelsReady === false ? 'missing' : 'ready'}`,
        )
        if (payload?.config?.enabled === true) {
          try {
            await startEngine(deviceId)
          } catch {
            // openCapture 已经写过 mic.denied / mic.error；这里只保证界面显示错误。
            publish({ micState: 'error' })
          }
        }
      } catch (error) {
        clog('config.loaded', `failed ${error instanceof Error ? error.message : String(error)}`)
        // Host 半还没挂上；开关状态等下一轮轮询。
      }
      void refreshPermission()
    }

    function apply(ctx) {
      mainContext = ctx
      mountStyle()
      publish({ version: LOCAL_VERSION })
      clog('page.ready', `version=${LOCAL_VERSION} origin=${window.location.origin}`)
      // 一次性诊断：确认浏览器半能不能拿到「当前会话 id」（决定语音能否发到别的会话）。
      try {
        clog('diag.location', window.location.href)
        clog('diag.ctx', `keys=${Object.keys(ctx).join(',')}`)
        for (const name of ['sessions', 'session', 'chat', 'conversation', 'ui-session', 'sessionStore']) {
          const svc = typeof ctx.get === 'function' ? ctx.get(name) : undefined
          if (svc === undefined || svc === null) continue
          let keys = ''
          try {
            keys = Object.keys(svc).join(',')
          } catch {
            keys = '(no-keys)'
          }
          clog('diag.service', `${name}: ${keys}`)
        }
      } catch (error) {
        clog('diag.failed', error instanceof Error ? error.message : String(error))
      }
      startMeterLoop()
      // HUD：状态 / 音量 / 识别文本一变就推给卡片；开关变化时创建或销毁（幂等）。
      // 第一次真正建卡片发生在 boot() 读到配置之后，避免先闪一下再被关掉。
      const hudListener = () => {
        void syncHud()
      }
      listeners.add(hudListener)
      ctx.effect(
        () => () => {
          listeners.delete(hudListener)
          destroyHud()
        },
        'dsh-voice-wake: HUD',
      )
      ctx.effect(() => {
        const off = startPoller()
        return () => off()
      }, 'dsh-voice-wake: session jump + status')
      void boot()
      ctx.effect(
        () => () => {
          stopEngine()
          stopMonitor()
          stopMeterLoop()
        },
        'dsh-voice-wake: microphone',
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 26,
            label: () => zh.nav,
            inject: () => ({}),
          },
          SettingsSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
