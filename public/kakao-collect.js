/* 시대인재 상담 수집 — 북마클릿 본체
 *
 * 이 파일은 카카오 파트너센터(business.kakao.com) 화면 안에서 돈다.
 * 직원이 북마크를 한 번 누르면 이 스크립트가 그 페이지에 얹혀서, 탭이 열려 있는 동안
 * 5분마다 상담 내용을 읽어 사내 서버로 보낸다.
 *
 * 왜 확장 프로그램이 아니라 북마크인가
 *   카카오는 상담 대화를 내보내는 공식 방법을 제공하지 않는다. 그래서 사람이 로그인한
 *   브라우저 세션을 빌려 읽는 수밖에 없다. 그 일을 할 수 있는 곳은 두 군데뿐이다.
 *   (1) 확장 프로그램  (2) 파트너센터 페이지 안에서 도는 스크립트.
 *   사내 보안 정책상 확장 설치가 불가능하므로 (2)를 쓴다. 설치하는 것이 아니라
 *   북마크 하나를 추가하는 것이라 별도 프로그램이 PC 에 남지 않는다.
 *
 * 개인정보를 가리는 일은 여기서 하지 않는다. 서버(kakao-ingest)가 한다.
 * 이 파일은 직원 브라우저에서 돌기 때문에 언제든 낡거나 바뀔 수 있어,
 * "무엇을 저장할지" 판단을 맡기면 안 된다. 여기는 "가져오는 일"만 한다.
 */
;(function () {
  'use strict'

  var BASE = 'https://business.kakao.com'
  var CFG_KEY = 'sidae.collect.cfg'
  var INTERVAL_MS = 5 * 60 * 1000
  var CHATS_PAGE = 100          // 카카오가 한 번에 주는 최대치(size 를 올려도 100에서 잘린다)
  var LOGS_PAGE = 200
  var MAX_CHANGED_PER_RUN = 40  // 최신 페이지에서 한 번에 훑을 방 수(카카오 쪽 부담)
  var GAP_MS = 120              // 대화방 사이 간격

  // 파트너센터 UI 가 목록을 부를 때 그대로 쓰는 본문. status 를 빼면 대상이 좁아질 수 있어
  // UI 와 똑같이 맞춘다.
  var SEARCH_BODY = JSON.stringify({ is_blocked: false, status: 'all', keyword: '', labels: [] })

  // 시대인재 운영 채널 5개
  var PROFILES = [
    { id: '_VGAQn', label: '마이클래스' },
    { id: '_rcpPG', label: 'LIVE' },
    { id: '_TkpPG', label: 'LIVE 기술지원' },
    { id: '_xfxilXn', label: '콘텐츠' },
    { id: '_rkbcn', label: '통합로그인' },
  ]

  // ─────────────────────────── 설정 읽기 ───────────────────────────
  // 토큰은 스크립트 주소의 # 뒤에 실려 온다. # 뒤는 서버로 전송되지 않으므로
  // 우리 쪽 접속 기록에도 토큰이 남지 않는다.
  function configFromScriptUrl() {
    var el = document.currentScript
    var src = el && el.src ? el.src : ''
    var hash = src.indexOf('#') >= 0 ? src.slice(src.indexOf('#') + 1) : ''
    if (!hash) return null
    var p = new URLSearchParams(hash)
    var e = p.get('e')
    var t = p.get('t')
    return e && t ? { endpoint: e, token: t } : null
  }

  function loadConfig() {
    var fromUrl = configFromScriptUrl()
    if (fromUrl) {
      try { localStorage.setItem(CFG_KEY, JSON.stringify(fromUrl)) } catch { /* 저장 실패는 무시 — 다음 클릭 때 다시 넣는다 */ }
      return fromUrl
    }
    try {
      var raw = localStorage.getItem(CFG_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  // ─────────────────────────── 카카오 조회 ───────────────────────────
  function kakao(path, options) {
    options = options || {}
    var headers = { accept: 'application/json, text/plain, */*', 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' }
    for (var k in (options.headers || {})) headers[k] = options.headers[k]
    return fetch(BASE + path, {
      method: options.method || 'GET',
      body: options.body,
      credentials: 'include', // 직원이 이미 로그인한 세션을 그대로 쓴다
      headers: headers,
    }).then(function (res) {
      if (!res.ok) {
        return res.text().catch(function () { return '' }).then(function (body) {
          var err = new Error('HTTP ' + res.status + ' ' + path + ' :: ' + String(body).slice(0, 160))
          err.status = res.status
          throw err
        })
      }
      return res.json()
    })
  }

  // ⚠️ 대화방 목록의 last_log_id 는 19자리(약 3.9e18)라 자바스크립트 안전 정수(9.0e15)를 넘는다.
  //    JSON.parse 로 숫자로 읽으면 값이 512 단위로 반올림되어 커서가 어긋나고, 그러면 페이지가
  //    건너뛰어져 상담이 통째로 누락된다. 그래서 원문 텍스트에서 해당 키만 골라 문자열로 고정한 뒤 파싱한다.
  //    (키 이름을 특정해 바꾸므로 대화 본문 안의 숫자는 건드리지 않는다.)
  var BIGINT_KEYS = /"(last_log_id|last_seen_log_id|user_last_seen_log_id|id|version)":\s*(\d{16,})/g
  function parseKeepingBigIds(text) {
    return JSON.parse(String(text).replace(BIGINT_KEYS, '"$1":"$2"'))
  }

  /** 음이 아닌 정수 문자열 두 개를 크기 비교한다(숫자로 바꾸지 않는다). */
  function cmpBig(a, b) {
    a = String(a); b = String(b)
    if (a.length !== b.length) return a.length < b.length ? -1 : 1
    return a < b ? -1 : (a > b ? 1 : 0)
  }

  /** 대화방 목록 한 페이지. since 를 주면 그보다 과거 것만 온다(내림차순 커서). */
  function fetchChatPage(profileId, since) {
    var qs = '?size=' + CHATS_PAGE + (since ? '&since=' + encodeURIComponent(since) : '')
    return fetch(BASE + '/api/profiles/' + profileId + '/chats/search' + qs, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'content-type': 'application/json',
      },
      body: SEARCH_BODY,
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status + ' chats/search')
        err.status = res.status
        throw err
      }
      return res.text()
    }).then(function (t) {
      var j = parseKeepingBigIds(t)
      return { items: (j && j.items) || [], hasNext: j ? j.has_next : undefined }
    })
  }

  /** 페이지에서 가장 과거 지점(= 다음 페이지를 부를 커서). 최솟값을 쓰므로 건너뜀이 생기지 않는다. */
  function oldestCursor(items) {
    var min = null
    for (var i = 0; i < items.length; i++) {
      var v = items[i] && items[i].last_log_id
      if (v === undefined || v === null || v === '') continue
      var sv = String(v)
      if (min === null || cmpBig(sv, min) < 0) min = sv
    }
    return min
  }

  /** 파트너센터에 로그인되어 있고 권한이 있는지 확인. 실패 사유를 그대로 돌려준다. */
  function checkSession() {
    return kakao('/api/users/me').then(
      function (me) { return { ok: true, email: (me && (me.email || me.id)) || null } },
      function (e) { return { ok: false, status: e.status || null, reason: e.message } }
    )
  }

  // ─────────────────────────── 서버 주고받기 ───────────────────────────
  /** 서버에 저장된 마지막 지점과 백필 진도를 받아온다 — 이걸로 "바뀐 대화방"만 골라낸다. */
  function fetchState(cfg, profileId) {
    var url = cfg.endpoint + '?token=' + encodeURIComponent(cfg.token) +
              '&profile_id=' + encodeURIComponent(profileId)
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('커서 조회 실패 (' + res.status + ')')
      return res.text()
    }).then(function (t) {
      var j = parseKeepingBigIds(t)
      var bf = (j && j.backfill) || {}
      return {
        cursors: (j && j.cursors) || {},
        backfill: { cursor: bf.cursor ? String(bf.cursor) : null, done: bf.done === true },
      }
    })
  }

  function sendToServer(cfg, payload) {
    return fetch(cfg.endpoint + '?token=' + encodeURIComponent(cfg.token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (j) {
        if (!res.ok) throw new Error(j.error || ('저장 실패 (' + res.status + ')'))
        return j
      })
    })
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  // ─────────────────────────── 채널 하나 수집 ───────────────────────────
  async function collectProfile(cfg, profileId) {
    var state = await fetchState(cfg, profileId)
    var cursors = state.cursors
    var backfill = state.backfill

    // 목록은 last_log_id 내림차순이다. 그래서 두 갈래로 훑는다.
    //   A) 첫 페이지 — 새 상담과 방금 바뀐 방은 항상 여기 올라온다.
    //   B) 백필 한 페이지 — 저장된 지점부터 과거로 한 칸 더 내려간다.
    // 목록 API 는 size 를 올려도 100개에서 자르므로, 과거는 이렇게 나눠 받는 수밖에 없다.
    var seen = {}, order = []
    function absorb(items) {
      for (var i = 0; i < items.length; i++) {
        var id = String(items[i].id)
        if (!seen[id]) { seen[id] = items[i]; order.push(id) }
      }
    }

    var top = await fetchChatPage(profileId, null)
    absorb(top.items)

    var bfPage = null, bfSince = null
    if (!backfill.done) {
      bfSince = backfill.cursor || oldestCursor(top.items)
      if (bfSince) {
        await sleep(GAP_MS)
        bfPage = await fetchChatPage(profileId, bfSince)
        absorb(bfPage.items)
      }
    }

    function isChanged(it) {
      var last = it && it.last_log_id ? String(it.last_log_id) : null
      return !!last && cursors[String(it.id)] !== last
    }

    // 첫 페이지는 상한을 둔다(평소 부담을 낮게). 백필 페이지는 전부 처리해야
    // 커서를 그 페이지 끝까지 전진시킬 수 있으므로 상한을 두지 않는다.
    var picked = {}, targets = []
    function want(list) {
      for (var i = 0; i < list.length; i++) {
        var id = String(list[i].id)
        if (!picked[id]) { picked[id] = true; targets.push(list[i]) }
      }
    }
    want(top.items.filter(isChanged).slice(0, MAX_CHANGED_PER_RUN))
    if (bfPage) want(bfPage.items.filter(isChanged))

    var messages = []
    for (var i = 0; i < targets.length; i++) {
      var chatId = String(targets[i].id)
      try {
        var logs = await kakao('/api/profiles/' + profileId + '/chats/' + chatId + '/chatlogs?size=' + LOGS_PAGE)
        var list = (logs && logs.items) || []
        for (var j = 0; j < list.length; j++) messages.push({ chat_id: chatId, log: list[j] })
      } catch (e) {
        // 대화방 하나가 실패해도 나머지는 계속한다. 이 방의 커서는 그대로 두므로 다음 번에 다시 시도된다.
        if (e.status === 401 || e.status === 403) throw e
        console.warn('[수집] 대화 내용 조회 실패', chatId, e.message)
      }
      await sleep(GAP_MS)
    }

    // ⚠️ 바뀐 방을 못 가져왔으면 그 방의 메타(=마지막 메시지 번호)도 보내지 않는다.
    //    보내버리면 서버 커서만 최신이 되어, 다음 실행이 "변경 없음"으로 오판해 그 내용을 영영 놓친다.
    //    원본 시스템에서 이 순서를 어겨 646개 대화방의 메시지가 유실된 적이 있다.
    var gotChat = {}
    messages.forEach(function (m) { gotChat[m.chat_id] = true })
    var chats = order.map(function (id) { return seen[id] }).filter(function (it) {
      var cid = String(it.id)
      return !picked[cid] || gotChat[cid]
    })

    // ⚠️ 백필 커서는 "그 페이지를 실제로 다 받아냈을 때"만 전진시킨다.
    //    한 방이라도 내용을 못 가져왔는데 커서를 넘기면 그 방은 다시 조회되지 않는다.
    //    위의 유실 방지 규칙과 같은 이유다. 커서를 그대로 두면 다음 실행이 같은 페이지를
    //    다시 훑고, 저장은 덮어쓰기라 중복이 생기지 않는다.
    var nextBackfill = { cursor: backfill.cursor, done: backfill.done }
    if (bfPage) {
      if (!bfPage.items.length) {
        nextBackfill = { cursor: bfSince, done: true }        // 더 과거가 없다
      } else {
        var missed = bfPage.items.filter(isChanged).some(function (it) { return !gotChat[String(it.id)] })
        if (!missed) {
          var nx = oldestCursor(bfPage.items)
          var moved = nx && cmpBig(nx, bfSince) < 0
          nextBackfill = moved
            ? { cursor: nx, done: bfPage.hasNext === false }
            : { cursor: bfSince, done: true }                 // 더 내려가지 못하면 끝난 것으로 본다
        }
      }
    }

    var saved = await sendToServer(cfg, {
      profile_id: profileId,
      chats: chats,
      messages: messages,
      backfill: nextBackfill,
    })
    return Object.assign({
      profileId: profileId,
      scanned: order.length,
      changed: targets.length,
      backfilling: !nextBackfill.done,
    }, saved)
  }

  /** 5개 채널을 순서대로 수집. 로그인이 풀렸으면 즉시 멈춘다. */
  async function collectAll(cfg) {
    var session = await checkSession()
    if (!session.ok) return { ok: false, reason: 'login', detail: session.reason, results: [] }

    var results = []
    for (var i = 0; i < PROFILES.length; i++) {
      var p = PROFILES[i]
      try {
        results.push(Object.assign({ label: p.label }, await collectProfile(cfg, p.id)))
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          results.push({ label: p.label, error: '로그인이 풀렸습니다' })
          return { ok: false, reason: 'login', detail: e.message, results: results }
        }
        results.push({ label: p.label, error: e.message })
      }
    }
    return { ok: true, account: session.email, results: results }
  }

  // 테스트에서 쓸 수 있도록 내보낸다(브라우저에서는 쓰지 않는다).
  var api = { PROFILES: PROFILES, checkSession: checkSession, collectProfile: collectProfile, collectAll: collectAll }
  if (typeof window === 'undefined') { globalThis.__sidaeCollect = api; return }

  // ─────────────────────────── 화면(상태 패널) ───────────────────────────
  // 파트너센터 화면의 스타일과 섞이지 않도록 Shadow DOM 안에 그린다.
  if (window.__sidaeCollectPanel) { window.__sidaeCollectPanel.show(); return }

  var host = document.createElement('div')
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647'
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>' +
    ':host,*{box-sizing:border-box}' +
    '.p{width:300px;background:#fff;color:#16202b;border:1px solid #dde2e9;border-radius:10px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.14);font:14px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;overflow:hidden}' +
    '.h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #dde2e9}' +
    '.h b{font-size:13px;font-weight:600;flex:1}' +
    '.x{border:0;background:none;color:#75849a;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}' +
    '.b{padding:12px}' +
    '.bd{font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;display:inline-block;margin-bottom:6px}' +
    '.ok{background:#e4f2ea;color:#1c6340}.wa{background:#fbf1de;color:#8a5600}.cr{background:#fbeae8;color:#a8261d}' +
    '.m{font-weight:500}.w{font-size:12px;color:#75849a;margin-top:4px}' +
    '.rows{margin-top:10px;border:1px solid #dde2e9;border-radius:7px;overflow:hidden}' +
    '.r{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;border-top:1px solid #dde2e9;font-size:13px}' +
    '.r:first-child{border-top:0}.r .n{color:#47566a}.r .v{font-variant-numeric:tabular-nums}' +
    '.r .z{color:#75849a}.r .e{color:#a8261d}' +
    '.btn{width:100%;margin-top:10px;padding:8px;border:1px solid #dde2e9;border-radius:7px;background:#fff;' +
    'color:#16202b;font:inherit;font-size:13px;cursor:pointer}' +
    '.btn:disabled{opacity:.55;cursor:default}' +
    '</style>' +
    '<div class="p"><div class="h"><b>시대인재 상담 수집</b><button class="x" title="닫기">&times;</button></div>' +
    '<div class="b"><span class="bd wa" id="bd">확인 중</span><div class="m" id="m">시작하는 중입니다</div>' +
    '<div class="w" id="w"></div><div class="rows" id="rows" hidden></div>' +
    '<button class="btn" id="run">지금 수집</button></div></div>'

  var $ = function (id) { return root.getElementById(id) }
  var timer = null
  var busy = false

  function badge(cls, text) { $('bd').className = 'bd ' + cls; $('bd').textContent = text }

  function paint(state, msg, sub, results) {
    var map = { ok: ['ok', '정상'], run: ['wa', '수집 중'], login: ['cr', '로그인 필요'], err: ['cr', '오류'], cfg: ['wa', '설정 필요'] }
    var b = map[state] || map.err
    badge(b[0], b[1])
    $('m').textContent = msg || ''
    $('w').textContent = sub || ''
    var rows = $('rows')
    rows.textContent = ''
    if (results && results.length) {
      results.forEach(function (r) {
        var d = document.createElement('div'); d.className = 'r'
        var n = document.createElement('span'); n.className = 'n'; n.textContent = r.label || r.profileId || ''
        var v = document.createElement('span'); v.className = 'v'
        if (r.error) { v.className += ' e'; v.textContent = r.error }
        else if (r.messages > 0) { v.textContent = Number(r.messages).toLocaleString('ko-KR') + '건' }
        else { v.className += ' z'; v.textContent = '새 내용 없음' }
        d.appendChild(n); d.appendChild(v); rows.appendChild(d)
      })
      rows.hidden = false
    } else { rows.hidden = true }
  }

  function stamp() { return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) }

  async function run(cfg) {
    if (busy) return
    busy = true
    $('run').disabled = true
    paint('run', '읽는 중입니다. 이 탭을 닫지 마세요.', '')
    try {
      var out = await collectAll(cfg)
      if (!out.ok && out.reason === 'login') {
        paint('login', '파트너센터 로그인이 풀렸습니다.', '이 탭에서 다시 로그인한 뒤 "지금 수집"을 누르세요.', out.results)
      } else {
        var total = out.results.reduce(function (a, r) { return a + (r.messages || 0) }, 0)
        paint('ok', total > 0 ? total.toLocaleString('ko-KR') + '건 저장했습니다' : '새로 들어온 상담이 없습니다',
              stamp() + ' 기준' + (out.account ? ' · ' + out.account : ''), out.results)
      }
    } catch (e) {
      paint('err', String(e && e.message ? e.message : e), stamp() + ' 기준')
    } finally {
      busy = false
      $('run').disabled = false
    }
  }

  function stop() { if (timer) { clearInterval(timer); timer = null } }

  window.__sidaeCollectPanel = {
    show: function () { host.style.display = 'block' },
    stop: stop,
  }

  root.querySelector('.x').addEventListener('click', function () { stop(); host.remove(); delete window.__sidaeCollectPanel })

  document.documentElement.appendChild(host)

  if (location.hostname !== 'business.kakao.com') {
    paint('err', '카카오 파트너센터 화면에서 눌러야 합니다.', 'business.kakao.com 을 연 뒤 다시 시도하세요.')
    return
  }

  var cfg = loadConfig()
  if (!cfg) {
    paint('cfg', '연결 정보가 없습니다.', '관리자에게 받은 북마크(주소에 수집 키가 포함된 것)를 사용하세요.')
    $('run').disabled = true
    return
  }

  $('run').addEventListener('click', function () { run(cfg) })
  run(cfg)
  timer = setInterval(function () { run(cfg) }, INTERVAL_MS)
})()
