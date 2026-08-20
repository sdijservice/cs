// src/components/QueryStates.jsx
// 관리자 화면의 "조회 실패 / 결과 없음" 두 상태를 한 곳에서 만든다.
// 오류(Banner)와 빈 화면(EmptyState)의 픽셀이 같으면 "값이 0"과 "값을 못 읽음"이
// 구분되지 않는다 — 반드시 분리해서 보여준다.
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'

// 한국어 조사 "을/를" 고르기. 마지막 글자에 받침이 있으면 "을", 없으면 "를".
function objectParticle(word) {
  const last = String(word || '').trim().slice(-1)
  const code = last.charCodeAt(0)
  if (!last || code < 0xac00 || code > 0xd7a3) return '를'
  return (code - 0xac00) % 28 === 0 ? '를' : '을'
}

export function QueryError({ label, error, onRetry, className }) {
  return (
    <Banner
      status="error"
      title={`${label}${objectParticle(label)} 불러오지 못했습니다`}
      description={error?.message || '잠시 후 다시 시도해 주세요.'}
      endContent={onRetry ? <Button label="다시 시도" variant="secondary" size="sm" onClick={onRetry} /> : undefined}
      className={className}
    />
  )
}

// description 에는 검색어 원문을 넣지 말 것 — 상담 검색어에는 이름·전화번호가 들어갈 수 있다.
export function QueryEmpty({ title, description, actions, isCompact = true }) {
  return <EmptyState title={title} description={description} actions={actions} isCompact={isCompact} />
}
