// src/pages/JandiPage.jsx — /jandi
// 잔디(JANDI) 5채널 대화 로그 뷰어 (jandi_messages).
// 접근 제어: RLS 로 "로그인한 계정만 읽기"(익명 로그인 제외). 예전 주석에 'anon read'라 적혀
// 있었으나 그건 폐기된 옛 설정이라 오해를 부른다 - supabase/migrations/0001 참고.
// 방별 단일 타임라인(카카오의 채팅별 스레드와 다름) + 검색/기간 + 현재필터 CSV.
//
// sdij-wiki 의 AdminJandiPage 를 이 앱 목적에 맞게 축소 포팅. 실시간 활동 위젯과
// 대화량 추세 카드는 운영 분석용이라 제외했다 — 여기는 "수집된 데이터 그대로 보기" 전용 화면이다.
import { useState } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { supabase, isSupabaseEnabled } from '@/lib/supabase'
import { fetchAllByCursor } from '@/lib/csvExport'
import { maskBody } from '@/lib/maskPII'
import {
  MagnifyingGlass as Search,
  ChatText as MessageSquare,
  User,
  ArrowsClockwise as RefreshIcon,
  DownloadSimple as DownloadIcon,
} from '@phosphor-icons/react'

import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Grid } from '@astryxdesign/core/Grid'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { Divider } from '@astryxdesign/core/Divider'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { QueryError, QueryEmpty } from '@/components/QueryStates'

import './JandiPage.astryx.css'

// jandi_channels 와 동일한 5개 방.
const CHANNELS = [
  { id: '31495011', label: '시대 APP 기획/문의' },
  { id: '31962045', label: '시대 APP 실험실' },
  { id: '33385655', label: '재종통합행정 + 플랫폼서비스실' },
  { id: '31495551', label: '재종 데스크 업무' },
  { id: '29522222', label: '전체공지' },
]
const PAGE_SIZE = 50
// 서버가 한 번의 요청으로 돌려주는 행 수 상한(Supabase 프로젝트 설정 Max Rows, 기본 1000).
// 화면 목록은 limit 을 올려가며 더 받는 방식이라, 이 상한에 걸리면 "더 보기"를 눌러도 개수가
// 안 늘어난다. 예전에는 그 시점에 버튼이 조용히 사라져 사용자가 "이게 전부"로 오해했다.
// (CSV 다운로드에서 같은 상한 때문에 1000건에서 잘렸던 실제 사고와 뿌리가 같다 - csvExport.js 참고.)
const SERVER_ROW_CAP = 1000

const NOW_Y = new Date().getFullYear()
// ⚠️ 예전에는 [올해, 작년, 재작년] 3년으로 고정돼 있었다. 수집 데이터는 2023-12 부터 있는데
//    해가 바뀌면 목록에서 옛 연도가 조용히 사라져, 그 해 데이터에 도달할 방법이 아예 없어진다.
//    (2026년 기준 이미 2023년이 빠져 있었다.) 수집 시작 연도부터 올해까지 전부 만든다.
const DATA_START_YEAR = 2023
const YEARS = Array.from({ length: Math.max(1, NOW_Y - DATA_START_YEAR + 1) }, (_, i) => NOW_Y - i)
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
const YEAR_OPTIONS = [{ value: 'all', label: '전체기간' }, ...YEARS.map((y) => ({ value: String(y), label: `${y}년` }))]
const MONTH_OPTIONS = [{ value: 'all', label: '전체월' }, ...MONTHS.map((m) => ({ value: m, label: `${Number(m)}월` }))]

const fmtKST = (iso) => {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso))
  } catch { return iso.slice(0, 16).replace('T', ' ') }
}
const fmtKstFull = (iso) => {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(iso)).replace('T', ' ')
  } catch { return iso }
}
const writerLabel = (m) => m.writer_name || (m.writer_id ? '멤버 ' + String(m.writer_id).slice(-6) : '알 수 없음')

// 최신순 정렬 + 댓글(스레드 답글)을 원글 아래로 묶기. 그룹 정렬은 "그룹 내 가장 최근 활동 시각" 기준.
function groupThreads(rows) {
  const byMessageId = new Map(rows.map((r) => [r.message_id, r]))
  const childrenOf = new Map()
  const roots = []
  for (const r of rows) {
    const parent = r.reply_to_message_id
    if (parent && parent !== r.message_id && byMessageId.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent).push(r)
    } else {
      roots.push(r)
    }
  }
  const groups = roots.map((root) => {
    const children = (childrenOf.get(root.message_id) || [])
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    const messages = [root, ...children]
    const latest = children.length ? children[children.length - 1].created_at : root.created_at
    return { root, children, messages, count: messages.length, latest: latest || root.created_at || '' }
  })
  groups.sort((a, b) => (b.latest || '').localeCompare(a.latest || ''))
  return groups
}

function threadTitle(root) {
  const s = (root.message || '').replace(/\s+/g, ' ').trim()
  if (s) return s.length > 60 ? s.slice(0, 60) + '…' : s
  return '(' + (root.content_type || '내용 없음') + ')'
}

function periodRange(year, month) {
  if (year === 'all') return null
  const y = Number(year)
  const pad = (n) => String(n).padStart(2, '0')
  if (month === 'all') {
    return {
      gte: new Date(y + '-01-01T00:00:00+09:00').toISOString(),
      lt: new Date((y + 1) + '-01-01T00:00:00+09:00').toISOString(),
    }
  }
  const m = Number(month)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return {
    gte: new Date(y + '-' + pad(m) + '-01T00:00:00+09:00').toISOString(),
    lt: new Date(ny + '-' + pad(nm) + '-01T00:00:00+09:00').toISOString(),
  }
}

function useChannelCount(roomId) {
  return useQuery({
    queryKey: ['jandi-count', roomId],
    enabled: isSupabaseEnabled,
    retry: 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('jandi_messages').select('*', { count: 'exact', head: true }).eq('room_id', roomId)
      if (error) throw error
      return count ?? 0
    },
  })
}

function useMessages(roomId, query, year, month, limit) {
  return useQuery({
    queryKey: ['jandi-messages', roomId, query, year, month, limit],
    enabled: isSupabaseEnabled,
    placeholderData: keepPreviousData,
    retry: 0,
    queryFn: async () => {
      let q = supabase
        .from('jandi_messages')
        .select('link_id, message_id, writer_id, writer_name, content_type, message, created_at, reply_to_message_id')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (query.trim()) q = q.ilike('message', '%' + query.trim() + '%')
      const range = periodRange(year, month)
      if (range) q = q.gte('created_at', range.gte).lt('created_at', range.lt)
      const { data, error } = await q
      if (error) throw error
      return data ?? []
    },
  })
}

function MessageRow({ m, isReply = false }) {
  return (
    <li className={'aj-msg' + (isReply ? ' aj-msg-reply' : '')}>
      <Text as="span" type="supporting" hasTabularNumbers className="aj-msg-time">{fmtKST(m.created_at)}</Text>
      <Badge variant="neutral" label={writerLabel(m)} icon={<User size={12} />} className="aj-msg-who" />
      {isReply && <span className="aj-msg-tag">↳ 댓글</span>}
      {!isReply && m.reply_to_message_id && (
        <span className="aj-msg-tag" title="원글이 현재 목록 범위 밖입니다">💬 답글</span>
      )}
      <p className="aj-msg-body">
        {maskBody(m.message) || <span className="aj-msg-empty">({m.content_type || '본문 없음'})</span>}
      </p>
    </li>
  )
}

function ChannelKpi({ ch }) {
  const { data, isLoading, isError } = useChannelCount(ch.id)
  return (
    <Card className="aj-kpi">
      <div className="aj-kpi-head">
        <Text type="supporting" maxLines={2}>{ch.label}</Text>
        <MessageSquare size={16} className="aj-kpi-icon" />
      </div>
      <Text type="supporting" size="sm">전체 누적 메시지</Text>
      {isLoading ? (
        <Skeleton width={96} height={32} />
      ) : (
        <div className="aj-kpi-value">
          <Text as="span" type="display-3" weight="semibold" hasTabularNumbers>
            {isError ? '—' : (data ?? 0).toLocaleString('ko-KR')}
          </Text>
          <Text as="span" type="supporting">건</Text>
        </div>
      )}
    </Card>
  )
}

async function fetchAllForCsv({ roomId, query, year, month, onProgress }) {
  const range = periodRange(year, month)
  return fetchAllByCursor({
    timeColumn: 'created_at',
    idColumn: 'link_id',
    onProgress,
    buildQuery: (limit) => {
      let q = supabase
        .from('jandi_messages')
        .select('link_id, writer_id, writer_name, content_type, message, created_at')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (query.trim()) q = q.ilike('message', '%' + query.trim() + '%')
      if (range) q = q.gte('created_at', range.gte).lt('created_at', range.lt)
      return q
    },
  })
}

function buildCsv(rows, channelLabel) {
  const head = ['채널', '시각(KST)', '작성자', '유형', '메시지']
  const esc = (v) => {
    const s = v == null ? '' : String(v).replace(/[\r\n]+/g, ' ')
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [head.join(',')]
  for (const m of rows) {
    lines.push([
      channelLabel, fmtKstFull(m.created_at), writerLabel(m),
      m.content_type || '', maskBody(m.message) || '',
    ].map(esc).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function JandiPage() {
  const [channel, setChannel] = useState(CHANNELS[0].id)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [year, setYear] = useState('all')
  const [month, setMonth] = useState('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [csvLoading, setCsvLoading] = useState(false)
  const [csvCount, setCsvCount] = useState(0)

  const qc = useQueryClient()
  const { data: rows = [], isLoading, isFetching, isError, error, dataUpdatedAt, refetch } = useMessages(channel, query, year, month, limit)

  // 서버 상한(SERVER_ROW_CAP)에 걸려 더는 못 받는 상태인지 판정한다.
  // 요청한 limit 보다 적게 왔는데 그 개수가 상한과 같다면, 데이터가 없어서가 아니라
  // 서버가 잘라서 준 것이다 - 이때는 "더 보기"를 눌러도 개수가 안 늘어나므로 안내를 띄운다.
  const serverCapped = !isLoading && !isError && rows.length < limit && rows.length >= SERVER_ROW_CAP

  const reset = () => setLimit(PAGE_SIZE)
  const hasFilter = Boolean(query) || year !== 'all' || month !== 'all'
  const clearFilters = () => { setInput(''); setQuery(''); setYear('all'); setMonth('all'); reset() }
  const onChannel = (id) => { setChannel(id); reset() }
  const onSearch = () => { setQuery(input); reset() }

  const threads = groupThreads(rows)
  const channelLabel = CHANNELS.find((c) => c.id === channel)?.label || channel

  const onRefresh = () => {
    qc.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || '').startsWith('jandi-') })
  }

  const onDownloadCsv = async () => {
    setCsvLoading(true)
    setCsvCount(0)
    try {
      const all = await fetchAllForCsv({ roomId: channel, query, year, month, onProgress: setCsvCount })
      if (!all.length) {
        alert('내려받을 메시지가 없습니다. 방·기간·검색어를 확인해 주세요.')
        return
      }
      const csv = buildCsv(all, channelLabel)
      const today = new Date().toISOString().slice(0, 10)
      const tag = year === 'all' ? '전체기간' : (year + (month === 'all' ? '' : '-' + String(month).padStart(2, '0')))
      downloadBlob(csv, `jandi_${channelLabel}_${tag}_${today}.csv`)
    } catch (e) {
      alert('CSV 다운로드 실패: ' + (e?.message || e))
    } finally {
      setCsvLoading(false)
    }
  }

  return (
    <div className="cs-shell">
      <VStack gap={6} hAlign="stretch">

        <VStack gap={1}>
          <Heading level={1}>잔디 대화</Heading>
          <Text type="supporting">JANDI 5채널 실시간 수집 데이터 · 방별 타임라인</Text>
        </VStack>

        {!isSupabaseEnabled && (
          <Card variant="muted">
            <Text type="supporting">
              연결 정보(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)가 설정되지 않았습니다.
            </Text>
          </Card>
        )}

        <Grid columns={{ minWidth: 160, max: 5 }} gap={4}>
          {CHANNELS.map((ch) => <ChannelKpi key={ch.id} ch={ch} />)}
        </Grid>

        <div className="aj-toolbar">
          <div className="aj-tabs">
            <SegmentedControl value={channel} onChange={onChannel} label="방 선택" size="sm">
              {CHANNELS.map((ch) => (
                <SegmentedControlItem key={ch.id} value={ch.id} label={ch.label} />
              ))}
            </SegmentedControl>
          </div>

          <div className="aj-selects">
            <Selector
              label="년도"
              isLabelHidden
              size="sm"
              value={year}
              onChange={(v) => { setYear(v); reset() }}
              options={YEAR_OPTIONS}
            />
            <Selector
              label="월"
              isLabelHidden
              size="sm"
              value={month}
              onChange={(v) => { setMonth(v); reset() }}
              options={MONTH_OPTIONS}
              isDisabled={year === 'all'}
            />
          </div>

          <div className="aj-search">
            <TextInput
              size="sm"
              label="메시지 검색"
              isLabelHidden
              placeholder="메시지 검색 후 Enter"
              value={input}
              onChange={(v) => setInput(v)}
              onEnter={onSearch}
              startIcon={<Search size={16} />}
              hasClear
              width="100%"
            />
          </div>
        </div>

        <Card padding={0} className="aj-main">
          <div className="cs-cardhead cs-row-between aj-main-head">
            <div className="aj-main-title">
              <Text weight="semibold">
                {channelLabel}{year !== 'all' ? ' · ' + year + '년' + (month !== 'all' ? ' ' + Number(month) + '월' : '') : ''}{query ? ' · "' + query + '"' : ''}
              </Text>
              {threads.length > 0 && (
                <Text type="supporting" hasTabularNumbers>
                  {threads.length}개 대화 · {rows.length}건 메시지
                </Text>
              )}
            </div>
            <div className="aj-main-actions">
              {isFetching && !csvLoading && <Text type="supporting">불러오는 중…</Text>}
              {csvLoading && (
                <Text type="supporting">
                  {csvCount > 0 ? `CSV 준비 중 · ${csvCount.toLocaleString('ko-KR')}건` : 'CSV 준비 중…'}
                </Text>
              )}
              {!isFetching && dataUpdatedAt > 0 && (
                <Text type="supporting" size="sm">
                  마지막 갱신 {new Date(dataUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
              <Button label="새로고침" variant="secondary" size="sm" icon={<RefreshIcon size={16} />} onClick={onRefresh} isDisabled={isFetching} />
              <Button label="CSV" variant="secondary" size="sm" icon={<DownloadIcon size={16} />} onClick={onDownloadCsv} isDisabled={csvLoading || isLoading} />
            </div>
          </div>

          <Divider />

          <div className="cs-cardbody">
            {isError ? (
              <QueryError label="대화 메시지" error={error} onRetry={refetch} />
            ) : isLoading ? (
              <VStack gap={2} hAlign="stretch">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} width="100%" height={80} index={i} />
                ))}
              </VStack>
            ) : threads.length === 0 ? (
              <QueryEmpty
                title="조건에 맞는 메시지가 없습니다"
                description={`${channelLabel} 방${year === 'all' ? ' 전체 기간' : ' ' + year + '년' + (month === 'all' ? '' : ' ' + Number(month) + '월')} 기준입니다.`}
                actions={hasFilter ? (
                  <Button label="검색어·기간 지우기" variant="secondary" size="sm" onClick={clearFilters} />
                ) : undefined}
              />
            ) : (
              <VStack gap={4} hAlign="stretch">
                {threads.map((t) => (
                  <div key={t.root.link_id} className="aj-thread">
                    <div className="aj-thread-head">
                      <div className="aj-thread-head-l">
                        <Badge variant="neutral" label={writerLabel(t.root)} icon={<User size={12} />} className="aj-thread-who" />
                        <Text weight="medium" maxLines={2} className="aj-thread-title">{threadTitle(t.root)}</Text>
                      </div>
                      <div className="aj-thread-meta">
                        <Text as="span" type="supporting" hasTabularNumbers>{t.count}건</Text>
                        <Text as="span" type="supporting" hasTabularNumbers>최근 {fmtKST(t.latest)}</Text>
                      </div>
                    </div>
                    <ul className="aj-msglist">
                      {t.messages.map((m, i) => (
                        <MessageRow key={m.link_id} m={m} isReply={i > 0} />
                      ))}
                    </ul>
                  </div>
                ))}
              </VStack>
            )}

            {!isLoading && !isError && rows.length >= limit && (
              <HStack hAlign="center" className="aj-more">
                <Button label={`더 보기 (+${PAGE_SIZE})`} variant="secondary" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)} />
              </HStack>
            )}

            {serverCapped && (
              <HStack hAlign="center" className="aj-more">
                <Text type="supporting" size="sm">
                  화면에는 한 번에 {SERVER_ROW_CAP.toLocaleString('ko-KR')}건까지만 표시됩니다.
                  기간·검색으로 범위를 좁히거나, CSV 전체 다운로드를 이용해 주세요.
                </Text>
              </HStack>
            )}
          </div>
        </Card>

      </VStack>
    </div>
  )
}
