import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RISK_WORDS,
  FIRST_NOTICE,
  RISK_NOTICE,
  findRiskWord,
  parseRiskWords,
  withFirstNotice,
  withRiskNotice,
} from '../lib/risk.js'

test('parseRiskWords：去空格、去重、忽略大小写重复', () => {
  assert.deepEqual(parseRiskWords('删除, 清空 ,删除,RM -RF,rm -rf'), ['删除', '清空', 'RM -RF'])
  assert.deepEqual(parseRiskWords(''), [])
  assert.deepEqual(parseRiskWords(undefined), [])
})

test('findRiskWord：中英文命中，英文忽略大小写', () => {
  const words = parseRiskWords(DEFAULT_RISK_WORDS)
  assert.equal(findRiskWord('删除测试目录', words), '删除')
  assert.equal(findRiskWord('把测试目录删掉', words), '删掉')
  assert.equal(findRiskWord('RUN rm -rf /tmp/x', words), 'rm -rf')
  assert.equal(findRiskWord('今天天气不错', words), '')
  assert.equal(findRiskWord('', words), '')
})

test('withRiskNotice：命中才追加，且不重复', () => {
  const words = parseRiskWords(DEFAULT_RISK_WORDS)
  const hit = withRiskNotice('删除测试目录', true, words)
  assert.equal(hit.hit, '删除')
  assert.ok(hit.text.endsWith(RISK_NOTICE))

  const again = withRiskNotice(hit.text, true, words)
  assert.equal(again.hit, '')
  assert.equal(again.text, hit.text)

  const off = withRiskNotice('删除测试目录', false, words)
  assert.equal(off.text, '删除测试目录')
  assert.equal(off.hit, '')
})

test('withFirstNotice：同一会话只加一次', () => {
  const seen = new Set()
  const first = withFirstNotice('你好', seen, 's1')
  assert.equal(first.first, true)
  assert.ok(first.text.startsWith(FIRST_NOTICE))

  const second = withFirstNotice('再说一句', seen, 's1')
  assert.equal(second.first, false)
  assert.equal(second.text, '再说一句')

  const other = withFirstNotice('别的会话', seen, 's2')
  assert.equal(other.first, true)
})
