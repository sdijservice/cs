// supabase/functions/kakao-ingest/index.ts
// 사내 직원 브라우저가 모아 보낸 카카오 상담 내용을 받아 저장한다.
//
// 왜 이런 구조인가
//   카카오는 상담 대화를 내보내는 공식 방법을 제공하지 않는다. 그래서 사람이 로그인한
//   브라우저 세션을 빌려 읽는 수밖에 없는데, 예전 방식은 그 세션을 특정 개인의 맥북에서
//   꺼내 썼다. 담당자가 자리를 비우거나 퇴사하면 수집이 멈춘다.
//   이제는 파트너센터에 로그인된 사내 직원 누구의 브라우저든 북마크 하나로 읽어 이리로 보낸다
//   (사내 보안 정책상 확장 프로그램은 설치할 수 없어 북마크 방식을 쓴다 - public/kakao-collect.js).
//   출근한 사람이 한 명이라도 있으면 수집이 돌아간다.
//
// 왜 마스킹을 여기서 하는가
//   보내는 쪽은 직원 PC 에서 돈다. 거기서 거른 결과를 믿으면, 그 코드가 낡거나 조작됐을 때
//   원문이 그대로 들어온다. 개인정보를 가리는 일은 반드시 서버에서 한 번 더 한다.
//   보내는 쪽은 "가져오는 일"만 하고, "무엇을 저장할지"는 이 함수가 정한다.
//
// 인증: kakao_partner_secrets.key='kakao_ingest_token' 과 ?token= 비교.
//   이 토큰은 북마크 주소에 들어가므로 유출 가능성을 전제한다. 그래서 할 수 있는 일이
//   "상담 데이터 넣기"뿐이도록 막았다(읽기·삭제·다른 표 접근 없음).
//   배포: verify_jwt=false (수집하는 브라우저는 Supabase 로그인 세션을 갖지 않는다).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 수집 대상 채널. 보내온 profile_id 가 이 목록에 없으면 통째로 거절한다.
const ALLOWED_PROFILES = new Set(['_VGAQn', '_rcpPG', '_TkpPG', '_xfxilXn', '_rkbcn']);
const MAX_MESSAGES_PER_CALL = 3000;
const MAX_CHATS_PER_CALL = 500;

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

// 카카오 파트너센터 화면(다른 출처)에서 부르므로 CORS 가 필요하다. 이게 없으면 브라우저가 요청 자체를 막는다.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

// ───────────────────── PII 마스킹 (sdij-wiki kakao-collect 와 동일 규칙) ─────────────────────
const NAME_LABELS = '회원명|가입자명|학생명|학생이름|학부모명|학부모이름|보호자명|자녀명|성함|이름';
const CARD_RE = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;
const RRN_RE = /\b\d{6}[-\s]?[1-8]\d{6}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const MOBILE_RE = /(01[016-9])[-.\s]?(\d{3,4})[-.\s]?(\d{4})/g;
const INTL_MOBILE_RE = /(\+82[-.\s]?1[016-9])[-.\s]?(\d{3,4})[-.\s]?(\d{4})/g;
const LANDLINE_RE = /(0\d{1,3})[-.\s](\d{3,4})[-.\s](\d{4})/g;
const LABEL_NAME_RE = new RegExp('(' + NAME_LABELS + ')(\\s*[:：]\\s*)([가-힣*]{1,4})', 'g');
const HAS_PHONE_OR_EMAIL_RE = /(01[016-9][-.\s]?\d{3,4}[-.\s]?\d{4})|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const STANDALONE_NAME_RE = /(^|\n)[ \t]*([가-힣]{2,4})[ \t]*(?=\r?\n|$)/g;
const NON_NAME_BEFORE_PHONE = new Set([
  '연락처', '전화번호', '휴대폰', '휴대전화', '핸드폰', '연락', '번호',
  '문의', '접수', '상담', '아래', '여기', '이쪽', '저쪽', '카톡', '팀',
]);
const INLINE_NAME_BEFORE_PHONE_RE =
  /(^|[\s,.\n])([가-힣]{2,4})(?=\s*(?:01[016-9][-.\s]?\d{3,4}[-.\s]?\d{4}|0\d{1,3}[-.\s]\d{3,4}[-.\s]\d{4}))/g;

function stripLoneSurrogates(s: unknown) {
  if (s == null) return s;
  return String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
function isNonNameBeforePhone(name: string) {
  for (const w of NON_NAME_BEFORE_PHONE) if (name.startsWith(w)) return true;
  return false;
}
function maskName(name: unknown) {
  if (name == null) return name;
  const s = String(name).trim();
  if (!s) return s;
  const ch = [...s];
  if (ch.length === 1) return '*';
  if (ch.length === 2) return ch[0] + '*';
  return ch[0] + '*'.repeat(ch.length - 2) + ch[ch.length - 1];
}
function maskBody(text: unknown) {
  if (text == null) return text;
  let s = String(text);
  const formLike = HAS_PHONE_OR_EMAIL_RE.test(s);
  s = s.replace(CARD_RE, '[카드번호]');
  s = s.replace(RRN_RE, '[주민번호]');
  s = s.replace(EMAIL_RE, '***@$1');
  s = s.replace(INLINE_NAME_BEFORE_PHONE_RE, (m, pre, name) =>
    isNonNameBeforePhone(name) ? m : pre + maskName(name));
  s = s.replace(INTL_MOBILE_RE, '$1-****-$3');
  s = s.replace(MOBILE_RE, '$1-****-$3');
  s = s.replace(LANDLINE_RE, '$1-****-$3');
  s = s.replace(LABEL_NAME_RE, (_m, label, sep, name) => label + sep + maskName(name));
  if (formLike) s = s.replace(STANDALONE_NAME_RE, (_m, pre, name) => pre + maskName(name));
  return s;
}

// ───────────────────── 카카오 원본 → 우리 표 모양 ─────────────────────
// 보내온 값을 그대로 믿지 않는다. 필요한 필드만 뽑아 형식을 강제한다.
function chatToRow(item: any, profileId: string) {
  const u = item?.talk_user ?? {};
  return {
    chat_id: String(item?.id ?? ''),
    profile_id: profileId,
    user_id: u.id ? String(u.id) : null,
    nickname: stripLoneSurrogates(maskName(u.nickname || null)),
    profile_image_url: null,                 // 프로필 사진은 저장하지 않는다(불필요한 개인정보)
    user_type: Number(u.user_type ?? 0) || 0,
    last_log_id: item?.last_log_id ? String(item.last_log_id) : null,
    last_message: stripLoneSurrogates(maskBody(item?.last_message ?? null)),
    last_log_send_at: item?.last_log_send_at ? new Date(item.last_log_send_at).toISOString() : null,
    is_read: !!item?.is_read,
    is_done: !!item?.is_done,
    is_blocked: !!item?.is_blocked,
    is_starred: !!item?.is_starred,
    is_deleted: !!item?.is_deleted,
    unread_count: Number(item?.unread_count ?? 0) || 0,
    assignee_id: Number(item?.assignee_id ?? 0) || 0,
    raw: null,                               // 원본 통째 저장 금지 — 가리지 않은 값이 섞여 들어온다
    remote_version: item?.version ?? null,
  };
}
function logToRow(item: any, chatId: string, profileId: string) {
  const isManager = !!item?.manager;
  const author = item?.author ?? {};
  const senderType = isManager ? 'manager' : (author.user_type === 0 ? 'user' : 'system');
  const senderId = isManager ? String(item?.manager?.id ?? '') : String(author.id ?? '');
  return {
    log_id: String(item?.id ?? ''),
    chat_id: String(chatId),
    profile_id: profileId,
    sender_type: senderType,
    sender_id: senderId || null,
    message: stripLoneSurrogates(maskBody(item?.message ?? item?.text ?? item?.content ?? null)),
    message_type: item?.type != null ? String(item.type) : null,
    attachments: item?.attachment && Object.keys(item.attachment).length ? item.attachment : null,
    sent_at: item?.send_at ? new Date(item.send_at).toISOString()
      : item?.created_at ? new Date(item.created_at).toISOString() : new Date().toISOString(),
    // 화면이 담당자 이름을 raw->manager->>name 으로 읽으므로 그 한 조각만 남긴다.
    raw: item?.manager ? { manager: { name: item.manager?.name ?? null, id: item.manager?.id ?? null } } : null,
    ingested_at: new Date().toISOString(),
    source: 'bookmarklet',
  };
}

async function getSecret(key: string): Promise<string | null> {
  const { data } = await supabase.from('kakao_partner_secrets').select('value').eq('key', key).maybeSingle();
  return (data as any)?.value ?? null;
}

// 수집하는 쪽이 "무엇이 바뀌었는지" 판단하려면 마지막으로 저장된 지점을 알아야 한다.
async function cursorsFor(profileId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let from = 0;
  for (let page = 0; page < 100000; page++) {
    const { data, error } = await supabase
      .from('kakao_partner_chats').select('chat_id, last_log_id')
      .eq('profile_id', profileId).order('chat_id', { ascending: true })
      .range(from, from + 999);
    if (error) { log('cursor read fail', profileId, error.message); break; }
    if (!data || !data.length) break;
    for (const r of data as any[]) if (r.last_log_id) out[String(r.chat_id)] = String(r.last_log_id);
    // 실제로 받은 만큼만 전진한다(서버가 요청보다 적게 줄 수 있다 — csvExport.js 주석 참고).
    from += data.length;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') || '';
    const expected = await getSecret('kakao_ingest_token');
    if (!expected || token !== expected) return json({ error: 'unauthorized' }, 401);

    // 1) 수집을 시작할 때: 어디까지 저장돼 있는지 알려준다.
    if (req.method === 'GET') {
      const pid = url.searchParams.get('profile_id') || '';
      if (!ALLOWED_PROFILES.has(pid)) return json({ error: 'unknown profile_id' }, 400);
      return json({ profile_id: pid, cursors: await cursorsFor(pid) });
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    // 2) 수집 결과 저장
    const body = await req.json().catch(() => null);
    const profileId = String(body?.profile_id ?? '');
    if (!ALLOWED_PROFILES.has(profileId)) return json({ error: 'unknown profile_id' }, 400);

    const chats = Array.isArray(body?.chats) ? body.chats.slice(0, MAX_CHATS_PER_CALL) : [];
    const msgs = Array.isArray(body?.messages) ? body.messages.slice(0, MAX_MESSAGES_PER_CALL) : [];

    // ★★ 순서가 곧 데이터 안전이다. 메시지 먼저, 대화방 나중. 절대 바꾸지 말 것.
    //
    //    대화방 행에는 last_log_id("여기까지 받았다" 표시)가 들어 있고, 다음 수집은 그 값을 보고
    //    "바뀐 게 없다"고 판단한다. 그래서 대화방을 먼저 저장한 뒤 메시지 저장이 실패하면,
    //    표시만 최신이 되어 그 상담을 영영 다시 가져오지 않는다.
    //    (원본 시스템에서 이 구조로 646개 대화방의 메시지가 영구 유실됐다.)
    //
    //    메시지를 먼저 넣으면 최악의 경우가 뒤집힌다.
    //      - 메시지 실패 → 대화방을 아예 안 씀 → 표시 그대로 → 다음 번에 다시 가져온다 (안전)
    //      - 메시지 성공, 대화방 실패 → 표시가 안 올라감 → 다음 번에 또 보냄 → 덮어쓰기라 무해
    //    이 순서가 가능한 이유는 messages.chat_id 에 외래키를 걸지 않았기 때문이다
    //    (설치 SQL 0001 의 해당 주석 참고). 외래키를 다시 걸면 이 순서가 깨지므로 함께 검토할 것.
    let messagesSaved = 0;
    if (msgs.length) {
      const rows = msgs
        .map((m: any) => logToRow(m.log ?? m, String(m.chat_id ?? m?.chatId ?? ''), profileId))
        .filter((r) => r.log_id && r.chat_id);
      // 500건씩 나눠 넣는다(한 번에 다 넣으면 요청이 커져 실패한다).
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const { error } = await supabase.from('kakao_partner_messages').upsert(slice, { onConflict: 'log_id' });
        if (error) return json({ error: 'messages upsert: ' + error.message, saved: messagesSaved }, 500);
        messagesSaved += slice.length;
      }
    }

    let chatsSaved = 0;
    if (chats.length) {
      const rows = chats.map((c: any) => chatToRow(c, profileId)).filter((r) => r.chat_id);
      const { error } = await supabase.from('kakao_partner_chats').upsert(rows, { onConflict: 'chat_id' });
      if (error) return json({ error: 'chats upsert: ' + error.message, messages: messagesSaved }, 500);
      chatsSaved = rows.length;
    }

    // 누가·언제 넣었는지 기록해 "지금 수집이 살아 있나"를 화면에서 볼 수 있게 한다.
    await supabase.from('kakao_partner_stream_state').upsert(
      { profile_id: profileId, last_heartbeat_at: new Date().toISOString(), last_error: null },
      { onConflict: 'profile_id' },
    ).then(({ error }) => { if (error) log('heartbeat fail', error.message); });

    log(`ingest ${profileId}: chats=${chatsSaved} messages=${messagesSaved}`);
    return json({ ok: true, profile_id: profileId, chats: chatsSaved, messages: messagesSaved });
  } catch (e) {
    log('unhandled', String((e as Error)?.message ?? e));
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
