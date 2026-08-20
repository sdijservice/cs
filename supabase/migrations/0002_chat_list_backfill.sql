-- ─────────────────────────────────────────────────────────────────────────────
-- 대화방 목록 백필 진도 기록
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 필요한가
--   카카오의 대화방 목록 API(`chats/search`)는 한 번에 100개만 준다. size 를 200·500·1000
--   으로 올려도 100개에서 잘린다(서버 상한). 그래서 과거 대화방까지 받으려면 `since` 커서로
--   여러 번 나눠 요청해야 하는데, 채널당 수천 개일 수 있어 한 번의 실행으로는 끝나지 않는다.
--
--   "어디까지 팠는지"를 직원 브라우저(localStorage)에 두면 사람마다 진도가 따로 놀아서,
--   여러 명이 나눠 도는 이 시스템의 전제가 깨진다. 그래서 서버에 둔다.
--
-- 여러 번 실행해도 안전하다.

alter table public.kakao_partner_stream_state
  add column if not exists backfill_cursor text,
  add column if not exists backfill_done   boolean not null default false;

comment on column public.kakao_partner_stream_state.backfill_cursor is
  '대화방 목록을 과거로 훑어 내려간 마지막 지점(last_log_id). 다음 실행이 여기서 이어받는다.';
comment on column public.kakao_partner_stream_state.backfill_done is
  '과거 대화방을 끝까지 받았으면 true. 이후로는 목록 첫 페이지만 확인하면 된다.';
