-- supabase/migrations/0001_init_viewer_schema.sql
--
-- 이 앱(카카오 상담·잔디 대화 조회)이 읽는 표 3개와 접근 규칙을 새 Supabase 프로젝트에 만든다.
-- 원본(sdij-wiki, 개인 계정 프로젝트 bnszzjaupayakkahmwsu)의 실제 구조를 그대로 옮긴 것이다.
--
-- 실행 방법 (둘 중 하나)
--   A. Supabase 대시보드 > SQL Editor 에 이 파일 내용을 붙여넣고 Run.
--   B. supabase CLI: supabase db push
--
-- 안전성: 전부 IF NOT EXISTS 라 여러 번 실행해도 문제없다(멱등).
--
-- ⚠️ 이 파일은 "표를 만드는 것"까지만 한다. 표를 실제 데이터로 채우는 수집 코드는
--    아직 이 저장소에 없다(README 의 "아직 안 된 것" 참고). 표만 만들면 화면은 비어 있다.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. 카카오 상담 대화방
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kakao_partner_chats (
  chat_id                text primary key,
  profile_id             text not null,          -- 채널 구분자 (_VGAQn 마이클래스 등)
  user_id                text,
  nickname               text,                   -- 화면에서 마스킹해 표시(maskPII)
  profile_image_url      text,
  user_type              integer default 0,
  last_log_id            text,                   -- 수집기의 변경감지 커서
  last_message           text,
  last_log_send_at       timestamptz,
  is_read                boolean default false,
  is_done                boolean default false,
  is_blocked             boolean default false,
  is_starred             boolean default false,
  is_deleted             boolean default false,
  unread_count           integer default 0,
  assignee_id            bigint  default 0,
  raw                    jsonb,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  remote_version         bigint,
  -- 아래 4개는 분석용(문의 카테고리 자동분류). 이 조회 앱은 안 쓰지만, 나중에 분석 기능을
  -- 붙일 때 스키마가 어긋나지 않도록 원본과 동일하게 만들어 둔다.
  category               text,
  category_confidence    numeric,
  category_classified_at timestamptz,
  category_model         text
);

-- 채널별 최신순 목록 조회용(이 앱의 주 질의 경로)
create index if not exists idx_kakao_partner_chats_profile
  on public.kakao_partner_chats (profile_id, last_log_send_at desc);
-- 닉네임 맵 적재(채널의 전체 대화방을 chat_id 순으로 훑음)
create index if not exists idx_kakao_partner_chats_profile_chatid
  on public.kakao_partner_chats (profile_id, chat_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. 카카오 상담 메시지
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.kakao_partner_messages (
  log_id                  text primary key,
  chat_id                 text not null,
  profile_id              text not null,
  sender_type             text,                  -- 'user' | 'manager' | 'system'
  sender_id               text,
  message                 text,                  -- 적재 시 PII 마스킹된 본문
  message_type            text,
  attachments             jsonb,
  sent_at                 timestamptz,
  raw                     jsonb,                 -- 담당자명은 raw->manager->>name 으로 읽는다
  ingested_at             timestamptz default now(),
  source                  text not null default 'partner-api',
  -- 아래 4개는 분석용(감정 분류). 위와 같은 이유로 함께 만들어 둔다.
  sentiment               text,
  sentiment_score         numeric,
  sentiment_classified_at timestamptz,
  sentiment_model         text
);

-- ⚠️ chat_id 에 외래키(FK)를 일부러 걸지 않았다.
--    원본 시스템에는 FK 가 있었고, 그 때문에 "처음 보는 대화방의 메시지를 먼저 넣으면 그 묶음이
--    통째로 실패 → 커서만 최신이 되어 영구 유실"이라는 사고가 났다(646개 대화방).
--    FK 가 없으면 최악의 경우 대화방 정보가 없는 메시지가 남을 뿐이고(닉네임이 빈칸으로 보임),
--    FK 가 있으면 최악의 경우 메시지가 영구히 사라진다. 유실이 더 나쁘므로 FK 를 걸지 않는다.
--    (수집기와 kakao-ingest 는 그와 별개로 "대화방 먼저, 메시지 나중" 순서를 지킨다.)

-- ⚠️ 이 두 색인이 없으면 화면 조회와 CSV 다운로드가 타임아웃난다. 원본에서 실제로 겪은 사고다
--    (색인이 안 맞아 조회 하나가 20초까지 걸려 화면에 500 오류가 났다).
create index if not exists idx_kakao_partner_messages_profile_time
  on public.kakao_partner_messages (profile_id, sent_at desc);
create index if not exists idx_kakao_partner_messages_chat_time
  on public.kakao_partner_messages (chat_id, sent_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. 잔디 대화
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.jandi_messages (
  room_id             text not null,             -- 방 구분자
  link_id             text not null,             -- 방 안에서의 고유 번호
  message_id          text,
  team_id             text not null,
  writer_id           text,
  writer_name         text,
  content_type        text,
  message             text,
  attachments         jsonb,
  created_at          timestamptz,
  raw                 jsonb,
  ingested_at         timestamptz default now(),
  source              text not null default 'rest',
  reply_to_message_id text,                      -- 값이 있으면 댓글(원글 아래로 묶임)
  primary key (room_id, link_id)
);

create index if not exists idx_jandi_messages_room_time
  on public.jandi_messages (room_id, created_at desc);
create index if not exists idx_jandi_messages_team_time
  on public.jandi_messages (team_id, created_at desc);
create index if not exists idx_jandi_messages_reply_to
  on public.jandi_messages (reply_to_message_id) where reply_to_message_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3-1. 수집 상태 (지금 수집이 살아 있나)
-- ─────────────────────────────────────────────────────────────────────────────
-- kakao-ingest 가 저장에 성공할 때마다 여기에 시각을 남긴다. 이 표가 없으면 함수는 그냥
-- 조용히 넘어가므로 수집은 되지만 "언제 마지막으로 들어왔는지"를 알 방법이 사라진다.
-- 장애를 눈치채지 못하는 것이 이 시스템의 가장 큰 위험이라 반드시 함께 만든다.

create table if not exists public.kakao_partner_stream_state (
  profile_id        text primary key,
  last_heartbeat_at timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  total_messages    bigint default 0
);

alter table public.kakao_partner_stream_state enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='kakao_partner_stream_state' and policyname='auth_read_stream_state') then
    create policy "auth_read_stream_state" on public.kakao_partner_stream_state
      for select to authenticated
      using (((select (auth.jwt() ->> 'is_anonymous'))::boolean) is not true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3-2. 수집 키 보관함
-- ─────────────────────────────────────────────────────────────────────────────
-- 카카오 수집(kakao-ingest 함수)이 "누가 보낸 것인지" 확인하는 데 쓰는 키를 여기 둔다.
-- 이 표는 절대 브라우저에서 읽히면 안 된다 → RLS 를 켜고 정책은 하나도 만들지 않는다.
-- 정책이 없으면 공개 키로는 아무것도 못 읽는다. 서버 함수는 service_role 로 동작해
-- RLS 를 우회하므로 정상적으로 읽는다.

create table if not exists public.kakao_partner_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.kakao_partner_secrets enable row level security;
-- (정책 없음이 의도된 설계다. 여기에 select 정책을 추가하면 키가 그대로 유출된다.)

-- 수집 키를 자동으로 만들어 둔다. 이미 있으면 그대로 둔다(다시 실행해도 안전).
create extension if not exists pgcrypto with schema extensions;

insert into public.kakao_partner_secrets (key, value)
values ('kakao_ingest_token', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. 접근 규칙 (RLS = Row Level Security, 누가 어떤 행을 볼 수 있는지 정하는 규칙)
-- ─────────────────────────────────────────────────────────────────────────────
-- ★★ 이 부분을 빼먹으면 안 된다. 이 앱은 브라우저에서 공개 키(anon key)로 표를 직접 읽는다.
--    공개 키는 웹사이트 소스에 그대로 들어있어 누구나 볼 수 있는 값이다. 따라서 실제 보호는
--    전적으로 아래 RLS 규칙에 달려 있다. RLS 를 켜지 않으면 로그인 없이 아무나 전체 상담
--    내용을 가져갈 수 있다.
--
--    규칙 내용: "로그인한 계정이면 읽기 허용, 단 익명 로그인은 제외."
--    쓰기(insert/update/delete) 정책은 일부러 만들지 않는다 → 브라우저에서는 읽기만 가능하다.
--    수집기는 service_role 키로 동작하므로 RLS 를 우회해 정상적으로 쓸 수 있다.

alter table public.kakao_partner_chats    enable row level security;
alter table public.kakao_partner_messages enable row level security;
alter table public.jandi_messages         enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='kakao_partner_chats' and policyname='auth_read_chats') then
    create policy "auth_read_chats" on public.kakao_partner_chats
      for select to authenticated
      using (((select (auth.jwt() ->> 'is_anonymous'))::boolean) is not true);
  end if;

  if not exists (select 1 from pg_policies where tablename='kakao_partner_messages' and policyname='auth_read_messages') then
    create policy "auth_read_messages" on public.kakao_partner_messages
      for select to authenticated
      using (((select (auth.jwt() ->> 'is_anonymous'))::boolean) is not true);
  end if;

  if not exists (select 1 from pg_policies where tablename='jandi_messages' and policyname='auth_read_jandi_messages') then
    create policy "auth_read_jandi_messages" on public.jandi_messages
      for select to authenticated
      using (((select (auth.jwt() ->> 'is_anonymous'))::boolean) is not true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. 설치 후 반드시 확인할 것
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) RLS 가 3개 표 모두에 켜졌는지:
--     select relname, relrowsecurity from pg_class
--     where relname in ('kakao_partner_chats','kakao_partner_messages','jandi_messages',
--                       'kakao_partner_stream_state','kakao_partner_secrets');
--     → relrowsecurity 가 전부 true 여야 한다(5개).
--
-- (2) 정책이 3개 다 생겼는지:
--     select tablename, policyname from pg_policies
--     where tablename in ('kakao_partner_chats','kakao_partner_messages','jandi_messages');
--
-- (3) 로그아웃 상태(공개 키만)로는 아무것도 안 읽히는지 실제로 확인:
--     curl "https://<프로젝트>.supabase.co/rest/v1/kakao_partner_messages?select=log_id&limit=1" \
--          -H "apikey: <공개키>"
--     → 빈 배열 [] 이 나와야 정상이다. 데이터가 나오면 RLS 가 잘못된 것이니 즉시 조치할 것.
--
-- (4) 수집 키 보관함이 공개 키로 안 읽히는지도 같은 방법으로 확인:
--     curl "https://<프로젝트>.supabase.co/rest/v1/kakao_partner_secrets?select=key" \
--          -H "apikey: <공개키>"
--     → 빈 배열 [] 이어야 한다. 값이 나오면 실수로 정책을 추가한 것이니 즉시 지울 것.
--
-- (5) 배부할 수집 키 확인 (이 값을 /collect 화면에 넣는다):
--     select value from public.kakao_partner_secrets where key = 'kakao_ingest_token';
