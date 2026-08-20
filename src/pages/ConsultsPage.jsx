// src/pages/ConsultsPage.jsx — /consults
// 카카오 파트너센터 5채널 상담 로그 뷰어 (kakao_partner_messages, RLS authenticated read).
// 기능: 채팅별 스레드 그룹 + 새로고침 + 현재필터 전체 CSV 다운로드.
// 채널 목록은 sdij-wiki CLAUDE.md §16(정본)과 반드시 동일하게 유지 — 정본이 바뀌면 여기도 갱신.
//
// sdij-wiki 의 AdminConsultsPage 를 이 앱(카카오·잔디 데이터 조회 전용) 목적에 맞게 축소 포팅.
// "지금 처리할 대화" 실시간 위젯과 문의량 추세 카드는 운영 분석용이라 제외했다 — 여기는
// 담당자 교체 후에도 유지보수 없이 계속 굴러가야 하는 "수집된 데이터 그대로 보기" 전용 화면이다.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { supabase, isSupabaseEnabled } from '@/lib/supabase'
import { maskBody, maskName } from '@/lib/maskPII'
import { fetchAllByCursor } from '@/lib/csvExport'
import {
  MagnifyingGlass as Search,
  ChatText as MessageSquare,
  User,
  Headset,
  Gear as Cog,
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
import './ConsultsPage.astryx.css'

const CHANNELS = [
  { id: '_VGAQn', label: '마이클래스' },
  { id: '_rcpPG', label: 'LIVE' },
  { id: '_TkpPG', label: 'LIVE 기술지원' },
  { id: '_xfxilXn', label: '콘텐츠' },
  { id: '_rkbcn', label: '통합로그인' },
]
const CHANNEL_BADGE = {
  _VGAQn: 'blue',
  _rcpPG: 'green',
  _TkpPG: 'teal',
  _xfxilXn: 'purple',
  _rkbcn: 'orange',
}
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

const SENDER_META = {
  manager: { base: '상담원', variant: 'info', icon: Headset },
  user: { base: '고객', variant: 'neutral', icon: User },
  system: { base: '시스템', variant: 'warning', icon: Cog },
}

function senderText(m, nickMap) {
  const meta = SENDER_META[m.sender_type] || SENDER_META.system
  let name = ''
  if (m.sender_type === 'manager') name = m.manager_name || ''
  else if (m.sender_type === 'user') name = nickMap.get(String(m.chat_id)) || ''
  return name ? meta.base + '(' + name + ')' : meta.base
}

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

function useChannelCount(profileId) {
  return useQuery({
    queryKey: ['kakao-count', profileId],
    enabled: isSupabaseEnabled,
    retry: 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('kakao_partner_chats').select('*', { count: 'exact', head: true }).eq('profile_id', profileId)
      if (error) throw error
      return count ?? 0
    },
  })
}

function useNicknames(profileId) {
  return useQuery({
    queryKey: ['kakao-nick', profileId],
    enabled: isSupabaseEnabled,
    staleTime: 10 * 60 * 1000,
    retry: 0,
    queryFn: async () => {
      const map = new Map()
      // ⚠️ 예전에는 "받은 개수 < 1000 이면 끝"으로 판단하고 from 을 1000씩 고정으로 올렸다.
      //    서버 상한(Max Rows)이 1000보다 낮게 설정돼 있으면 첫 장에서 바로 멈춰 버려,
      //    나머지 고객 이름이 통째로 빠지고 CSV "고객" 열이 빈칸으로 나간다.
      //    CSV 가 1000건에서 잘렸던 실제 사고와 뿌리가 같다(csvExport.js 주석 참고).
      //    → 빈 응답일 때만 멈추고, 실제로 받은 개수만큼만 다음 시작점을 옮긴다.
      let from = 0
      for (let page = 0; page < 100000; page++) {
        const { data, error } = await supabase
          .from('kakao_partner_chats').select('chat_id, nickname').eq('profile_id', profileId)
          .order('chat_id', { ascending: true }).range(from, from + 999)
        if (error) throw error
        if (!data || !data.length) break
        for (const r of data) map.set(String(r.chat_id), maskName(r.nickname || ''))
        from += data.length
      }
      return map
    },
  })
}

function useMessages(profileId, query, year, month, limit) {
  return useQuery({
    queryKey: ['kakao-messages', profileId, query, year, month, limit],
    enabled: isSupabaseEnabled,
    placeholderData: keepPreviousData,
    retry: 0,
    queryFn: async () => {
      let q = supabase
        .from('kakao_partner_messages')
        .select('log_id, chat_id, sender_type, message, message_type, sent_at, manager_name:raw->manager->>name')
        .eq('profile_id', profileId)
        .order('sent_at', { ascending: false })
        .limit(limit)
      if (query.trim()) q = q.ilike('message', '%' + query.trim() + '%')
      const range = periodRange(year, month)
      if (range) q = q.gte('sent_at', range.gte).lt('sent_at', range.lt)
      const { data, error } = await q
      if (error) throw error
      return data ?? []
    },
  })
}

function ChannelKpi({ ch }) {
  const { data, isLoading, isError } = useChannelCount(ch.id)
  return (
    <Card className="ac-kpi">
      <div className="ac-kpi-head">
        <Badge label={ch.label} variant={CHANNEL_BADGE[ch.id]} />
        <MessageSquare size={16} className="ac-kpi-icon" />
      </div>
      <Text type="supporting" size="sm">전체 누적 대화</Text>
      {isLoading ? (
        <Skeleton width={96} height={32} />
      ) : (
        <div className="ac-kpi-value">
          <Text as="span" type="display-3" weight="semibold" hasTabularNumbers>
            {isError ? '—' : (data ?? 0).toLocaleString('ko-KR')}
          </Text>
          <Text as="span" type="supporting">개</Text>
        </div>
      )}
    </Card>
  )
}

async function fetchAllForCsv({ profileId, query, year, month, onProgress }) {
  const range = periodRange(year, month)
  return fetchAllByCursor({
    timeColumn: 'sent_at',
    idColumn: 'log_id',
    onProgress,
    buildQuery: (limit) => {
      let q = supabase
        .from('kakao_partner_messages')
        .select('log_id, chat_id, sender_type, message, message_type, sent_at, manager_name:raw->manager->>name')
        .eq('profile_id', profileId)
        .order('sent_at', { ascending: false })
        .limit(limit)
      if (query.trim()) q = q.ilike('message', '%' + query.trim() + '%')
      if (range) q = q.gte('sent_at', range.gte).lt('sent_at', range.lt)
      return q
    },
  })
}

function buildCsv(rows, nickMap, channelLabel) {
  const head = ['채널', '시각(KST)', '채팅ID', '고객', '보낸이', '메시지유형', '메시지']
  const esc = (v) => {
    const s = v == null ? '' : String(v).replace(/[\r\n]+/g, ' ')
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [head.join(',')]
  for (const m of rows) {
    const meta = SENDER_META[m.sender_type] || SENDER_META.system
    const managerName = m.sender_type === 'manager' ? (m.manager_name || '') : ''
    const sender = managerName ? meta.base + '(' + managerName + ')' : meta.base
    lines.push([
      channelLabel,
      fmtKstFull(m.sent_at),
      m.chat_id,
      nickMap.get(String(m.chat_id)) || '',
      sender,
      m.message_type || '',
      maskBody(m.message) || '',
    ].map(esc).join(','))
  }
  return '﻿' + lines.join('\r\n')
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ConsultsPage() {
  const [channel, setChannel] = useState(CHANNELS[0].id)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [year, setYear] = useState('all')
  const [month, setMonth] = useState('all')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [csvLoading, setCsvLoading] = useState(false)
  const [csvCount, setCsvCount] = useState(0)

  const qc = useQueryClient()
  const { data: nickMap = new Map() } = useNicknames(channel)
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

  const grouped = useMemo(() => {
    const map = new Map()
    for (const m of rows) {
      const key = String(m.chat_id)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(m)
    }
    const groups = []
    for (const [chatId, msgs] of map) {
      msgs.sort((a, b) => (a.sent_at || '').localeCompare(b.sent_at || ''))
      groups.push({
        chatId,
        messages: msgs,
        latestAt: msgs[msgs.length - 1]?.sent_at || '',
        count: msgs.length,
        nickname: nickMap.get(chatId) || '',
      })
    }
    groups.sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''))
    return groups
  }, [rows, nickMap])

  const channelLabel = CHANNELS.find((c) => c.id === channel)?.label || channel

  const onRefresh = () => {
    qc.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || '').startsWith('kakao-') })
  }

  const onDownloadCsv = async () => {
    setCsvLoading(true)
    setCsvCount(0)
    try {
      const all = await fetchAllForCsv({ profileId: channel, query, year, month, onProgress: setCsvCount })
      if (!all.length) {
        alert('내려받을 메시지가 없습니다. 채널·기간·검색어를 확인해 주세요.')
        return
      }
      const csv = buildCsv(all, nickMap, channelLabel)
      const today = new Date().toISOString().slice(0, 10)
      const tag = year === 'all' ? '전체기간' : (year + (month === 'all' ? '' : '-' + String(month).padStart(2, '0')))
      downloadBlob(csv, `kakao_${channelLabel}_${tag}_${today}.csv`)
    } catch (e) {
      alert('CSV 다운로드 실패: ' + (e?.message || e))
    } finally {
      setCsvLoading(false)
    }
  }

  const titleSuffix = (year !== 'all' ? ' · ' + year + '년' + (month !== 'all' ? ' ' + Number(month) + '월' : '') : '')
    + (query ? ' · "' + query + '"' : '')

  return (
    <div className="cs-shell">
      <VStack gap={6} hAlign="stretch">

        <VStack gap={1}>
          <Heading level={1}>카카오 상담 로그</Heading>
          <Text type="supporting">파트너센터 5채널 실시간 수집 데이터 · 채팅별 스레드 그룹</Text>
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

        <div className="ac-toolbar">
          <div className="ac-chips">
            <SegmentedControl value={channel} onChange={onChannel} label="채널 선택" size="sm">
              {CHANNELS.map((ch) => (
                <SegmentedControlItem key={ch.id} value={ch.id} label={ch.label} />
              ))}
            </SegmentedControl>
          </div>

          <div className="ac-selects">
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

          <div className="ac-search">
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

        <Card className="ac-panel" padding={0}>
          <div className="cs-cardhead cs-row-between ac-panel-head">
            <div className="ac-panel-titlewrap">
              <Text weight="semibold">상담 스레드{titleSuffix}</Text>
              {grouped.length > 0 && (
                <Text type="supporting" hasTabularNumbers>
                  {grouped.length}개 대화 · {rows.length}건 메시지
                </Text>
              )}
            </div>
            <div className="ac-panel-actions">
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
              <Button variant="secondary" size="sm" label="새로고침" icon={<RefreshIcon size={16} />} onClick={onRefresh} isDisabled={isFetching} />
              <Button variant="secondary" size="sm" label="CSV" icon={<DownloadIcon size={16} />} onClick={onDownloadCsv} isDisabled={csvLoading || isLoading} />
            </div>
          </div>

          <Divider />

          <div className="cs-cardbody">
            {isError ? (
              <QueryError label="상담 메시지" error={error} onRetry={refetch} />
            ) : isLoading ? (
              <VStack gap={2} hAlign="stretch">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} width="100%" height={80} index={i} />
                ))}
              </VStack>
            ) : grouped.length === 0 ? (
              <QueryEmpty
                title="조건에 맞는 메시지가 없습니다"
                description={`${channelLabel} 채널${year === 'all' ? ' 전체 기간' : ' ' + year + '년' + (month === 'all' ? '' : ' ' + Number(month) + '월')} 기준입니다.`}
                actions={hasFilter ? (
                  <Button label="검색어·기간 지우기" variant="secondary" size="sm" onClick={clearFilters} />
                ) : undefined}
              />
            ) : (
              <VStack gap={4} hAlign="stretch">
                {grouped.map((g) => (
                  <div key={g.chatId} className="ac-thread">
                    <div className="ac-thread-head">
                      <div className="ac-thread-id">
                        <Badge label="고객" variant="neutral" icon={<User size={12} />} />
                        <Text weight="medium" maxLines={1} className="ac-thread-nick">{g.nickname || '(닉네임 없음)'}</Text>
                        <Text type="supporting" className="ac-thread-hash">#{g.chatId.slice(-12)}</Text>
                      </div>
                      <div className="ac-thread-meta">
                        <Text type="supporting" hasTabularNumbers>{g.count}건</Text>
                        <Text type="supporting" hasTabularNumbers>최근 {fmtKST(g.latestAt)}</Text>
                      </div>
                    </div>
                    <ul className="ac-msgs">
                      {g.messages.map((m) => {
                        const meta = SENDER_META[m.sender_type] || SENDER_META.system
                        const Icon = meta.icon
                        return (
                          <li key={m.log_id} className="ac-msg" data-dir={m.sender_type === 'user' ? 'in' : 'out'}>
                            <span className="ac-msg-time">{fmtKST(m.sent_at)}</span>
                            <Badge className="ac-msg-sender" variant={meta.variant} label={senderText(m, nickMap)} icon={<Icon size={12} />} />
                            <div className="ac-msg-bubble">
                              {maskBody(m.message) || <span className="ac-msg-empty">(본문 없음)</span>}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </VStack>
            )}

            {!isLoading && !isError && rows.length >= limit && (
              <HStack hAlign="center" className="ac-more">
                <Button variant="secondary" size="sm" label={`더 보기 (+${PAGE_SIZE})`} onClick={() => setLimit((l) => l + PAGE_SIZE)} />
              </HStack>
            )}

            {serverCapped && (
              <HStack hAlign="center" className="ac-more">
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
