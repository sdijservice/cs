// public/kakao-collect.js 의 안전 규칙을 실제로 돌려서 확인한다.
// 특히 "내용을 못 가져온 대화방의 커서를 전진시키지 않는다" — 이걸 어기면 그 상담이 영구 유실된다.
//
// 실행: npm test
//
// kakao-collect.js 는 브라우저용 통짜 스크립트라 import 할 수 없다. 그래서 파일을 읽어
// Node 안에서 실행시킨다. window 가 없으면 화면 그리는 부분을 건너뛰고
// globalThis.__sidaeCollect 로 함수만 내보내도록 만들어 두었다.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'public', 'kakao-collect.js')

let api
let sent
const CFG = { endpoint: 'https://x.supabase.co/functions/v1/kakao-ingest', token: 't' }

/** 카카오·서버 응답을 흉내낸다. 실제 응답과 같은 필드 이름·형식을 쓴다. */
function stubFetch({ failChatLogs = [], meStatus = 200 } = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const reply = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (u.includes('/api/users/me')) {
      return meStatus === 200
        ? reply({ email: 'sdijservice@gmail.com' })
        : reply({ message: 'Unauthorized' }, meStatus)
    }
    if (u.includes('/chats/search')) {
      return reply({
        items: [
          { id: 111, last_log_id: 'L9', talk_user: { id: 'u1', nickname: '김철수' } }, // 바뀜
          { id: 222, last_log_id: 'L5', talk_user: { id: 'u2', nickname: '이영희' } }, // 바뀜
          { id: 333, last_log_id: 'L1', talk_user: { id: 'u3', nickname: '박민수' } }, // 그대로
        ],
      })
    }
    if (u.includes('/chatlogs')) {
      const chatId = u.match(/chats\/(\d+)\/chatlogs/)[1]
      if (failChatLogs.includes(chatId)) return reply({ message: 'boom' }, 500)
      return reply({ items: [{ id: `${chatId}-a`, message: '문의드립니다', send_at: 1787000000000 }] })
    }
    if (opts.method === 'POST' && u.includes('kakao-ingest')) {
      sent = JSON.parse(opts.body)
      return reply({ ok: true, chats: sent.chats.length, messages: sent.messages.length })
    }
    if (u.includes('kakao-ingest')) {
      return reply({ cursors: { 111: 'L8', 222: 'L4', 333: 'L1' } })
    }
    throw new Error('예상 못 한 호출: ' + u)
  }
}

before(() => {
  // window 가 없는 상태로 실행 → 화면 코드를 건너뛰고 함수만 내보낸다.
  delete globalThis.window
  new Function(readFileSync(SRC, 'utf8'))()
  api = globalThis.__sidaeCollect
  assert.ok(api, 'kakao-collect.js 가 함수를 내보내지 않았습니다')
})

beforeEach(() => { sent = null })

describe('수집 동작', () => {
  test('바뀐 대화방만 골라 가져온다', async () => {
    stubFetch()
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(r.changed, 2, '바뀐 방 2개만 골라야 한다')
    assert.equal(sent.messages.length, 2, '메시지 2건 전송')
    assert.equal(sent.chats.length, 3, '대화방 메타는 3개 모두 전송')
  })

  test('★ 내용을 못 가져온 방은 메타도 보내지 않는다 (유실 방지)', async () => {
    stubFetch({ failChatLogs: ['222'] })
    await api.collectProfile(CFG, '_VGAQn')
    const ids = sent.chats.map((c) => String(c.id))
    assert.ok(!ids.includes('222'), '실패한 방의 메타를 보내면 그 상담이 영구 유실된다')
    assert.ok(ids.includes('111'), '성공한 방은 정상 전송')
    assert.ok(ids.includes('333'), '변경 없던 방은 그대로 전송')
    assert.ok(sent.messages.every((m) => m.chat_id !== '222'), '실패한 방의 메시지는 없어야 한다')
  })

  test('로그인이 풀리면 채널을 건드리지 않고 즉시 멈춘다', async () => {
    stubFetch({ meStatus: 401 })
    const all = await api.collectAll(CFG)
    assert.equal(all.ok, false)
    assert.equal(all.reason, 'login')
    assert.equal(all.results.length, 0, '수집을 시도조차 하지 않아야 한다')
  })

  test('채널 5개를 모두 돈다', async () => {
    stubFetch()
    const all = await api.collectAll(CFG)
    assert.equal(all.ok, true)
    assert.equal(all.results.length, 5)
    assert.equal(all.account, 'sdijservice@gmail.com')
  })

  test('수집 대상 채널 목록이 5개 그대로다', () => {
    assert.deepEqual(
      api.PROFILES.map((p) => p.id),
      ['_VGAQn', '_rcpPG', '_TkpPG', '_xfxilXn', '_rkbcn'],
    )
  })
})
