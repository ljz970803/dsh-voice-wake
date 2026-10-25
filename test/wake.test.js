/**
 * 唤醒匹配测试：这段逻辑决定「哪句话算唤醒、唤醒词后面的正文是什么」。
 *
 * 它是用户感知最强的一块（叫不醒 / 金鱼鲸鱼分不清），改算法前先跑这里。
 * 只测纯函数，不碰麦克风和 ASR。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { findWakePhrase, matchWakeOnly, originalIndexAt, splitPhrases, wakeRejectReason } from '../lib/pinyin.js'

const PHRASES = splitPhrases('鲸鱼，你在吗, 金鱼，你在吗')

test('拆分唤醒词：英文逗号分隔，去掉空项', () => {
  const phrases = splitPhrases('鲸鱼，你在吗, 金鱼，你在吗,')
  assert.equal(phrases.length, 2)
  assert.ok(phrases.every((item) => item.trim() !== ''))
})

test('一口气说「唤醒词 + 内容」：能切出正文', () => {
  const hit = findWakePhrase('鲸鱼，你在吗 今天天气怎么样', PHRASES, { mode: 'inline', atStart: true })
  assert.ok(hit)
  assert.equal(hit.rest, '今天天气怎么样')
})

test('段首允许一个语气词：「嗯，鲸鱼，你在吗 今天几号」', () => {
  const hit = findWakePhrase('嗯，鲸鱼，你在吗 今天几号', PHRASES, { mode: 'inline', atStart: true })
  assert.ok(hit)
  assert.equal(hit.rest, '今天几号')
})

test('段首规则：句子中间提到唤醒词不算唤醒', () => {
  const hit = findWakePhrase('今天天气不错，鲸鱼，你在吗', PHRASES, { mode: 'inline', atStart: true })
  assert.equal(hit, null)
  assert.equal(
    wakeRejectReason('今天天气不错，鲸鱼，你在吗', PHRASES, { mode: 'inline', atStart: true }),
    'not-at-start',
  )
})

test('同音容错：「金鱼」也能唤醒', () => {
  const hit = findWakePhrase('金鱼 你在吗 今天几号', PHRASES, { mode: 'inline', atStart: true })
  assert.ok(hit)
  assert.equal(hit.rest, '今天几号')
})

test('普通聊天不会误唤醒', () => {
  const hit = findWakePhrase('随便说句话', PHRASES, { mode: 'inline', atStart: true })
  assert.equal(hit, null)
})

test('紧凑下标映射回原文不会吞字（「判空」依赖它）', () => {
  const text = '鲸鱼，你在吗，今天几号'
  const hit = findWakePhrase(text, PHRASES, { mode: 'inline', atStart: true })
  assert.ok(hit)
  const rest = text
    .slice(originalIndexAt(text, hit.end))
    .replace(/^[\s，。、！？；：,.!?;:]+/u, '')
    .trim()
  assert.equal(rest, '今天几号')
})

test('严格唤醒：整句只有唤醒词才算，标点/空格不影响', () => {
  for (const text of ['鲸鱼你在吗', '鲸鱼，你在吗。', '鲸鱼 你在吗', '鲸鱼你在吗？']) {
    const result = matchWakeOnly(text, PHRASES, true)
    assert.equal(result.wakeOnly, true, text)
    assert.equal(result.rest, '', text)
  }
})

test('严格唤醒：唤醒词后面多一个字都不算', () => {
  const cases = [
    ['鲸鱼你在吗，今天几号', '今天几号'],
    ['鲸鱼你在吗 我在', '我在'],
    ['鲸鱼你在吗 嗯', '嗯'],
  ]
  for (const [text, rest] of cases) {
    const result = matchWakeOnly(text, PHRASES, true)
    assert.equal(result.wakeOnly, false, text)
    assert.equal(result.rest, rest, text)
  }
})

test('严格唤醒：段首语气词可以，句中提到不算', () => {
  assert.equal(matchWakeOnly('嗯，鲸鱼你在吗', PHRASES, true).wakeOnly, true)
  const mid = matchWakeOnly('今天天气不错，鲸鱼你在吗', PHRASES, true)
  assert.equal(mid.hit, null)
  assert.equal(mid.wakeOnly, false)
})

test('严格唤醒：同音「金鱼」也算干净唤醒', () => {
  const result = matchWakeOnly('金鱼你在吗', PHRASES, true)
  assert.equal(result.wakeOnly, true)
})
