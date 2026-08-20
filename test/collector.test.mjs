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

// 실제 파트너센터와 같은 형태의 가짜 데이터.
// last_log_id 는 19자리(약 3.9e18)로, 자바스크립트 안전 정수(9.0e15)를 넘는 실제 값과 같다.
// 일부러 홀수를 섞어 두었다 — 숫자로 파싱되면 512 단위로 반올림되어 짝수가 되므로,
// 이 값이 그대로 살아 있는지가 곧 정밀도 보존 여부의 증거가 된다.
const PAGE = 3   // 카카오가 한 번에 주는 최대치(실제는 100). 페이지 넘김을 시험하려고 작게 둔다.
const CHATS = [
  { id: 111, last_log_id: '3911262568056639491', talk_user: { id: 'u1', nickname: '김철수' } },
  { id: 222, last_log_id: '3911262568056639001', talk_user: { id: 'u2', nickname: '이영희' } },
  { id: 333, last_log_id: '3911262568056638001', talk_user: { id: 'u3', nickname: '박민수' } },
  { id: 444, last_log_id: '3211262568056639007', talk_user: { id: 'u4', nickname: '최지우' } },
  { id: 555, last_log_id: '3211262568056638001', talk_user: { id: 'u5', nickname: '정하늘' } },
]
// 서버가 이미 알고 있는 지점. 111·222 는 바뀌었고 333 은 그대로, 444·555 는 처음 본다.
const KNOWN = {
  111: '3911262568056639000',
  222: '3911262568056639000',
  333: '3911262568056638001',
}

function cmpBig(a, b) {
  a = String(a); b = String(b)
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : (a > b ? 1 : 0)
}

let searchCalls   // 목록 조회에 쓰인 since 값들 — 페이지가 실제로 넘어갔는지 확인한다.

/** 카카오·서버 응답을 흉내낸다. 실제 응답과 같은 필드 이름·형식을 쓴다. */
function stubFetch({ failChatLogs = [], meStatus = 200, backfill = { cursor: null, done: false } } = {}) {
  searchCalls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const reply = (body, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      // 큰 정수는 실제 API 와 마찬가지로 JSON 문자열 안에 숫자로 넣는다.
      // 수집기가 text() 로 받아 문자열로 고정하지 않으면 여기서 정밀도가 깨진다.
      text: async () => JSON.stringify(body).replace(
        /"last_log_id":"(\d+)"/g, '"last_log_id":$1'),
    })
    if (u.includes('/api/users/me')) {
      return meStatus === 200
        ? reply({ email: 'sdijservice@gmail.com' })
        : reply({ message: 'Unauthorized' }, meStatus)
    }
    if (u.includes('/chats/search')) {
      const since = (u.match(/[?&]since=([^&]*)/) || [])[1] || null
      searchCalls.push(since)
      const pool = CHATS
        .filter((c) => !since || cmpBig(c.last_log_id, since) < 0)
        .sort((a, b) => -cmpBig(a.last_log_id, b.last_log_id))
      return reply({ items: pool.slice(0, PAGE), has_next: pool.length > PAGE })
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
      return reply({ cursors: KNOWN, backfill })
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
    assert.equal(r.changed, 4, '바뀐 방 2개 + 처음 보는 방 2개')
    assert.equal(sent.messages.length, 4, '메시지 4건 전송')
    assert.equal(sent.chats.length, 5, '대화방 메타는 5개 모두 전송')
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

// 목록 API 는 한 번에 100개까지만 준다(size 를 올려도 잘린다). since 커서로 이어받지 않으면
// 채널당 최근 100개 대화방에서 영구히 멈춘다 — 실제로 그 상태였다.
describe('대화방 목록 페이지 넘김', () => {
  test('★ 첫 페이지에서 멈추지 않고 과거까지 훑는다', async () => {
    stubFetch()
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.ok(r.scanned > PAGE, `한 페이지(${PAGE}개)를 넘겨 훑어야 하는데 ${r.scanned}개에서 멈췄다`)
    assert.equal(r.scanned, CHATS.length, '전체 대화방을 다 봐야 한다')
    assert.equal(searchCalls.length, 2, '목록을 두 번 불러야 한다(최신 1 + 과거 1)')
    assert.equal(searchCalls[0], null, '첫 번째는 커서 없이 최신부터')
  })

  test('★ 커서가 19자리 그대로 전달된다 (숫자로 읽으면 값이 어긋난다)', async () => {
    stubFetch()
    await api.collectProfile(CFG, '_VGAQn')
    assert.equal(sent.backfill.cursor, '3211262568056638001')
    assert.equal(typeof sent.backfill.cursor, 'string', '문자열이어야 한다')
    // 3.9e18 구간에서 배정밀도 실수의 간격은 512다. 숫자로 파싱됐다면 512의 배수가 되어
    // 홀수일 수 없다. 홀수로 살아 있다는 것이 곧 정밀도가 보존됐다는 증거다.
    assert.equal(Number(BigInt(sent.backfill.cursor) % 2n), 1, '값이 반올림되어 손상됐다')
  })

  test('★ 페이지 안에 못 가져온 방이 있으면 진도를 전진시키지 않는다', async () => {
    stubFetch({ failChatLogs: ['444'] })
    await api.collectProfile(CFG, '_VGAQn')
    assert.equal(sent.backfill.cursor, null, '실패한 구간을 건너뛰면 그 상담은 다시 조회되지 않는다')
    assert.equal(sent.backfill.done, false)
    assert.ok(!sent.chats.map((c) => String(c.id)).includes('444'), '실패한 방의 메타도 보내지 않는다')
  })

  test('저장된 지점에서 이어받는다', async () => {
    stubFetch({ backfill: { cursor: '3911262568056638001', done: false } })
    await api.collectProfile(CFG, '_VGAQn')
    assert.equal(searchCalls[1], '3911262568056638001', '서버에 저장된 지점부터 이어야 한다')
  })

  test('과거를 다 받으면 done 으로 표시하고, 다음부터는 최신 페이지만 본다', async () => {
    stubFetch()
    await api.collectProfile(CFG, '_VGAQn')
    assert.equal(sent.backfill.done, true, '더 과거가 없으면 끝난 것으로 표시해야 한다')

    stubFetch({ backfill: { cursor: '3211262568056638001', done: true } })
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(searchCalls.length, 1, '백필이 끝났으면 목록을 한 번만 부른다')
    assert.equal(r.backfilling, false)
  })
})
