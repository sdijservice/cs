// src/pages/LoginPage.jsx — 단독 로그인 화면(위키와 달리 헤더 드롭다운이 없어 전용 페이지로 둔다).
import { useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/store/authStore'
import { isSupabaseEnabled } from '@/lib/supabase'
import { useToast } from '@astryxdesign/core/Toast'
import { Card } from '@astryxdesign/core/Card'
import { VStack } from '@astryxdesign/core/VStack'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import './LoginPage.astryx.css'

export default function LoginPage() {
  const { isAuthenticated, loginWithEmail } = useAuth()
  const location = useLocation()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  if (isAuthenticated) {
    const to = location.state?.from?.pathname || '/consults'
    return <Navigate to={to} replace />
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await loginWithEmail(email, password)
      toast({ body: '로그인 성공' })
    } catch (err) {
      // 서버가 준 원문 오류를 그대로 보여주면 "이 이메일은 없는 계정" 같은 정보가 드러나
      // 계정 목록을 추측하는 데 쓰일 수 있다. 사용자에게는 항상 같은 문구만 보여준다.
      // (원인 파악에 필요한 원문은 브라우저 콘솔에만 남긴다.)
      console.error('[login]', err)
      toast({ body: '로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-shell">
      <Card className="login-card">
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>시대인재 CS 데이터</Heading>
            <Text type="supporting">카카오 상담 · 잔디 대화 조회 전용 계정으로 로그인하세요.</Text>
          </VStack>

          {!isSupabaseEnabled && (
            <Banner status="error" title="연결 정보가 설정되지 않았습니다" description="관리자에게 문의해 주세요." />
          )}

          <form onSubmit={onSubmit} id="login-form">
            <VStack gap={3}>
              <TextInput
                label="이메일"
                type="email"
                value={email}
                onChange={setEmail}
                isRequired
                autoComplete="email"
                isDisabled={!isSupabaseEnabled}
              />
              <TextInput
                label="비밀번호"
                type="password"
                value={password}
                onChange={setPassword}
                isRequired
                autoComplete="current-password"
                isDisabled={!isSupabaseEnabled}
              />
            </VStack>
          </form>

          <Button
            label={loading ? '로그인 중…' : '로그인'}
            variant="primary"
            type="submit"
            form="login-form"
            isDisabled={loading || !isSupabaseEnabled}
            width="100%"
          />
        </VStack>
      </Card>
    </div>
  )
}
