/**
 * 路径解析器（设计文档 15.1 第 2、3 条）。
 *
 * 插件里绝不出现任何人的绝对路径。所有目录按固定顺序解析：
 *   ① 显式配置（设置页 / cordis.patch.yml 的 `!!js dshHomePath(...)`）
 *   ② DSH 的 home 目录（DSH_HOME 环境变量，或 <用户主目录>/.dsh）
 *   ③ 插件自己的数据目录
 * 找不到就返回一条能看懂的问题说明，由调用方报给用户，绝不静默失败。
 *
 * 不负责：读写配置（见 config.js）、下载模型、发起识别。
 * 对外暴露：dshHome / dataRootOf / modelRootCandidates / sherpaRootCandidates / probe。
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * DSH 的 home 目录。
 * @param {string} explicit 配置里显式给出的值（优先）
 * @returns {string} 绝对路径
 */
export function dshHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 插件自己的数据目录。
 * @param {object} config 配置
 * @returns {string} 绝对路径
 */
export function dataRootOf(config) {
  if (typeof config.dataRoot === 'string' && config.dataRoot !== '') return config.dataRoot
  return join(dshHome(config.dshHome), 'dsh-voice-wake')
}

/** 目录/文件是否存在且类型正确。 */
function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * SenseVoice + Silero 模型目录的候选顺序。
 * @param {object} config 配置
 * @param {string} dataRoot 插件数据目录
 * @returns {string[]} 候选目录（按优先级）
 */
export function modelRootCandidates(config, dataRoot) {
  const out = []
  if (typeof config.modelRoot === 'string' && config.modelRoot !== '') out.push(config.modelRoot)
  out.push(join(dshHome(config.dshHome), 'speech-to-text', 'sensevoice', 'models'))
  out.push(join(dataRoot, 'models'))
  return [...new Set(out)]
}

/**
 * sherpa-onnx 原生库目录的候选顺序（只用于诊断，识别走 DSH 内置 provider）。
 * @param {object} config 配置
 * @returns {string[]} 候选目录
 */
export function sherpaRootCandidates(config) {
  const out = []
  if (typeof config.sherpaRoot === 'string' && config.sherpaRoot !== '') out.push(config.sherpaRoot)
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    out.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'sherpa-onnx-win-x64'))
    out.push(join(resources, 'dsh', 'node_modules', 'sherpa-onnx-win-x64'))
  }
  return [...new Set(out)]
}

/** 模型文件名。与 DSH speech-to-text bundle 的目录约定一致。 */
const MODEL_FILE = { int8: 'model.int8.onnx', fp32: 'model.onnx' }

/**
 * 探测全部依赖，产出可直接展示给别人看的诊断数据。
 * 不含任何音频、识别文本或对话内容（设计文档 15.1 第 5 条）。
 * @param {object} config 配置
 * @returns {object} 诊断快照
 */
export function probe(config) {
  const dataRoot = dataRootOf(config)
  const problems = []
  const candidates = modelRootCandidates(config, dataRoot)
  let modelRoot = ''
  let modelFile = ''
  for (const candidate of candidates) {
    if (!isDir(candidate)) continue
    const int8 = join(candidate, 'sensevoice-onnx', MODEL_FILE.int8)
    const fp32 = join(candidate, 'sensevoice-onnx', MODEL_FILE.fp32)
    if (isFile(int8) || isFile(fp32)) {
      modelRoot = candidate
      modelFile = isFile(int8) ? int8 : fp32
      break
    }
  }
  if (modelRoot === '') {
    problems.push(
      `找不到 SenseVoice 模型。已尝试：${candidates.join(' | ')}。` +
        `请把 model.int8.onnx 放进 <上面任一目录>/sensevoice-onnx/，或把 DSH 语音输入的 SenseVoice 模型下载到该位置。`,
    )
  }
  const tokens = modelRoot === '' ? '' : join(modelRoot, 'sensevoice-onnx', 'tokens.txt')
  const vad = modelRoot === '' ? '' : join(modelRoot, 'silero', 'silero_vad.onnx')
  if (modelRoot !== '' && !isFile(tokens)) problems.push(`缺少 tokens.txt：${tokens}`)
  if (modelRoot !== '' && !isFile(vad)) problems.push(`缺少 Silero VAD 模型：${vad}`)

  const sherpaCandidates = sherpaRootCandidates(config)
  const sherpaRoot = sherpaCandidates.find((candidate) => isDir(candidate)) ?? ''
  const sherpaLib = sherpaRoot === '' ? '' : join(sherpaRoot, 'sherpa-onnx.node')
  // sherpa 原生库缺失不算致命：识别由 DSH 内置 provider 执行，这里只做体检。
  if (sherpaRoot !== '' && !isFile(sherpaLib)) problems.push(`sherpa-onnx.node 不在 ${sherpaRoot}`)

  return {
    dataRoot,
    configFile: join(dataRoot, 'config.json'),
    logFile: join(dataRoot, 'logs', 'run.log'),
    modelRoot,
    files: { model: modelFile, tokens, vad },
    sherpa: { root: sherpaRoot, lib: sherpaLib, candidates: sherpaCandidates },
    problems,
  }
}
