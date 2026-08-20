// src/components/RequireAuth.jsx — 라우트 가드. 로그인 없으면 /login 으로.
// 실제 데이터 접근 제어는 Supabase RLS(=Row Level Security, 어느 행을 볼 수 있는지 DB가
// 정하는 규칙)로 이중 차단한다 — 이 컴포넌트는 화면 이동만 담당하는 UI 가드다.
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/store/authStore'
import { Skeleton } from '@astryxdesign/core/Skeleton'
import { VStack } from '@astryxdesign/core/VStack'

export function RequireAuth() {
  const { isAuthenticated, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div style={{ padding: 32 }} role="status" aria-live="polite" aria-label="로그인 확인 중">
        <VStack gap={4}>
          <Skeleton width={160} height={24} />
          <Skeleton width="100%" height={16} />
        </VStack>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <Outlet />
}
