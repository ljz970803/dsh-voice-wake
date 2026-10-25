/**
 * 语音唤醒（dsh-voice-wake）Host 半：常听链路里所有「非浏览器」的事都在这里。
 *
 * 分工：
 *  - 浏览器半（client.js）只做三件事：采麦克风、切段、把每段 16 kHz WAV 发过来；
 *  - 这里做：配置读写、本地 SenseVoice 识别（复用 DSH 内置 provider，模型与
 *    原生库都是本地文件，音频只在内存里走一遍）、唤醒词拼音匹配、专用会话的
 *    创建/复用与自动发送、以及给主窗口的「切到哪个会话」目标；
 *  - 另外把纯展示组件 hud.js 原样发给浏览器半（GET /hud.js），
 *    这样 client.js 不需要自己有模块地址，hud.js 也不用被打包进 client.js。
 *
 * 不负责：麦克风采集与界面渲染（分别在 client.js / hud.js）。
 * 对外只用 Cordis 的插件入口：name / inject / apply；其余函数都是内部实现。
 *
 * 音频不落盘：WAV 只作为一次请求的 Buffer 存在于内存中，识别完即丢弃。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONFIG_SCHEMA,
  CONFIG_VERSION,
  applyPatch,
  loadConfig,
  saveConfig,
} from './config.js'
import { dataRootOf, probe } from './paths.js'
import { parseRiskWords, withFirstNotice, withRiskNotice } from './risk.js'
import {
  bestWakeMatch,
  findWakePhrase,
  matchWakeOnly,
  splitPhrases,
  tableSize,
  wakeRejectReason,
} from './pinyin.js'

/** Cordis 插件名。与 cordis.patch.yml 里的条目 id 保持一致。 */
export const name = 'voice-wake'

/**
 * 插件版本。诊断里要显示，所以直接从自己的 package.json 读，避免两处手改不同步。
 * 读不到也不影响功能，退化成 '0.0.0'。
 */
const VERSION = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof raw.version === 'string' ? raw.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 浏览器半允许上报的日志阶段名。白名单之外的一律丢弃，
 * 既防止日志文件被任意文本灌入，也让以后加阶段时必须显式登记。
 */
const CLIENT_STAGES = new Set([
  'page.ready',
  'config.loaded',
  'mic.request',
  'mic.granted',
  'mic.denied',
  'mic.error',
  'mic.fallback',
  'mic.ended',
  'mic.stopped',
  'audio.running',
  'audio.suspended',
  'audio.resumed',
  'audio.stalled',
  'audio.level',
  'vad.start',
  'vad.segment',
  'vad.drop',
  'vad.skip',
  'resample.failed',
  'post.sent',
  'post.failed',
  'test.start',
  'test.done',
  'test.failed',
  'selfcheck.sent',
  'jump.retry',
  'ui.copy',
  'hud.mounted',
  'hud.load-failed',
  'hud.settings',
  'hud.mute',
  'hud.closed',
  'wake.chime',
  'wake.probe-hit',
  'diag.location',
  'diag.ctx',
  'diag.service',
  'diag.failed',
])
/** 每分钟允许写入的客户端日志条数上限，防止异常循环把 run.log 撑爆。 */
const CLIENT_LOG_PER_MINUTE = 240

/**
 * 需要的服务：webServer 提供同源 HTTP 路由（设置页和主窗口都用相对 fetch），
 * sessionController 负责创建会话与投递用户消息。
 * speechToText 用 ctx.get 惰性获取：用户没装语音 bundle 时插件仍要能启动并给出清楚报错。
 */
export const inject = ['webServer', 'sessionController']

/** 路由前缀。与浏览器半的 PREFIX 必须一致。 */
const PREFIX = '/.dsh-voice-wake'
/** 单段录音上限。16 kHz 单声道 PCM16 约 32 KB/秒，64 MB 够连续说约 34 分钟。 */
const MAX_WAV_BYTES = 64 * 1024 * 1024
/** 「切到哪个会话」目标的存活时间，超时作废，避免主窗口隔很久才被抢。 */
const JUMP_TTL_MS = 30000
/** 识别超时。首次调用要加载模型（本地 239 MB），留足时间。 */
const TRANSCRIBE_TIMEOUT_MS = 60000
/** 内存日志环形缓冲条数（run.log 是完整的，这里只留最近这么多给诊断用）。 */
const LOG_LIMIT = 200
/** 专用会话的标题：新建时用它；老会话如果还叫旧默认名，启动时也会被改成它。 */
const SESSION_TITLE = '语音唤醒会话'
/** 历史默认标题：只用于「是否该改名」的判断，用户自己改过的不动。 */
const LEGACY_SESSION_TITLES = new Set(['语音唤醒', '语音唤醒绘画'])
/**
 * 唤醒后插入会话的固定提示。走 log-only 的 command 事件，不进模型上下文。
 * 故意不跟唤醒词——用户可能把唤醒词改成任何词，固定文案最稳。
 * 也不写「在听」：这条提示只表示“语音唤醒收到了一次唤醒”，不代表麦克风真的在收内容。
 */
const WAKE_NOTICE = '（语音唤醒）'

/** 本进程的运行态。一个 Host 进程只有一份。 */
const runtime = {
  config: undefined,
  configError: '',
  migratedFrom: 0,
  conversing: false,
  lastActivity: 0,
  lastHeard: '',
  lastError: '',
  lastCode: '',
  /** 最近一次识别原始文本（已截断），设置页诊断里要显示。 */
  lastAsrText: '',
  /** 最近一次唤醒匹配结果：'' | 'hit:<唤醒词>' | 'miss'。 */
  lastWake: '',
  /** 最近一段音频：字节数、峰值、有声时长、来源、时间。 */
  lastBytes: 0,
  lastPeak: 0,
  lastVoicedMs: 0,
  lastDurMs: 0,
  lastUtteranceAt: 0,
  lastUtteranceSource: '',
  jump: { sessionId: '', at: 0 },
  /** 已经提示过“本会话可能收到语音转写”的会话 id。 */
  notifiedSessions: new Set(),
  log: [],
  probeCache: { at: 0, value: undefined },
  clientLogBudget: { at: 0, count: 0 },
  /** 串行化：两段语音不会同时打乱会话投递顺序。 */
  queue: Promise.resolve(),
}

/** 日志里任何自由文本都要先过一遍：去换行/控制字符，并截断。 */
function cleanDetail(value, limit = 240) {
  if (value === undefined || value === null) return ''
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 截断文本（识别结果用，默认 120 字，符合「不写完整聊天内容」的约定）。 */
function clipText(value, limit = 120) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 识别文本写日志时的值：默认只写长度，开启 logTranscript 后才写截断文本。
 * 这样默认不会把用户说的话落盘。
 * @param {string} text 识别文本
 * @returns {string} 可写进日志的短值
 */
function transcriptLogValue(text) {
  return runtime.config?.logTranscript === true ? clipText(text, 120) : `chars=${text.length}`
}

/**
 * 识别文本写日志时的字段：默认 `chars=N`，开启后 `text=...`。
 * @param {string} text 识别文本
 * @returns {string} 形如 `chars=5` 或 `text=...`
 */
function transcriptLogField(text) {
  return runtime.config?.logTranscript === true ? `text=${clipText(text, 120)}` : `chars=${text.length}`
}

/**
 * 错误的第一行。日志里只留这一行，避免把整段栈写进 run.log；
 * 优先用 stack 的第一行（形如 `RemoteError: xxx`），退回 name/message。
 * @param {unknown} error 抛出来的东西
 * @returns {string} 单行错误描述
 */
function errorLine(error) {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' ? error.stack.split(/\r?\n/, 1)[0] : ''
    const line = stack !== '' ? stack : `${error.name}: ${error.message}`
    return cleanDetail(line, 300)
  }
  return cleanDetail(String(error), 300)
}

/**
 * 把最近一段音频的体检字段拼成一行。识别为空时用它区分「没说话」和「过载」：
 * peak 接近 1 说明波形被削平（麦克风增益过高），标 `clip=1`。
 * @returns {string} 形如 `bytes=35542 dur=1109ms voiced=256ms peak=0.0475`
 */
function audioSummary() {
  const parts = [
    `bytes=${runtime.lastBytes}`,
    `dur=${Math.round(runtime.lastDurMs)}ms`,
    `voiced=${Math.round(runtime.lastVoicedMs)}ms`,
    `peak=${runtime.lastPeak.toFixed(4)}`,
  ]
  if (runtime.lastPeak >= 0.99) parts.push('clip=1')
  return parts.join(' ')
}

/** 状态机的两个状态码。设置页直接显示这两个字符串。 */
const MODE_LISTENING = 'listening'
const MODE_CONVERSING = 'conversing'

// ------------------------------------------------------- 扩展点（v0.6.1）
//
// 这一节只有「口子」，没有实现任何新功能：
//  - beforeSend：发送前管道，第三方可以插入处理器（拦截/改写/路由）；
//  - onStateChange / onTranscript：只读订阅，方便独立窗口或其他插件观察状态。
// 默认配置下它们的行为与 0.6.0 完全一致（管道里只有一个原样返回的 passthrough）。

/**
 * 发送前管道（扩展点）。**默认只有一个 passthrough，行为与以前完全相同。**
 *
 * 数组按顺序执行：每一步拿到上一步的输出，返回新文本；
 * 返回 null / undefined 表示「这一步把这句话拦下了」，本次不发送、
 * 不写入会话（例如把「打开浏览器」路由到自定义动作，而不是发给模型）。
 *
 * 第三方用法（与插件同进程，ESM）：
 *   import { beforeSend } from 'dsh-voice-wake'
 *   beforeSend.push({
 *     id: 'my-router',
 *     description: '把「打开浏览器」拦下来，改走我自己的动作',
 *     run(text, ctx) { return text.startsWith('打开浏览器') ? null : text },
 *   })
 *
 * 约定：
 *  - run(text, ctx) 可以是同步函数，也可以返回 Promise；ctx 是本插件上下文；
 *  - 不要在这里改插件内部状态；抛异常会让本次发送中止（记 pipeline.error），
 *    不会把原文继续发出去；
 *  - 日志只记 `pipeline.ran steps=… lenIn=… lenOut=…`，**不记正文**。
 */
export const beforeSend = [
  {
    id: 'passthrough',
    description: '默认处理器：原样返回识别文本。管道为空时文本也会原样通过，它只是把默认行为显式写出来。',
    run(text) {
      return text
    },
  },
]

/** 只读订阅者集合。用 Set 去重；回调抛异常只记日志，不影响状态机。 */
const subscribers = {
  state: new Set(),
  transcript: new Set(),
}

/** 上一次通知出去的状态签名（mode|enabled|sessionId），用于去重。 */
let lastEmittedStateKey = ''

/**
 * 拼一份对外的只读状态快照。外部只能读，不能改内部状态。
 * @param {string} reason 触发原因（wake/sent/end-word/idle/disabled/enabled/subscribe…）
 * @returns {object} 只读快照
 */
function statePayload(reason) {
  const enabled = runtime.config?.enabled === true
  return {
    mode: enabled ? (runtime.conversing ? MODE_CONVERSING : MODE_LISTENING) : 'off',
    enabled,
    conversing: runtime.conversing,
    sessionId: typeof runtime.config?.sessionId === 'string' ? runtime.config.sessionId : '',
    reason,
    at: Date.now(),
  }
}

/**
 * 通知所有状态订阅者。状态没变（mode/enabled/sessionId 都相同）就不通知。
 * @param {string} reason 触发原因
 */
function emitState(reason) {
  if (runtime.config === undefined) return
  const payload = statePayload(reason)
  const key = `${payload.mode}|${payload.enabled}|${payload.sessionId}`
  if (key === lastEmittedStateKey) return
  lastEmittedStateKey = key
  for (const subscriber of [...subscribers.state]) {
    try {
      subscriber({ ...payload })
    } catch (error) {
      log('subscriber.failed', `event=state ${errorLine(error)}`)
    }
  }
}

/**
 * 通知所有识别结果订阅者。空文本不通知；日志里不写正文。
 * @param {string} text 识别文本
 * @param {string} source 来源：conversing / wake
 */
function emitTranscript(text, source) {
  if (typeof text !== 'string' || text === '') return
  const payload = { text, source, at: Date.now() }
  for (const subscriber of [...subscribers.transcript]) {
    try {
      subscriber({ ...payload })
    } catch (error) {
      log('subscriber.failed', `event=transcript ${errorLine(error)}`)
    }
  }
}

/**
 * 订阅状态变化（只读，最小接口）。
 *
 * 订阅时会立刻收到一份当前快照，之后每次 mode/enabled/sessionId 变化再收到一份。
 * 回调拿到的是副本，改它不会影响插件内部状态。
 *
 * @param {(state: { mode: string, enabled: boolean, conversing: boolean, sessionId: string, reason: string, at: number }) => void} callback 订阅回调
 * @returns {() => void} 取消订阅
 */
export function onStateChange(callback) {
  if (typeof callback !== 'function') return () => {}
  subscribers.state.add(callback)
  if (runtime.config !== undefined) {
    try {
      callback({ ...statePayload('subscribe') })
    } catch (error) {
      log('subscriber.failed', `event=state ${errorLine(error)}`)
    }
  }
  return () => subscribers.state.delete(callback)
}

/**
 * 订阅识别结果（只读，最小接口）。
 *
 * 只有真正处理的一段语音才会通知（「测试识别」不会），空识别也不会。
 * 回调里能拿到原始识别文本，调用方自己负责别再往外传。
 *
 * @param {(event: { text: string, source: string, at: number }) => void} callback 订阅回调
 * @returns {() => void} 取消订阅
 */
export function onTranscript(callback) {
  if (typeof callback !== 'function') return () => {}
  subscribers.transcript.add(callback)
  return () => subscribers.transcript.delete(callback)
}

/**
 * 让一段文字依次经过 beforeSend 里的处理器。
 * @param {string} text 原始识别文本
 * @param {object} ctx 插件上下文（原样传给每个处理器，方便它们取服务）
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: 'cancelled'|'error'|'empty', step: string}>} 是否继续发送
 */
async function runBeforeSend(text, ctx) {
  const steps = beforeSend.filter((step) => step !== null && typeof step?.run === 'function')
  let current = text
  for (const step of steps) {
    const id = cleanDetail(step.id ?? 'unnamed', 40)
    let next
    try {
      next = await step.run(current, ctx)
    } catch (error) {
      log('pipeline.error', `step=${id} ${errorLine(error)}`)
      return { ok: false, reason: 'error', step: id }
    }
    if (next === null || next === undefined) {
      log('pipeline.cancelled', `step=${id} lenIn=${current.length}`)
      return { ok: false, reason: 'cancelled', step: id }
    }
    if (typeof next !== 'string') {
      log('pipeline.error', `step=${id} returned=${typeof next}`)
      return { ok: false, reason: 'error', step: id }
    }
    current = next
  }
  // 只记长度，不记正文。
  log('pipeline.ran', `steps=${steps.length} lenIn=${text.length} lenOut=${current.length}`)
  if (current.trim() === '') {
    log('pipeline.cancelled', 'step=empty lenIn=' + text.length)
    return { ok: false, reason: 'empty', step: 'empty' }
  }
  return { ok: true, text: current }
}

/**
 * 在语音会话里插入一条固定提示，但**不进入模型上下文**。
 *
 * DSH 的 `command/run` / `command/done` 是 log-only 事件：UI 会渲染成命令块，
 * 但 session 的 `deriveMessages()` 不会把它们放进模型历史。这里用一对
 * 命令生命周期事件承载「（语音唤醒）」，比塞一条 user/message 安全。
 * 任何一步失败都只记日志，不影响唤醒与发送。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @param {string} text 提示文本
 * @returns {boolean} 是否成功插入
 */
function insertSessionNotice(ctx, sessionId, text) {
  try {
    const sessions = ctx.get('sessions')
    let session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    if (session === undefined) {
      // 某些组合没有注入 sessions 服务，退回 agents 上的 session。
      const agents = ctx.get('agents')
      session = typeof agents?.get === 'function' ? agents.get(sessionId)?.session : undefined
    }
    if (session === undefined || typeof session.append !== 'function') {
      log('confirm.notice-skipped', 'session-append-unavailable')
      return false
    }
    const commandId = `voice-wake-${randomUUID()}`
    session.append('command/run', { commandId, name: 'voice-wake', source: { kind: 'user' } })
    session.append('command/done', { commandId, kind: 'success', text })
    log('confirm.notice', `sessionId=${sessionId} chars=${text.length}`)
    return true
  } catch (error) {
    log('confirm.notice-failed', errorLine(error))
    return false
  }
}

/**
 * 唯一的对话态写入口：改状态、写 `state.change` 日志、落盘。
 * 所有出口（唤醒 / 送达 / 结束词 / 空闲超时 / 关开关）都必须走这里，
 * 免得某条路径改了 runtime.conversing 却没日志、或者状态和设置页对不上。
 * @param {boolean} next 目标是否为对话态
 * @param {string} reason 变更原因（wake / sent / end-word / idle / disabled / remount）
 * @param {string} [detail] 追加到日志行尾的细节
 */
function setConversing(next, reason, detail) {
  const from = runtime.conversing ? MODE_CONVERSING : MODE_LISTENING
  const to = next ? MODE_CONVERSING : MODE_LISTENING
  if (from === to) return
  runtime.conversing = next
  if (next) runtime.lastActivity = Date.now()
  log('state.change', `from=${from} to=${to} reason=${reason}${detail === undefined ? '' : ` ${detail}`}`)
  // 扩展点：通知 onStateChange 的订阅者（只读，不改状态机）。
  emitState(reason)
}

/** 追加一条日志。音频数据永不写入；识别文本由调用方先截断。 */
function log(event, detail) {
  const text = cleanDetail(detail)
  const line = `${new Date().toISOString()} ${event}${text === '' ? '' : ` ${text}`}`
  runtime.log.push(line)
  if (runtime.log.length > LOG_LIMIT) runtime.log.splice(0, runtime.log.length - LOG_LIMIT)
  try {
    const dir = join(dataRootOf(runtime.config), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'run.log'), `${line}\n`, 'utf8')
  } catch {
    // 日志写不进去不影响功能。
  }
}

/**
 * 记一条来自浏览器半的日志。阶段名必须在白名单内，且有每分钟条数上限。
 * @param {unknown} entry 形如 { stage, detail } 的一条上报
 * @returns {boolean} 是否真的写进了日志
 */
function writeClientLog(entry) {
  const now = Date.now()
  if (now - runtime.clientLogBudget.at > 60000) runtime.clientLogBudget = { at: now, count: 0 }
  if (runtime.clientLogBudget.count >= CLIENT_LOG_PER_MINUTE) return false
  const stage = typeof entry?.stage === 'string' ? entry.stage.trim() : ''
  if (stage === '' || stage.length > 40 || !CLIENT_STAGES.has(stage)) return false
  runtime.clientLogBudget.count += 1
  log(stage, entry?.detail)
  return true
}

/** 带缓存的依赖体检（statSync 很便宜，但设置页每秒轮询，缓存 5 秒足够）。 */
function probeCached() {
  const now = Date.now()
  if (runtime.probeCache.value !== undefined && now - runtime.probeCache.at < 5000) {
    return runtime.probeCache.value
  }
  const value = probe(runtime.config)
  runtime.probeCache = { at: now, value }
  return value
}

/** 丢掉体检缓存，配置变化后立刻重算。 */
function invalidateProbe() {
  runtime.probeCache = { at: 0, value: undefined }
}

/**
 * 当前状态。设置页直接显示这几项。
 * @returns {object} 状态快照
 */
function snapshot() {
  const config = runtime.config
  const enabled = config.enabled === true
  const mode = enabled ? (runtime.conversing ? MODE_CONVERSING : MODE_LISTENING) : 'off'
  return {
    version: VERSION,
    enabled,
    mode,
    /** 给界面看的状态中文由浏览器半的 zh 字典决定，这里只给机器码。 */
    sessionId: config.sessionId,
    sessionTitle: SESSION_TITLE,
    deviceId: config.deviceId,
    wakeWords: config.wakeWords,
    wakeAtStart: config.wakeAtStart,
    language: config.language,
    /** 可调参数：设置页滑杆/下拉直接读这几个值。 */
    wakeSensitivity: config.wakeSensitivity,
    silenceMs: config.silenceMs,
    maxSegmentMs: config.maxSegmentMs,
    chimeVolume: config.chimeVolume,
    probeEnabled: config.probeEnabled === true,
    followActive: config.followActive !== false,
    riskNotice: config.riskNotice !== false,
    riskWords: typeof config.riskWords === 'string' ? config.riskWords : '',
    logTranscript: config.logTranscript === true,
    /** HUD：开关与四个初值（位置/折叠/透明度/层级）都从配置里带出去。 */
    hudEnabled: config.hudEnabled === true,
    hudPosition: config.hudPosition ?? null,
    hudCollapsed: config.hudCollapsed === true,
    hudOpacity: config.hudOpacity,
    hudZIndex: config.hudZIndex,
    lastHeard: runtime.lastHeard,
    lastCode: runtime.lastCode,
    lastError: runtime.lastError,
    lastAsrText: clipText(runtime.lastAsrText),
    lastWake: runtime.lastWake,
    lastBytes: runtime.lastBytes,
    lastPeak: runtime.lastPeak,
    lastVoicedMs: runtime.lastVoicedMs,
    lastDurMs: runtime.lastDurMs,
    lastUtteranceAt: runtime.lastUtteranceAt,
    lastUtteranceSource: runtime.lastUtteranceSource,
    configVersion: CONFIG_VERSION,
    migratedFrom: runtime.migratedFrom,
    configError: runtime.configError,
    homophones: tableSize(),
  }
}

/**
 * 对外可见的配置：由 CONFIG_SCHEMA 里标了 public 的字段自动拼出来，
 * 加字段不用再记得同时改这里（内部路径类字段不发给界面）。
 * @returns {object} 界面可读的配置
 */
function publicConfig() {
  const out = {}
  for (const [name, field] of Object.entries(CONFIG_SCHEMA)) {
    if (field.public === true) out[name] = runtime.config[name]
  }
  return out
}

/**
 * 把一次录音交给 DSH 内置的本地 SenseVoice provider。
 * 该 provider 内部就是 sherpa-onnx + SenseVoice + Silero VAD，模型与原生库都是本地文件。
 * @param {object} ctx 插件上下文
 * @param {Buffer} wav 规范 16 kHz 单声道 PCM16 WAV 字节
 * @returns {Promise<string>} 识别文本
 */
async function transcribe(ctx, wav) {
  const speech = ctx.get('speechToText')
  if (speech === undefined || typeof speech.resolve !== 'function') {
    const error = new Error('speech-service-missing')
    error.code = 'speech-service-missing'
    throw error
  }
  const health = probeCached()
  if (health.modelRoot === '') {
    const error = new Error('model-missing')
    error.code = 'model-missing'
    error.detail = health.problems[0] ?? ''
    throw error
  }
  // 长段音频（单句最长可以设到「不限」）按音频时长放宽超时：
  // 44 字节是 WAV 头，16 kHz 单声道 PCM16 = 32 字节/毫秒。
  // 留 1.2 倍时长 + 30 秒，慢机器识别 5 分钟录音也不会被 60 秒默认超时掐掉。
  const durationMs = Math.max(0, (wav.length - 44) / 32)
  const timeoutMs = Math.max(TRANSCRIBE_TIMEOUT_MS, Math.round(durationMs * 1.2) + 30000)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('transcribe-timeout'))
  }, timeoutMs)
  try {
    const audio = new Uint8Array(wav)
    const spec = speech.resolve({ audio, language: runtime.config.language })
    const result = await speech.transcribe(spec, controller.signal)
    return typeof result?.text === 'string' ? result.text.trim() : ''
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error))
    if (wrapped.message.startsWith('Speech provider is unavailable')) wrapped.code = 'provider-unavailable'
    else wrapped.code = 'transcribe-failed'
    throw wrapped
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轻量校验 WAV 头，给出比 provider 更清楚的中文错误。
 * @param {Buffer} bytes 请求体
 * @returns {boolean} 是否是可接受的录音
 */
function looksLikeWave(bytes) {
  return (
    bytes.length >= 46 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE' &&
    bytes.readUInt32LE(24) === 16000 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt16LE(34) === 16
  )
}

/**
 * 生成一段静音 WAV（16 kHz / 单声道 / PCM16），只用于冷启动预热。
 * @param {number} milliseconds 时长
 * @returns {Buffer} 合法 WAV
 */
function silenceWav(milliseconds) {
  const samples = Math.max(1, Math.round((16000 * milliseconds) / 1000))
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(16000 * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

/**
 * 冷启动预热：第一次识别要加载本地模型（几百 MB），会慢好几秒。
 * 插件挂载后主动跑一次「静音识别」，把这段加载时间挪到启动阶段，
 * 这样你第一次喊唤醒词时就不用等模型加载。
 * @param {object} ctx 插件上下文
 * @returns {Promise<void>}
 */
async function warmupAsr(ctx) {
  try {
    const started = Date.now()
    await transcribe(ctx, silenceWav(300))
    log('asr.warmup', `ms=${Date.now() - started}`)
  } catch (error) {
    log('asr.warmup-failed', errorLine(error))
  }
}

/**
 * 找到或创建专用语音会话。优先复用配置里记住的 id。
 * @param {object} ctx 插件上下文
 * @returns {Promise<string>} 会话 id
 */
async function ensureSession(ctx) {
  const controller = ctx.sessionController
  const remembered = runtime.config.sessionId
  if (typeof remembered === 'string' && remembered !== '') {
    try {
      const info = await controller.inspect(remembered)
      // 老版本的默认标题（「语音唤醒」/「语音唤醒绘画」）：只在这种情况下降级改名，
      // 用户自己改成别的名字就保持不动。
      if (typeof info?.title === 'string' && LEGACY_SESSION_TITLES.has(info.title)) {
        try {
          await controller.rename({ sessionId: remembered, title: SESSION_TITLE })
          log('session.renamed', `${remembered} ${info.title} -> ${SESSION_TITLE}`)
        } catch (error) {
          log('session.rename-failed', errorLine(error))
        }
      }
      return remembered
    } catch {
      log('session.gone', remembered)
    }
  }
  let created
  // 扩展点：语音会话用哪个 agent preset 由配置 sessionPreset 决定。
  // 默认 'standard' 就是 0.6.0 之前写死的值，所以不配就完全等价于旧行为；
  // 改成 'computer-use' 之类的 preset 是使用者自己的选择，插件不内置任何操作电脑的实现。
  // 空串表示「交给部署的默认 preset」（create({})）。
  const preset = typeof runtime.config.sessionPreset === 'string' ? runtime.config.sessionPreset.trim() : ''
  try {
    // create(request) 的真实字段只有 sessionId/cwd/workspaceId/agentPreset，没有 title；
    // 标题在创建后用 rename 补。
    created = await controller.create(preset === '' ? {} : { agentPreset: preset })
  } catch (error) {
    // 某些版本/部署不接受这个 preset id，退一步用部署默认 preset。
    log('session.create-retry', `${errorLine(error)} preset=${preset === '' ? 'default' : preset}`)
    created = await controller.create({})
  }
  const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
  if (sessionId === '') throw Object.assign(new Error('session-create-failed'), { code: 'session-create-failed' })
  runtime.config.sessionId = sessionId
  saveConfig(dataRootOf(runtime.config), runtime.config)
  log('session.created', sessionId)
  try {
    await controller.rename({ sessionId, title: SESSION_TITLE })
  } catch (error) {
    // 标题只是好看，失败不影响收发。
    log('session.title-failed', errorLine(error))
  }
  return sessionId
}

/** 让主窗口下一次轮询时切到这个会话。 */
function armJump(sessionId) {
  runtime.jump = { sessionId, at: Date.now() }
  log('jump.armed', sessionId)
}

/**
 * 把一段文字作为用户消息发到专用会话。
 * 优先用 mode=steer：第二次唤醒要**打断**上一轮（还在生成/干活），而不是排队；
 * steer 不被支持时自动退回 mode=queue，保证消息不丢。
 *
 * 真实签名（`@deepseek-ai/dsh-api-session-controller` 的 Host 服务）：
 *   prompt(request, signal)
 *     request = { requestId, sessionId, mode: 'queue' | 'steer', content: [{ type: 'text', text }], clientTimeZone? }
 *     signal  = AbortSignal，**必填**：方法第一行就 `signal.throwIfAborted()`。
 * 旧版只传了 request，signal 是 undefined，于是抛
 * `Cannot read properties of undefined (reading 'throwIfAborted')`。
 *
 * @param {object} ctx 插件上下文
 * @param {string} text 要发送的文字
 * @returns {Promise<string>} 会话 id
 */
/**
 * 尽力打断上一轮：不同版本的 sessionController 暴露的方法名不一样，
 * 这里按常见名字挨个试一遍；都不支持就静默跳过（steer 仍会尝试打断）。
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 会话 id
 * @returns {Promise<boolean>} 是否成功调用了某个中止方法
 */
async function abortRunningTurn(ctx, sessionId) {
  const controller = ctx.sessionController
  if (controller === null || typeof controller !== 'object') return false
  for (const name of ['interrupt', 'abort', 'stop', 'cancel', 'cancelTurn']) {
    const fn = controller[name]
    if (typeof fn !== 'function') continue
    for (const arg of [sessionId, { sessionId }]) {
      try {
        await fn.call(controller, arg)
        // 日志里带上 sessionId：一眼能确认中止的是「语音会话」，不是别的会话。
        log('send.abort', `method=${name} sessionId=${sessionId}`)
        return true
      } catch {
        // 换一种参数形态再试；都不行就继续找下一个方法。
      }
    }
  }
  return false
}

/**
 * 解析这次要发到哪个会话。
 * 优先用浏览器半带上来的「主窗口当前会话」；它会校验一次，失败就退回默认语音会话。
 * @param {object} ctx 插件上下文
 * @param {string} target 浏览器半给的会话 id（可能为空）
 * @returns {Promise<string>} 可用的会话 id
 */
async function resolveTargetSession(ctx, target) {
  // 设置里关掉「发到当前会话」时，一律发到插件自己的「语音唤醒会话」。
  if (runtime.config.followActive === false) return ensureSession(ctx)
  if (typeof target !== 'string' || target === '') return ensureSession(ctx)
  try {
    await ctx.sessionController.inspect(target)
    return target
  } catch {
    log('session.target-missing', target)
    return ensureSession(ctx)
  }
}

/**
 * 发送前给消息加两类提示：
 *  - 每个会话的第一条语音消息前，说明“本会话可能有语音转写”；
 *  - 命中敏感词时，在末尾追加“可能有误，执行前请确认”。
 * 只改文本，不拦截发送。
 * @param {string} text 识别文本
 * @param {string} sessionId 目标会话
 * @returns {string} 最终发送的文本
 */
function shapeOutgoing(text, sessionId) {
  const config = runtime.config ?? {}
  const words = parseRiskWords(config.riskWords)
  const risk = withRiskNotice(text, config.riskNotice !== false, words)
  if (risk.hit !== '') log('risk.notice', `word=${clipText(risk.hit, 40)}`)
  const first = withFirstNotice(risk.text, runtime.notifiedSessions, sessionId)
  if (first.first) log('session.first-notice', sessionId)
  return first.text
}

async function deliver(ctx, text, targetSession) {
  const sessionId = await resolveTargetSession(ctx, targetSession)
  const outgoing = shapeOutgoing(text, sessionId)
  // 先尽力打断上一轮（尤其是还在跑工具的时候，steer 可能只是排队）。
  await abortRunningTurn(ctx, sessionId)
  // 主窗口发消息时也会带本机时区；带上它，模型才知道「现在」。
  const timeZone = resolvedTimeZone()
  /**
   * 优先用 steer：你再次喊唤醒词时，应该**打断**上一轮（还在生成/干活），
   * 而不是排在它后面等。某些部署/版本不支持 steer 时退回 queue，保证消息不丢。
   */
  for (const mode of ['steer', 'queue']) {
    const controller = new AbortController()
    const request = {
      requestId: `voice-wake-${randomUUID()}`,
      sessionId,
      mode,
      content: [{ type: 'text', text: outgoing }],
    }
    if (timeZone !== '') request.clientTimeZone = timeZone
    try {
      await ctx.sessionController.prompt(request, controller.signal)
      armJump(sessionId)
      log('send.ok', `sessionId=${sessionId} mode=${mode} chars=${outgoing.length}`)
      return sessionId
    } catch (error) {
      if (mode === 'steer') {
        // steer 不被支持时静默降级，不打断投递。
        log('send.steer-failed', errorLine(error))
        continue
      }
      // 投递失败只有这里写日志：读日志的人只需要一条 send.failed。
      log('send.failed', errorLine(error))
      throw error
    }
  }
  throw new Error('send-failed')
}

/**
 * 本机 IANA 时区。取不到就返回空串（prompt 允许省略 clientTimeZone）。
 * @returns {string} 形如 Asia/Shanghai
 */
function resolvedTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : ''
  } catch {
    return ''
  }
}

/**
 * 「鲸鱼」的 ASR 谐音兜底：前后鼻音不分时常被写成「金鱼」。
 * 用户没显式写「金鱼」时自动补一条别名，免得每次都被识别成金鱼而叫不醒。
 * 只补 鲸鱼→金鱼 这一种；京鱼/经鱼/精鱼 本来就靠拼音容错命中。
 * @param {string[]} phrases 配置里的唤醒词
 * @returns {string[]} 带别名的唤醒词列表
 */
function withJinYuAlias(phrases) {
  const out = []
  for (const phrase of phrases) {
    out.push(phrase)
    if (phrase.startsWith('鲸鱼')) out.push(`金鱼${phrase.slice(2)}`)
  }
  return out
}

/**
 * 记一次识别结果，供设置页诊断显示。
 * @param {string} text 原始识别文本
 */
function rememberText(text) {
  runtime.lastAsrText = clipText(text)
}

/**
 * 处理一段录音：识别 -> 判断是唤醒还是直接说话 -> 投递。
 * 每个分支都留日志，让用户能自己在 run.log 里判断断在哪一步。
 * @param {object} ctx 插件上下文
 * @param {Buffer} wav 录音
 * @param {string} [targetSession] 浏览器半带上来的「主窗口当前会话」id
 * @returns {Promise<object>} 给浏览器半的结果
 */
async function onUtterance(ctx, wav, targetSession) {
  if (runtime.config.enabled !== true) {
    log('utterance.ignored', `disabled bytes=${wav.length}`)
    return { code: 'disabled', state: snapshot() }
  }
  if (!looksLikeWave(wav)) {
    log('utterance.bad-audio', `bytes=${wav.length}`)
    return { code: 'bad-audio', state: snapshot(), error: '需要 16 kHz 单声道 PCM16 WAV' }
  }

  let text
  try {
    text = await transcribe(ctx, wav)
  } catch (error) {
    const code = error?.code ?? 'transcribe-failed'
    runtime.lastCode = code
    runtime.lastError = error instanceof Error ? error.message : String(error)
    if (error?.detail) runtime.lastError = `${runtime.lastError} ${error.detail}`
    log('transcribe.failed', `${code} ${runtime.lastError}`)
    return { code, error: runtime.lastError, state: snapshot() }
  }
  if (text === '') {
    runtime.lastCode = 'empty'
    runtime.lastError = ''
    runtime.lastHeard = ''
    rememberText('')
    // 空识别要把这段音频的体检数据留下来，才知道是「没说话」还是「削波」。
    log('asr.text', `empty ${audioSummary()}`)
    return { code: 'empty', state: snapshot() }
  }
  rememberText(text)
  log('asr.text', transcriptLogValue(text))
  runtime.lastHeard = text
  runtime.lastActivity = Date.now()
  // 扩展点：把识别结果只读地广播给 onTranscript 的订阅者（不写日志正文）。
  emitTranscript(text, runtime.conversing ? 'conversing' : 'wake')

  const phrases = withJinYuAlias(splitPhrases(runtime.config.wakeWords))
  const atStart = runtime.config.wakeAtStart !== false
  // 严格唤醒：整段只能是唤醒词（允许标点/空白），多一个字都不算。
  const { hit, rest: restText, wakeOnly } = matchWakeOnly(text, phrases, atStart)
  if (hit === null) {
    const best = bestWakeMatch(text, phrases)
    const reason = wakeRejectReason(text, phrases, { mode: 'inline', atStart })
    runtime.lastCode = 'no-wake'
    runtime.lastError = ''
    runtime.lastWake = 'miss'
    log('wake.reject', `reason=${reason} ${transcriptLogField(text)}`)
    // 把「最接近的候选 + 差几个音节」写进日志，才能判断是阈值太严还是识别跑偏。
    // 识别文本默认只写长度；开启诊断日志后才写截断文本。
    log(
      'wake.miss',
      `${transcriptLogField(text)} best=${best === null ? 'none' : clipText(best.matched, 40)}` +
        ` distance=${best === null ? -1 : best.distance}`,
    )
    return { code: 'no-wake', text, state: snapshot() }
  }
  runtime.lastCode = 'woken'
  runtime.lastError = ''
  runtime.lastWake = `hit:${hit.phrase}`
  log(
    'wake.hit',
    `atStart=${atStart} matched=${hit.matched} distance=${hit.distance}` +
      ` score=${hit.score.toFixed(2)} rest-chars=${restText.length}`,
  )
  // 严格模式：唤醒词必须独占一句，多出任何内容都不算唤醒（避免误触发）。
  // 注意：这里先判严格，再创建/切换会话，避免“顺口提到唤醒词”把界面拽走。
  if (!wakeOnly) {
    runtime.lastCode = 'not-wake-only'
    runtime.lastError = ''
    runtime.lastWake = 'miss'
    log('wake.not-alone', `rest-chars=${restText.length}`)
    return { code: 'not-wake-only', text, rest: restText, sent: false, state: snapshot() }
  }
  setConversing(true, 'wake', `phrase=${hit.phrase}`)
  try {
    // 和投递用同一套目标解析：开「发到当前会话」时用当前窗口的会话，
    // 关着时才用/建专用「语音唤醒会话」。
    const sessionId = await resolveTargetSession(ctx, targetSession)
    armJump(sessionId)
    // 只喊了唤醒词：插一条提示，浏览器半会响「叮」并开「请讲」窗口。
    insertSessionNotice(ctx, sessionId, WAKE_NOTICE)
    setConversing(false, 'wake-alone', 'rest=0')
    return { code: 'woken', text, rest: '', sessionId, sent: false, state: snapshot() }
  } catch (error) {
    runtime.lastCode = 'send-failed'
    runtime.lastError = errorLine(error)
    setConversing(false, 'send-failed')
    log('wake.failed', runtime.lastError)
    return { code: 'send-failed', text, error: runtime.lastError, state: snapshot() }
  }
}

/**
 * 「请讲」窗口里的后续一段：不做唤醒词匹配，识别出文字就直接投递。
 * 浏览器半在窗口内发来的音频都会带 `follow=1`。
 * @param {object} ctx 插件上下文
 * @param {Buffer} wav 录音
 * @param {string} [targetSession] 浏览器半带上来的「主窗口当前会话」id
 * @returns {Promise<object>} 给浏览器半的结果
 */
async function onFollowUtterance(ctx, wav, targetSession) {
  if (runtime.config.enabled !== true) return { code: 'disabled', state: snapshot() }
  if (!looksLikeWave(wav)) {
    log('follow.bad-audio', `bytes=${wav.length}`)
    return { code: 'follow-bad-audio', sent: false }
  }
  let text
  try {
    text = await transcribe(ctx, wav)
  } catch (error) {
    runtime.lastError = errorLine(error)
    log('follow.failed', runtime.lastError)
    return { code: 'follow-failed', sent: false, error: runtime.lastError }
  }
  if (text === '') {
    rememberText('')
    log('asr.text', `empty (follow) ${audioSummary()}`)
    return { code: 'follow-empty', sent: false, state: snapshot() }
  }
  rememberText(text)
  log('asr.text', transcriptLogValue(text))
  runtime.lastHeard = text
  runtime.lastActivity = Date.now()
  emitTranscript(text, 'follow')
  // 扩展点：发送前管道（默认 passthrough）；输入是识别出来的正文（含标点）。
  const piped = await runBeforeSend(text, ctx)
  if (!piped.ok) {
    log('follow.blocked', `reason=${piped.reason}`)
    return { code: 'follow-blocked', sent: false, state: snapshot() }
  }
  try {
    const sessionId = await deliver(ctx, piped.text, targetSession)
    log('follow.sent', `sessionId=${sessionId} chars=${piped.text.length}`)
    return { code: 'woken', text, sent: true, sessionId, state: snapshot() }
  } catch (error) {
    runtime.lastError = errorLine(error)
    log('follow.send-failed', runtime.lastError)
    return { code: 'send-failed', sent: false, error: runtime.lastError, state: snapshot() }
  }
}

/**
 * 「快速唤醒探测」：只识别一段开头音频，判断有没有叫醒，不投递、不改状态。
 *
 * 浏览器半在每段话开头（约 1.6 秒）调用一次，命中就立刻响提示音；
 * 正式发送仍然等整段结束后的完整识别，所以文字质量不受影响。
 * @param {object} ctx 插件上下文
 * @param {Buffer} wav 开头一小段录音
 * @returns {Promise<{code: string, wake: boolean, text?: string}>} 探测结果
 */
async function onProbeUtterance(ctx, wav) {
  if (!looksLikeWave(wav)) return { code: 'probe-bad-audio', wake: false }
  let text
  try {
    text = await transcribe(ctx, wav)
  } catch (error) {
    log('probe.failed', errorLine(error))
    return { code: 'probe-failed', wake: false }
  }
  const phrases = withJinYuAlias(splitPhrases(runtime.config.wakeWords))
  const atStart = runtime.config.wakeAtStart !== false
  const hit = findWakePhrase(text, phrases, { mode: 'inline', atStart })
  log('probe.result', `wake=${hit === null ? 'no' : 'yes'} chars=${text.length}`)
  return { code: 'probe-ok', wake: hit !== null }
}

/**
 * 「测试识别」：只识别，不匹配唤醒词、不投递、不改对话态。
 * 设置页用它区分「没抓到声音」和「识别不准」。
 * @param {object} ctx 插件上下文
 * @param {Buffer} wav 录音
 * @returns {Promise<object>} { code, text, ms }
 */
async function onTestUtterance(ctx, wav) {
  if (!looksLikeWave(wav)) {
    log('utterance.bad-audio', `test bytes=${wav.length}`)
    return { code: 'bad-audio', error: '需要 16 kHz 单声道 PCM16 WAV', state: snapshot() }
  }
  const started = Date.now()
  try {
    const text = await transcribe(ctx, wav)
    rememberText(text)
    runtime.lastCode = 'test-ok'
    runtime.lastError = ''
    log('asr.text', text === '' ? `empty (test) ${audioSummary()}` : `${transcriptLogValue(text)} (test)`)
    return { code: 'test-ok', text, ms: Date.now() - started, state: snapshot() }
  } catch (error) {
    const code = error?.code ?? 'transcribe-failed'
    runtime.lastCode = code
    runtime.lastError = error instanceof Error ? error.message : String(error)
    if (error?.detail) runtime.lastError = `${runtime.lastError} ${error.detail}`
    log('transcribe.failed', `test ${code} ${runtime.lastError}`)
    return { code, error: runtime.lastError, state: snapshot() }
  }
}

// ---------------------------------------------------------------- HTTP 层

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** HUD 组件文件名。与 package.json 的 files 白名单保持一致。 */
const HUD_FILE = 'hud.js'

/**
 * 把 hud.js 原样发给浏览器半（GET /hud.js）。
 *
 * 为什么走 Host 路由而不是让 client.js 直接 import 相对路径：client.js 是被当
 * 普通脚本执行的，没有「自己所在的模块 URL」，浏览器里只能 import() 一个绝对地址。
 * 由 Host 提供同源地址，既不新增依赖，也让 hud.js 继续是纯 ESM 文件
 * （独立置顶窗口的宿主可以直接 import 同一个文件）。
 *
 * 读不到文件时返回 404 的注释文本，浏览器半只会记一条 hud.load-failed，不影响其它功能。
 * @param {object} res HTTP 响应
 */
function sendHudModule(res) {
  try {
    const source = readFileSync(new URL(`../${HUD_FILE}`, import.meta.url), 'utf8')
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': Buffer.byteLength(source),
    })
    res.end(source)
  } catch (error) {
    log('hud.file-missing', errorLine(error))
    sendText(res, 404, `// ${HUD_FILE} not found`, 'text/javascript; charset=utf-8')
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, limit = 65536) {
  const bytes = await readBody(req, limit)
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * 认证/来源检查：沿用主窗口已有的登录 cookie，和 dsh-orb 一样的做法。
 * @param {object} ctx 插件上下文
 * @param {object} req 请求
 * @returns {number|undefined} 拒绝时返回状态码
 */
function rejectionStatus(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection === null) return undefined
  if (typeof connection.admit === 'function') {
    const admitted = connection.admit(req)
    if (typeof admitted === 'object' && admitted !== null && typeof admitted.rejection === 'number') {
      return admitted.rejection
    }
    return undefined
  }
  if (typeof connection.isAuthenticated === 'function') return connection.isAuthenticated(req) ? undefined : 401
  return undefined
}

/**
 * 诊断报告：版本、路径、依赖是否存在、最近一次识别/唤醒结果、最近日志。
 * 音频永不落盘；识别文本截断到 120 字。
 */
function diagnosticsReport() {
  const health = probeCached()
  const current = snapshot()
  const lastUtteranceAt = runtime.lastUtteranceAt === 0 ? '(还没收到过)' : new Date(runtime.lastUtteranceAt).toISOString()
  const lines = [
    '语音唤醒（dsh-voice-wake）诊断报告',
    `生成时间: ${new Date().toISOString()}`,
    `插件版本: ${VERSION}`,
    `配置版本: ${CONFIG_VERSION}（读取自 v${runtime.migratedFrom}）`,
    `开关: ${runtime.config.enabled ? '开' : '关'}`,
    `当前状态: ${current.mode}`,
    `数据目录: ${health.dataRoot}`,
    `配置文件: ${health.configFile}`,
    `日志文件: ${health.logFile}`,
    `模型目录: ${health.modelRoot === '' ? '(未找到)' : health.modelRoot}`,
    `模型文件: ${health.files.model === '' ? '(未找到)' : health.files.model}`,
    `tokens.txt: ${health.files.tokens === '' ? '(未找到)' : health.files.tokens}`,
    `Silero VAD: ${health.files.vad === '' ? '(未找到)' : health.files.vad}`,
    `sherpa-onnx 原生库: ${health.sherpa.root === '' ? '(未找到)' : health.sherpa.root}`,
    `同音字表规模: ${tableSize()} 字`,
    `语音会话 id: ${runtime.config.sessionId === '' ? '(尚未创建)' : runtime.config.sessionId}`,
    `会话预设: ${runtime.config.sessionPreset === '' ? '(部署默认)' : runtime.config.sessionPreset}`,
    `发送前管道: ${beforeSend.map((step) => step?.id ?? '?').join(' → ') || '(空)'}`,
    `麦克风设备: ${runtime.config.deviceId === '' ? '(系统默认)' : runtime.config.deviceId}`,
    `唤醒词: ${runtime.config.wakeWords}`,
    `段首要求: ${runtime.config.wakeAtStart ? '开（最多 1 个语气词）' : '关'}`,
    `工作方式: 单次指令（唤醒词 + 内容一起说，发完回监听）`,
    `灵敏度: 第 ${runtime.config.wakeSensitivity} 档 / 10（1 最灵敏，10 最保守）`,
    `静音切段: ${runtime.config.silenceMs}ms（说完后静音这么久自动发送）`,
    `识别语言: ${runtime.config.language}`,
    `HUD 卡片: ${runtime.config.hudEnabled ? '开' : '关'}（绑定在设置页，位置记忆在浏览器 localStorage）`,
    `最后一段音频: ${lastUtteranceAt}（来源 ${runtime.lastUtteranceSource === '' ? '(无)' : runtime.lastUtteranceSource}，${runtime.lastBytes} 字节，时长 ${runtime.lastDurMs}ms，有声 ${runtime.lastVoicedMs}ms，峰值 ${runtime.lastPeak}${runtime.lastPeak >= 0.99 ? '，clip=1' : ''}）`,
    `最后识别文本: ${current.lastAsrText === '' ? '(空)' : current.lastAsrText}`,
    `最后唤醒匹配: ${current.lastWake === '' ? '(还没跑过)' : current.lastWake}`,
    `最后错误: ${runtime.lastError === '' ? '(无)' : runtime.lastError}`,
    '',
    '依赖问题:',
    ...(health.problems.length === 0 ? ['  无'] : health.problems.map((item) => `  - ${item}`)),
    '',
    '最近日志:',
    ...(runtime.log.length === 0 ? ['  (空)'] : runtime.log.map((line) => `  ${line}`)),
  ]
  return lines.join('\n')
}

/**
 * 解析请求路径用的占位 origin。只是给 `new URL()` 一个 base，
 * 不代表任何真实地址，也不发起网络请求。
 */
const URL_BASE = 'http://127.0.0.1'

/** 主处理函数。 */
async function handle(ctx, req, res) {
  const rejection = rejectionStatus(ctx, req)
  if (rejection !== undefined) {
    log('route.rejected', `${rejection} ${(req.method ?? 'GET')} ${req.url ?? ''}`)
    sendText(res, rejection, 'unauthorized')
    return
  }
  const url = new URL(req.url ?? '/', URL_BASE)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === `${PREFIX}/hud.js`) {
    sendHudModule(res)
    return
  }
  if (method === 'GET' && path === `${PREFIX}/state`) {
    sendJson(res, 200, { state: snapshot(), health: healthSummary(ctx) })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/config`) {
    sendJson(res, 200, { config: publicConfig(), state: snapshot(), health: healthSummary(ctx) })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/config`) {
    const patch = asRecord(await readJson(req))
    if (patch === undefined) {
      sendJson(res, 400, { error: 'invalid-body' })
      return
    }
    applyConfigPatch(patch)
    sendJson(res, 200, { config: publicConfig(), state: snapshot(), health: healthSummary(ctx) })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/log`) {
    const body = asRecord(await readJson(req, 262144))
    const entries = Array.isArray(body?.entries) ? body.entries : body?.stage === undefined ? [] : [body]
    let written = 0
    for (const entry of entries) if (writeClientLog(entry)) written += 1
    sendJson(res, 200, { ok: true, written })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/log`) {
    const asked = Number(url.searchParams.get('limit') ?? 60)
    const limit = Math.min(LOG_LIMIT, Math.max(1, Number.isFinite(asked) ? Math.trunc(asked) : 60))
    sendText(res, 200, `${runtime.log.slice(-limit).join('\n')}\n`)
    return
  }
  if (method === 'POST' && path === `${PREFIX}/utterance`) {
    const test = url.searchParams.get('test') === '1'
    const probe = url.searchParams.get('probe') === '1'
    const follow = url.searchParams.get('follow') === '1'
    // 浏览器半会带上「主窗口当前会话」：跟随当前窗口，把它发到那个会话里。
    const targetSession = url.searchParams.get('session') ?? ''
    const peak = Number(url.searchParams.get('peak'))
    const durationMs = Number(url.searchParams.get('dur'))
    const voicedMs = Number(url.searchParams.get('voiced'))
    const body = await readBody(req, MAX_WAV_BYTES)
    if (probe) {
      // 「唤醒探测」：只识别开头一小段、只判断有没有唤醒词，不投递、不改状态。
      try {
        const result = await enqueue(() => onProbeUtterance(ctx, body))
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 200, { code: 'probe-failed', wake: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    runtime.lastUtteranceAt = Date.now()
    runtime.lastBytes = body.length
    runtime.lastUtteranceSource = test ? 'test' : (runtime.conversing ? 'conversing' : 'wake')
    runtime.lastDurMs = Number.isFinite(durationMs) ? Math.round(durationMs) : 0
    runtime.lastVoicedMs = Number.isFinite(voicedMs) ? Math.round(voicedMs) : 0
    if (Number.isFinite(peak)) runtime.lastPeak = Number(peak.toFixed(4))
    log(
      'utterance.received',
      `source=${runtime.lastUtteranceSource} test=${test ? 1 : 0} bytes=${body.length}` +
        `${Number.isFinite(durationMs) ? ` dur=${Math.round(durationMs)}ms` : ''}` +
        `${Number.isFinite(voicedMs) ? ` voiced=${Math.round(voicedMs)}ms` : ''}` +
        `${Number.isFinite(peak) ? ` peak=${runtime.lastPeak}` : ''}` +
        `${runtime.lastPeak >= 0.99 ? ' clip=1' : ''}`,
    )
    try {
      const result = await enqueue(() =>
        test ? onTestUtterance(ctx, body) : follow ? onFollowUtterance(ctx, body, targetSession) : onUtterance(ctx, body, targetSession),
      )
      sendJson(res, 200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.lastError = message
      runtime.lastCode = 'failed'
      log('utterance.failed', message)
      sendJson(res, 500, { error: message, code: 'failed', state: snapshot() })
    }
    return
  }
  if (method === 'GET' && path === `${PREFIX}/jump`) {
    const armed = runtime.jump.sessionId !== '' && Date.now() - runtime.jump.at < JUMP_TTL_MS
    sendJson(res, 200, armed ? { sessionId: runtime.jump.sessionId, at: runtime.jump.at } : { sessionId: '', at: 0 })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/jump`) {
    const body = asRecord(await readJson(req))
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId !== '' && sessionId === runtime.jump.sessionId) runtime.jump = { sessionId: '', at: 0 }
    sendJson(res, 200, { ok: true })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/diagnostics`) {
    sendText(res, 200, diagnosticsReport())
    return
  }
  log('route.not-found', `${method} ${path}`)
  sendJson(res, 404, { error: 'not-found' })
}

/**
 * 给界面的依赖体检摘要（不含路径细节，路径在诊断导出里）。
 * 同时检查「模型文件」和「speechToText 服务」：两者缺一都不能识别。
 * @param {object} ctx 插件上下文
 * @returns {{modelsReady: boolean, speechReady: boolean, problems: string[]}}
 */
function healthSummary(ctx) {
  const health = probeCached()
  const speech = typeof ctx?.get === 'function' ? ctx.get('speechToText') : undefined
  const speechReady = speech !== undefined && typeof speech.resolve === 'function'
  const problems = [...health.problems]
  if (!speechReady) {
    problems.unshift('未检测到 DSH 语音输入服务（speechToText）：请先在「设置 → 语音输入」安装/启用官方语音输入插件。')
  }
  return {
    modelsReady: health.modelRoot !== '' && speechReady,
    speechReady,
    problems,
  }
}

/**
 * 应用设置页提交的改动。
 *
 * 字段校验完全交给 config.js 的 CONFIG_SCHEMA（applyPatch），这里只做
 * 「配置变了之后必须发生的副作用」：开关联动状态机、调参写一行可 grep 的日志。
 * @param {Record<string, unknown>} patch 提交内容
 */
function applyConfigPatch(patch) {
  const config = runtime.config
  const { changed, ignored } = applyPatch(config, patch)
  if (ignored.length > 0) log('config.ignored', `fields=${ignored.join(',')}`)
  if (changed.includes('enabled')) {
    if (config.enabled === true) {
      runtime.lastActivity = Date.now()
      runtime.lastError = ''
      runtime.lastCode = ''
    } else {
      setConversing(false, 'disabled')
      runtime.jump = { sessionId: '', at: 0 }
      log('state.reset', 'disabled')
    }
    // 开关会让 mode 在 off 与 listening 之间切换，这里补一次通知
    // （emitState 内部会按签名去重）。
    emitState(config.enabled === true ? 'enabled' : 'disabled')
  }
  saveConfig(dataRootOf(config), config)
  if (changed.includes('wakeSensitivity')) log('sensitivity.changed', `level=${config.wakeSensitivity}`)
  if (changed.includes('silenceMs')) log('vad.silence', `value=${config.silenceMs}`)
  log(
    'config.saved',
    `changed=${changed.join(',') || 'none'} enabled=${config.enabled}` +
      ` device=${config.deviceId === '' ? 'default' : config.deviceId}` +
      ` atStart=${config.wakeAtStart}` +
      ` sensitivity=${config.wakeSensitivity}` +
      ` silence=${config.silenceMs}ms hud=${config.hudEnabled ? 'on' : 'off'}`,
  )
}

/** 串行化录音处理。 */
function enqueue(task) {
  const run = runtime.queue.then(task, task)
  runtime.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 挂载 Host 半。
 * @param {object} ctx Cordis 上下文；inject 已满足
 * @param {object} config cordis.patch.yml 里的 config
 */
export function apply(ctx, config) {
  const patchConfig = asRecord(config) ?? {}
  const scaffold = {
    dataRoot: typeof patchConfig.dataRoot === 'string' ? patchConfig.dataRoot : '',
    modelRoot: typeof patchConfig.modelRoot === 'string' ? patchConfig.modelRoot : '',
    dshHome: typeof patchConfig.dshHome === 'string' ? patchConfig.dshHome : '',
    sherpaRoot: typeof patchConfig.sherpaRoot === 'string' ? patchConfig.sherpaRoot : '',
  }
  const dataRoot = dataRootOf(scaffold)
  const loaded = loadConfig(dataRoot)
  const merged = { ...loaded.config, ...scaffold }
  // 配置里已存的值优先，patch 只补空缺。
  for (const key of ['dataRoot', 'modelRoot']) {
    if (typeof loaded.config[key] === 'string' && loaded.config[key] !== '') merged[key] = loaded.config[key]
  }
  runtime.config = merged
  runtime.configError = loaded.error
  runtime.migratedFrom = loaded.migratedFrom
  // 单次指令模式下不存在「对话态」，重启一律从监听开始。
  runtime.conversing = false
  runtime.lastActivity = Date.now()
  // 老 config.json 读进来已经补齐默认值；顺手落盘，下次启动就是当前版本。
  // 文件不存在或解析失败（migratedFrom=0）时不动磁盘，避免覆盖用户手写内容。
  if (loaded.migratedFrom > 0 && loaded.migratedFrom !== CONFIG_VERSION) {
    try {
      saveConfig(dataRoot, merged)
      // 固定格式，方便 grep：config.migrated from=8 to=9 wakeWords=...
      log(
        'config.migrated',
        `from=${loaded.migratedFrom} to=${CONFIG_VERSION}` +
          ` wakeWords=${merged.wakeWords}`,
      )
    } catch (error) {
      log('config.migrate-failed', errorLine(error))
    }
  }
  log(
    'plugin.mounted',
    `version=${VERSION} dataRoot=${dataRoot} enabled=${merged.enabled === true} device=${merged.deviceId === '' ? 'default' : merged.deviceId}` +
      `${runtime.configError === '' ? '' : ` configError=${runtime.configError}`}`,
  )

  // 没装官方语音输入插件时，插件仍要能正常挂载，但要留一条明确日志。
  const speechService = typeof ctx.get === 'function' ? ctx.get('speechToText') : undefined
  if (speechService === undefined) {
    log('speech.missing', 'speechToText 服务不存在：识别不可用，请先安装/启用官方语音输入插件')
  }

  // 冷启动预热：挂载后马上跑一次静音识别，提前把识别模型加载进内存。
  // 代价是启动后一次 CPU 峰值（约 1–3 秒），换来第一次唤醒不用等模型加载。
  setTimeout(() => {
    void warmupAsr(ctx)
  }, 300).unref?.()

  ctx.effect(() => {
    let dispose
    try {
      dispose = ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) =>
          handle(ctx, req, res).catch((error) => {
            const status = typeof error?.status === 'number' ? error.status : 500
            if (res.headersSent) {
              res.end()
              return
            }
            if (status === 500) log('route.failed', error instanceof Error ? error.message : String(error))
            sendJson(res, status, { error: status === 500 ? 'internal-error' : String(error?.message ?? 'error') })
          }),
      })
      log('route.mounted', PREFIX)
    } catch (error) {
      // 路由挂不上时不要让整个插件树倒下：记日志，界面上会显示读不到设置。
      log('route.mount-failed', error instanceof Error ? error.message : String(error))
      dispose = undefined
    }
    return () => {
      if (typeof dispose === 'function') dispose()
      log('route.unmounted', PREFIX)
    }
  })

  // 单次指令没有「对话态」，也不存在空闲超时，不需要额外定时器。
  ctx.effect(() => () => {})

  // 每次配置改动后体检结果都可能变（例如用户补了模型）。
  invalidateProbe()
}

// DSH, Z
