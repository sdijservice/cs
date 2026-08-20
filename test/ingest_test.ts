// kakao-ingest 함수를 실제 Deno 에서 돌려 확인한다.
//
// 실행: deno test --allow-env --allow-net test/ingest_test.ts
//
// 방식: supabase-js 가 밖으로 내보내는 HTTP 요청을 가로채, 함수가 "무엇을 저장하려 했는지"를
// 그대로 잡아낸다. 저장될 행은 /tmp/ingest_rows.json 으로 떨궈, 다음 단계에서 실제
// PostgreSQL 스키마에 그대로 넣어 본다(컬럼이 맞는지까지 확인하기 위해).
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const BASE = 'https://fake.supabase.co';
Deno.env.set('SUPABASE_URL', BASE);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');

const TOKEN = 'testtoken1234';

type Captured = { table: string; method: string; body: unknown };
const captured: Captured[] = [];
let storedChats: Array<Record<string, unknown>> = [];
let failTable: string | null = null;   // 이 표의 저장을 일부러 실패시킨다

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (!url.startsWith(BASE)) return realFetch(input as never, init);

  const path = new URL(url).pathname.replace('/rest/v1/', '');
  const table = path.split('?')[0];
  const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
  const body = typeof raw === 'string' && raw ? JSON.parse(raw) : null;

  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'content-range': '0-0/*' },
    });

  if (table === 'kakao_partner_secrets' && method === 'GET') {
    return reply([{ value: TOKEN }]);
  }
  if (table === 'kakao_partner_chats' && method === 'GET') {
    return reply(storedChats.map((c) => ({ chat_id: c.chat_id, last_log_id: c.last_log_id })));
  }
  captured.push({ table, method, body });
  if (table === failTable) {
    return reply({ message: '일부러 낸 오류', code: 'XXXXX' }, 500);
  }
  if (table === 'kakao_partner_chats' && method === 'POST') {
    storedChats = body as Array<Record<string, unknown>>;
  }
  return reply([]);
}) as typeof fetch;

// Deno.serve 를 가로채 핸들러만 꺼내 온다(포트를 열지 않는다).
let handler!: (req: Request) => Promise<Response>;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };

await import('../supabase/functions/kakao-ingest/index.ts');
assert(handler, 'kakao-ingest 가 핸들러를 등록하지 않았습니다');

const post = (body: unknown, token = TOKEN) =>
  handler(new Request(`https://x/functions/v1/kakao-ingest?token=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

Deno.test('틀린 키는 거절한다', async () => {
  const res = await post({ profile_id: '_VGAQn', chats: [], messages: [] }, 'wrong');
  assertEquals(res.status, 401);
});

Deno.test('목록에 없는 채널은 거절한다', async () => {
  const res = await post({ profile_id: '_HACKER', chats: [{ id: 1 }], messages: [] });
  assertEquals(res.status, 400);
});

Deno.test('CORS 사전요청에 응답한다', async () => {
  const res = await handler(new Request('https://x/functions/v1/kakao-ingest', { method: 'OPTIONS' }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
});

Deno.test('★ 개인정보를 가리고, 메시지를 대화방보다 먼저 저장한다', async () => {
  captured.length = 0;
  const res = await post({
    profile_id: '_VGAQn',
    chats: [{
      id: 111, last_log_id: 'L9', last_message: '연락처는 010-1234-5678 입니다',
      talk_user: { id: 'u1', nickname: '김철수', user_type: 0 },
      last_log_send_at: 1787000000000,
    }],
    messages: [{
      chat_id: '111',
      log: {
        id: 'g1', send_at: 1787000000000,
        message: '학생명: 김철수 / 010-9876-5432 / a@b.com / 1234-5678-9012-3456 / 990101-1234567',
        author: { id: 'u1', user_type: 0 },
      },
    }],
  });
  assertEquals(res.status, 200);
  const out = await res.json();
  assertEquals(out.ok, true);
  assertEquals(out.chats, 1);
  assertEquals(out.messages, 1);

  const order = captured.filter((c) => c.method === 'POST').map((c) => c.table);
  assertEquals(order[0], 'kakao_partner_messages', '메시지가 먼저 저장돼야 한다(유실 방지)');
  assert(order.indexOf('kakao_partner_chats') > 0, '대화방은 메시지 뒤여야 한다');

  const chatRow = (captured.find((c) => c.table === 'kakao_partner_chats')!.body as never[])[0] as Record<string, unknown>;
  const msgRow = (captured.find((c) => c.table === 'kakao_partner_messages')!.body as never[])[0] as Record<string, unknown>;

  assertEquals(chatRow.nickname, '김*수', '닉네임이 가려져야 한다');
  assertEquals(chatRow.raw, null, '원본을 통째로 저장하면 안 된다');
  assert(!String(chatRow.last_message).includes('1234-5678'), '대화방 미리보기의 전화번호가 남았다');

  const m = String(msgRow.message);
  for (const leak of ['9876-5432', 'a@b.com', '5678-9012', '990101-1234567']) {
    assert(!m.includes(leak), `개인정보가 그대로 남았다: ${leak}`);
  }
  assertEquals(msgRow.source, 'bookmarklet');

  await Deno.writeTextFile('/var/tmp/ingest_rows.json', JSON.stringify({ chatRow, msgRow }, null, 2));
});

Deno.test('★★ 메시지 저장이 실패하면 "여기까지 받았다" 표시를 올리지 않는다 (영구 유실 방지)', async () => {
  // 이 검사가 깨지면 그 상담은 다음 수집에서 "변경 없음"으로 판정돼 영영 사라진다.
  // 원본 시스템에서 646개 대화방이 이 구조로 유실됐다.
  captured.length = 0;
  storedChats = [];
  failTable = 'kakao_partner_messages';

  const res = await post({
    profile_id: '_VGAQn',
    chats: [{ id: 222, last_log_id: 'L99', talk_user: { id: 'u2', nickname: '이영희' } }],
    messages: [{ chat_id: '222', log: { id: 'g2', message: '중요한 문의', send_at: 1787000000000 } }],
  });
  failTable = null;

  assertEquals(res.status, 500, '실패를 감춰서는 안 된다');
  const wrote = captured.filter((c) => c.method === 'POST').map((c) => c.table);
  assert(
    !wrote.includes('kakao_partner_chats'),
    '메시지가 실패했는데 대화방(=여기까지 받았다 표시)을 저장했다. 그 상담은 영영 유실된다.',
  );
  assertEquals(storedChats.length, 0, '커서가 전진하면 안 된다');
});

Deno.test('대화방 저장이 실패해도 메시지는 남고, 다음 번에 다시 보내진다', async () => {
  captured.length = 0;
  storedChats = [];
  failTable = 'kakao_partner_chats';

  const res = await post({
    profile_id: '_VGAQn',
    chats: [{ id: 333, last_log_id: 'L7', talk_user: { id: 'u3', nickname: '박민수' } }],
    messages: [{ chat_id: '333', log: { id: 'g3', message: '문의합니다', send_at: 1787000000000 } }],
  });
  failTable = null;

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.messages, 1, '메시지는 이미 저장됐음을 알려야 한다');
  assertEquals(storedChats.length, 0, '커서가 전진하지 않아 다음 번에 다시 보내진다(덮어쓰기라 무해)');
});

Deno.test('저장에 성공하면 수집 상태를 남긴다 (장애를 눈치챌 수 있게)', async () => {
  captured.length = 0;
  const res = await post({
    profile_id: '_rcpPG',
    chats: [{ id: 444, last_log_id: 'L1', talk_user: { id: 'u4', nickname: '정수민' } }],
    messages: [{ chat_id: '444', log: { id: 'g4', message: '안녕하세요', send_at: 1787000000000 } }],
  });
  assertEquals(res.status, 200);
  const tables = captured.filter((c) => c.method === 'POST').map((c) => c.table);
  assert(tables.includes('kakao_partner_stream_state'), '수집 상태를 기록하지 않았다');
});

// ─────────────────────────────────────────────────────────────────────────────
// 대화방 목록 백필 진도
// ─────────────────────────────────────────────────────────────────────────────
// 목록 API 는 한 번에 100개까지만 준다. 과거 대화방은 since 커서로 나눠 받아야 하는데,
// "어디까지 팠는지"를 여기 기록한다. 이 값이 실제로 저장한 것보다 앞서 나가면
// 그 구간은 다시 조회되지 않는다 — 위의 유실 방지와 같은 종류의 사고다.

/** stream_state 에 쓰인 내용을 꺼낸다(단건이든 배열이든 받아준다). */
function stateWrites(): Array<Record<string, unknown>> {
  return captured
    .filter((c) => c.table === 'kakao_partner_stream_state' && c.method === 'POST')
    .flatMap((c) => (Array.isArray(c.body) ? c.body : [c.body]) as Array<Record<string, unknown>>);
}

Deno.test('저장에 성공하면 백필 진도를 기록한다', async () => {
  captured.length = 0;
  storedChats = [];

  const res = await post({
    profile_id: '_VGAQn',
    chats: [{ id: 777, last_log_id: '3211262568056639007', talk_user: { id: 'u7', nickname: '최지우' } }],
    messages: [{ chat_id: '777', log: { id: 'g7', message: '문의드립니다', send_at: 1787000000000 } }],
    backfill: { cursor: '3211262568056638001', done: false },
  });

  assertEquals(res.status, 200);
  const w = stateWrites();
  assertEquals(w.length, 1);
  assertEquals(w[0].backfill_cursor, '3211262568056638001', '19자리 그대로 저장돼야 한다');
  assertEquals(w[0].backfill_done, false);
});

Deno.test('★★ 메시지 저장이 실패하면 백필 진도도 올리지 않는다 (영구 유실 방지)', async () => {
  // 진도만 앞서 나가면 그 구간의 상담은 다시 조회되지 않는다.
  captured.length = 0;
  storedChats = [];
  failTable = 'kakao_partner_messages';

  const res = await post({
    profile_id: '_VGAQn',
    chats: [{ id: 888, last_log_id: '3211262568056639008', talk_user: { id: 'u8', nickname: '정하늘' } }],
    messages: [{ chat_id: '888', log: { id: 'g8', message: '중요한 문의', send_at: 1787000000000 } }],
    backfill: { cursor: '3211262568056638001', done: true },
  });
  failTable = null;

  assertEquals(res.status, 500);
  assertEquals(stateWrites().length, 0, '저장이 실패했는데 진도를 올리면 그 구간이 영영 빠진다');
});

Deno.test('커서가 숫자 형식이 아니면 무시한다', async () => {
  captured.length = 0;
  storedChats = [];

  await post({
    profile_id: '_VGAQn',
    chats: [],
    messages: [],
    backfill: { cursor: 'DROP TABLE', done: false },
  });

  const w = stateWrites();
  assertEquals(w.length, 1);
  assertEquals(w[0].backfill_cursor, undefined, '이상한 값은 저장하지 않는다');
  assertEquals(w[0].backfill_done, false, 'done 은 정상값이므로 반영한다');
});

Deno.test('수집 시작 시 백필 진도를 알려준다', async () => {
  captured.length = 0;
  const res = await handler(new Request(
    `https://x/functions/v1/kakao-ingest?token=${TOKEN}&profile_id=_VGAQn`,
  ));
  assertEquals(res.status, 200);
  const j = await res.json();
  assert('backfill' in j, '수집기가 이어받을 지점을 알 수 없다');
  assertEquals(j.backfill.done, false);
});
