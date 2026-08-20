// src/pages/CollectPage.jsx — /collect
// 카카오 상담 수집을 "누가" 돌리는지 정하는 화면.
//
// 배경: 카카오는 상담 대화를 내보내는 공식 방법을 제공하지 않는다. 그래서 사람이 로그인한
// 브라우저 세션을 빌려 읽는 수밖에 없고, 그 일을 할 수 있는 곳은 두 군데뿐이다.
//   (1) 크롬 확장 프로그램  (2) 파트너센터 페이지 안에서 도는 스크립트
// 사내 보안 정책상 확장 설치가 불가능하므로 (2)를 쓴다. 설치가 아니라 북마크 하나를
// 추가하는 방식이라 직원 PC 에 프로그램이 남지 않는다.
//
// 이 화면이 하는 일은 하나다: 수집 서버 주소와 수집 키를 넣은 북마크 링크를 만들어 주는 것.
// 실제 수집 동작은 public/kakao-collect.js 에 있다.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookmarkSimple,
  Copy as CopyIcon,
  Check as CheckIcon,
  Warning as WarningIcon,
} from '@phosphor-icons/react'

import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Card } from '@astryxdesign/core/Card'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { Divider } from '@astryxdesign/core/Divider'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Badge } from '@astryxdesign/core/Badge'

import './CollectPage.astryx.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? ''
const DEFAULT_ENDPOINT = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/kakao-ingest`
  : ''

// 수집 대상 채널 5개 — public/kakao-collect.js 의 PROFILES 와 같은 목록.
const CHANNELS = [
  { id: '_VGAQn', label: '마이클래스' },
  { id: '_rcpPG', label: 'LIVE' },
  { id: '_TkpPG', label: 'LIVE 기술지원' },
  { id: '_xfxilXn', label: '콘텐츠' },
  { id: '_rkbcn', label: '통합로그인' },
]

// 수집 키는 설치 SQL(0001_init_viewer_schema.sql)이 이미 만들어 둔다. 여기서는 꺼내 보기만 하면 된다.
const TOKEN_SQL = `select value from public.kakao_partner_secrets
where key = 'kakao_ingest_token';`

// 키가 유출됐을 때만 쓴다. 새 키로 바꾸면 기존 북마크는 전부 다시 배부해야 한다.
const ROTATE_SQL = `update public.kakao_partner_secrets
set value = encode(extensions.gen_random_bytes(24), 'hex'), updated_at = now()
where key = 'kakao_ingest_token';`

/**
 * 북마크에 넣을 한 줄짜리 명령을 만든다.
 *
 * 수집 키를 주소의 `#` 뒤에 싣는 이유: `#` 뒤는 브라우저가 서버로 보내지 않는다.
 * 그래서 이 사이트의 접속 기록에 키가 남지 않는다.
 * `?v=` 는 매번 달라지므로, 수집 스크립트를 고치면 다음 클릭부터 바로 새 것이 받아진다.
 */
function buildBookmarklet({ origin, endpoint, token }) {
  if (!origin || !endpoint || !token) return ''
  const src = JSON.stringify(`${origin}/kakao-collect.js`)
  const e = JSON.stringify(endpoint)
  const t = JSON.stringify(token)
  const fail = JSON.stringify('수집 스크립트를 불러오지 못했습니다.')
  return (
    'javascript:(function(){' +
    'var s=document.createElement("script");' +
    `s.src=${src}+"?v="+Date.now()+"#e="+encodeURIComponent(${e})+"&t="+encodeURIComponent(${t});` +
    `s.onerror=function(){alert(${fail})};` +
    'document.documentElement.appendChild(s);' +
    '})()'
  )
}

/**
 * `javascript:` 로 시작하는 주소는 React 가 안전을 이유로 지운다.
 * 북마크 막대로 끌어다 놓으려면 진짜 링크여야 하므로 렌더링 뒤에 직접 넣는다.
 */
function BookmarkletLink({ code }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (code) el.setAttribute('href', code)
    else el.removeAttribute('href')
  }, [code])
  return (
    <a
      ref={ref}
      className="collect-bmk"
      draggable
      onClick={(e) => e.preventDefault()}
      title="이 버튼을 북마크 막대로 끌어다 놓으세요"
    >
      <BookmarkSimple weight="fill" size={16} />
      시대인재 상담 수집
    </a>
  )
}

export default function CollectPage() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT)
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const code = useMemo(
    () => buildBookmarklet({ origin, endpoint: endpoint.trim(), token: token.trim() }),
    [origin, endpoint, token],
  )

  const onCopy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <VStack gap={6} hAlign="stretch" className="collect-page">
      <VStack gap={1}>
        <Heading level={1}>카카오 상담 수집</Heading>
        <Text type="supporting">
          카카오 파트너센터에 로그인된 직원의 브라우저가 5분마다 상담 내용을 읽어 이 데이터베이스에 모읍니다.
          확장 프로그램을 설치하지 않고 북마크 하나만 추가하면 됩니다.
        </Text>
      </VStack>

      <Card>
        <VStack gap={3} hAlign="stretch">
          <Heading level={2}>1. 북마크 만들기 (관리자, 최초 1회)</Heading>
          <Text type="supporting" size="sm">
            아래 두 칸을 채우면 배부할 북마크가 만들어집니다. 수집 키는 설치 SQL 이 이미 만들어 두었으니,
            Supabase SQL Editor 에서 다음을 실행해 꺼내 오기만 하면 됩니다.
          </Text>
          <pre className="collect-sql">{TOKEN_SQL}</pre>

          <TextInput
            label="수집 서버 주소"
            value={endpoint}
            onChange={(v) => setEndpoint(v ?? '')}
            placeholder="https://프로젝트.supabase.co/functions/v1/kakao-ingest"
            description={
              DEFAULT_ENDPOINT
                ? '환경변수에서 자동으로 채웠습니다.'
                : '환경변수 VITE_SUPABASE_URL 이 비어 있어 직접 넣어야 합니다.'
            }
          />
          <TextInput
            label="수집 키"
            type="password"
            value={token}
            onChange={(v) => setToken(v ?? '')}
            placeholder="위 SQL 로 얻은 값"
          />
        </VStack>
      </Card>

      <Card>
        <VStack gap={3} hAlign="stretch">
          <Heading level={2}>2. 직원에게 배부하기</Heading>
          {code ? (
            <>
              <Text type="supporting" size="sm">
                아래 버튼을 브라우저의 북마크 막대로 끌어다 놓으면 끝입니다. 다른 사람에게 전달할 때는
                주소 복사를 눌러 복사한 뒤, 받은 사람이 북마크를 새로 만들어 주소 칸에 붙여넣게 하면 됩니다.
              </Text>
              <HStack gap={2} align="center" wrap="wrap">
                <BookmarkletLink code={code} />
                <Button
                  variant="secondary"
                  size="sm"
                  label={copied ? '복사했습니다' : '주소 복사'}
                  icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  onClick={onCopy}
                />
              </HStack>
            </>
          ) : (
            <Text type="supporting" size="sm">
              위 1번의 두 칸을 채우면 여기에 북마크가 나타납니다.
            </Text>
          )}
        </VStack>
      </Card>

      <Card>
        <VStack gap={3} hAlign="stretch">
          <Heading level={2}>3. 직원이 할 일</Heading>
          <ol className="collect-steps">
            <li>크롬에서 <b>business.kakao.com</b> 에 로그인합니다.</li>
            <li>북마크 막대의 <b>시대인재 상담 수집</b>을 누릅니다.</li>
            <li>오른쪽 아래에 상태 창이 뜨고 바로 수집이 시작됩니다.</li>
            <li>그 탭을 열어두면 5분마다 자동으로 계속 모읍니다. 탭을 닫으면 멈춥니다.</li>
          </ol>
          <Divider />
          <Text type="supporting" size="sm">
            여러 명이 동시에 눌러도 괜찮습니다. 같은 내용을 두 번 넣어도 덮어쓰기라 중복이 생기지 않고,
            한 사람이 자리를 비워도 다른 사람 쪽에서 계속 모입니다.
          </Text>
        </VStack>
      </Card>

      <Card>
        <VStack gap={3} hAlign="stretch">
          <Heading level={2}>수집 대상 채널</Heading>
          <HStack gap={1} wrap="wrap">
            {CHANNELS.map((c) => (
              <Badge key={c.id} variant="neutral" label={c.label} />
            ))}
          </HStack>
        </VStack>
      </Card>

      <Card>
        <VStack gap={3} hAlign="stretch">
          <HStack gap={1} align="center">
            <WarningIcon size={18} weight="fill" />
            <Heading level={2}>알아둘 것</Heading>
          </HStack>
          <ul className="collect-notes">
            <li>
              <b>수집 키는 북마크 주소 안에 들어갑니다.</b> 유출될 수 있다고 전제하고 만들었습니다.
              이 키로 할 수 있는 일은 상담 내용을 넣는 것 하나뿐이고 읽기, 삭제, 다른 표 접근은 되지 않습니다.
              유출이 확인되면 아래로 키만 새로 만들면 됩니다. 단 그 뒤에는 북마크를 전부 다시 배부해야 합니다.
              <pre className="collect-sql">{ROTATE_SQL}</pre>
            </li>
            <li>
              <b>개인정보는 서버가 가립니다.</b> 이름, 전화번호, 이메일, 카드번호, 주민등록번호는
              데이터베이스에 저장되기 직전에 가려집니다. 직원 브라우저에서 도는 코드에 그 판단을 맡기지
              않았습니다.
            </li>
            <li>
              <b>카카오 비밀번호는 어디에도 저장되지 않습니다.</b> 이미 로그인된 세션을 빌려 읽을 뿐입니다.
            </li>
            <li>
              파트너센터 접근 권한이 있는 직원에게만 배부하세요. 권한이 없는 계정으로는 아무것도 읽히지 않습니다.
            </li>
          </ul>
        </VStack>
      </Card>
    </VStack>
  )
}
