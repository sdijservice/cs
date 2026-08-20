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
const PAGE = 50    // 카카오가 한 번에 주는 최대치(실제는 100)
const TOTAL = 250  // 내용 읽기 상한(MAX_LOGS_PER_RUN = 200)을 일부러 넘긴다.
                   // 상한에 안 걸리는 표본으로는 "커서만 올라가는" 유실 버그를 못 잡는다.
const CHATS = []
for (let i = 0; i < TOTAL; i++) {
  CHATS.push({
    id: 100 + i,
    // 19자리(3.9e18)에 홀수를 섞는다 — 숫자로 파싱되면 512 배수가 되어 홀수가 남을 수 없다.
    last_log_id: String(3911262568056639491n - BigInt(i) * 1000n),
    talk_user: { id: 'u' + i, nickname: '고객' + i },
  })
}
// 서버가 이미 알고 있는 지점. 100·101 은 바뀌었고 102 는 그대로, 나머지는 처음 본다.
const KNOWN = {
  100: '3911262568056639000',
  101: '3911262568056639000',
  102: CHATS[2].last_log_id,
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
  test('바뀐 대화방과 처음 보는 대화방을 가져온다', async () => {
    stubFetch()
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.ok(r.changed > 0)
    assert.equal(sent.messages.length, r.changed, '고른 방 수만큼 메시지를 가져와야 한다')
  })

  test('★ 내용을 못 가져온 방은 메타도 보내지 않는다 (유실 방지)', async () => {
    stubFetch({ failChatLogs: ['101'] })
    await api.collectProfile(CFG, '_VGAQn')
    const ids = sent.chats.map((c) => String(c.id))
    assert.ok(!ids.includes('101'), '실패한 방의 메타를 보내면 그 상담이 영구 유실된다')
    assert.ok(ids.includes('100'), '성공한 방은 정상 전송')
    assert.ok(ids.includes('102'), '변경 없던 방은 그대로 전송')
    assert.ok(sent.messages.every((m) => m.chat_id !== '101'))
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

// 목록 API 는 한 번에 100개까지만 준다. 예전에는 한 실행에 한 페이지만 훑어서
// 채널당 수천 개면 몇 시간이 걸렸다 — 사용자 눈에는 멈춘 것과 같다.
// 이제 목록 훑기(발견)와 내용 읽기를 분리해, 목록은 한 실행에 끝까지 내려간다.
describe('대화방 목록 전수 훑기', () => {
  test('★ 한 실행에서 목록을 끝까지 훑는다', async () => {
    stubFetch()
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(r.scanned, CHATS.length, `${CHATS.length}개를 다 봐야 하는데 ${r.scanned}개에서 멈췄다`)
    assert.ok(r.pages >= 4, `여러 페이지를 넘겨야 하는데 ${r.pages}페이지만 넘겼다`)
    assert.equal(sent.backfill.done, true, '끝까지 갔으면 완료로 표시해야 한다')
  })

  test('★★ 내용을 못 읽은 방의 커서를 올리지 않는다 (상한 초과분 유실 방지)', async () => {
    // 목록은 250개를 훑지만 내용은 한 실행에 200개까지만 읽는다.
    // 남은 50개를 커서까지 채워 보내면 다음 실행이 "변경 없음"으로 보고 영영 건너뛴다.
    stubFetch()
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(r.scanned, TOTAL, '목록은 전부 훑어야 한다')
    assert.ok(r.changed < TOTAL, '내용 읽기에는 상한이 걸려야 한다')

    const withCursor = new Set(sent.chats.map((c) => String(c.id)))
    const fetched = new Set(sent.messages.map((m) => String(m.chat_id)))
    for (const c of CHATS) {
      const id = String(c.id)
      const unchanged = KNOWN[id] === c.last_log_id
      if (unchanged || fetched.has(id)) continue
      assert.ok(!withCursor.has(id),
        `방 ${id} 은 내용을 못 받았는데 커서가 올라갔다 — 그 상담은 영구 유실된다`)
    }
    // 그 방들은 discovered 로 올라가 있어야 다음 실행이 다시 집어 든다.
    const found = new Set(sent.discovered.map((c) => String(c.id)))
    const pending = CHATS.filter((c) => !fetched.has(String(c.id)) && KNOWN[String(c.id)] !== c.last_log_id)
    assert.ok(pending.length > 0, '상한 초과분이 있어야 이 검사가 의미를 갖는다')
    assert.ok(pending.every((c) => found.has(String(c.id))), '못 읽은 방은 발견 목록에 남아야 한다')
  })

  test('★ 발견한 방은 커서 없이 올린다 (내용은 나중에 받는다)', async () => {
    stubFetch()
    await api.collectProfile(CFG, '_VGAQn')
    assert.ok(sent.discovered.length > 0, '발견 목록을 따로 보내야 한다')
    // 발견 목록에 올랐다고 내용을 안 받아도 되는 것은 아니다 — 다음 실행이 반드시 다시 본다.
    const discoveredIds = sent.discovered.map((c) => String(c.id))
    assert.ok(discoveredIds.includes(String(CHATS[TOTAL - 1].id)), '마지막 페이지의 방도 발견돼야 한다')
  })

  test('★ 내용 읽기에 상한이 있어도 목록 진도는 끝까지 간다', async () => {
    // 예전 구조의 병목: 한 페이지를 다 읽어내야만 진도가 넘어갔다.
    stubFetch({ failChatLogs: ['105', '106', '107'] })
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(r.scanned, CHATS.length, '내용 조회가 실패해도 목록은 끝까지 훑는다')
    assert.equal(sent.backfill.done, true)
    const ids = new Set(sent.chats.map((c) => String(c.id)))
    for (const bad of ['105', '106', '107']) {
      assert.ok(!ids.has(bad), '내용을 못 받은 방의 커서를 올리면 안 된다')
    }
  })

  test('★ 커서가 19자리 그대로 전달된다', async () => {
    stubFetch()
    await api.collectProfile(CFG, '_VGAQn')
    const c = sent.backfill.cursor
    assert.equal(typeof c, 'string')
    assert.equal(Number(BigInt(c) % 2n), 1, '값이 반올림되어 손상됐다')
  })

  test('저장된 지점에서 이어받고, 끝났으면 목록을 다시 훑지 않는다', async () => {
    stubFetch({ backfill: { cursor: CHATS[5].last_log_id, done: false } })
    await api.collectProfile(CFG, '_VGAQn')
    assert.equal(searchCalls[1], CHATS[5].last_log_id, '서버에 저장된 지점부터 이어야 한다')

    stubFetch({ backfill: { cursor: CHATS[TOTAL - 1].last_log_id, done: true } })
    const r = await api.collectProfile(CFG, '_VGAQn')
    assert.equal(searchCalls.length, 1, '백필이 끝났으면 목록을 한 번만 부른다')
    assert.equal(r.backfilling, false)
  })
})
