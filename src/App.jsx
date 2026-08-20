// src/App.jsx — 카카오 상담·잔디 대화 조회 전용 앱. 위키·에디터·검색 등은 없다.
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastViewport } from '@astryxdesign/core/Toast'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import { AuthProvider } from '@/store/authStore'
import { RequireAuth } from '@/components/RequireAuth'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAstryxMode } from '@/lib/astryxMode'
import AppLayout from '@/layouts/AppLayout'
import LoginPage from '@/pages/LoginPage'
import ConsultsPage from '@/pages/ConsultsPage'
import JandiPage from '@/pages/JandiPage'
import CollectPage from '@/pages/CollectPage'
import './App.astryx.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
})

// 오류 경계는 주소가 바뀌면 자동으로 풀려야 한다(오류 화면에 갇히지 않도록).
// useLocation 은 Router 안에서만 쓸 수 있어 별도 컴포넌트로 뺐다.
function RoutedBoundary({ children }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

export default function App() {
  // ⚠️ <Theme> 는 반드시 라우터 **전체**를 감싼다. 예전에는 AppLayout 안에만 있어서
  //    로그인 화면과 "로그인 확인 중" 화면이 디자인시스템 밖에 놓였고, 그 두 화면만
  //    토큰(색·간격)이 적용되지 않아 다른 앱처럼 보였다.
  const mode = useAstryxMode()

  return (
    <QueryClientProvider client={queryClient}>
      <Theme theme={neutralTheme} mode={mode}>
        <ToastViewport position="bottomEnd" maxVisible={3}>
          <AuthProvider>
            <BrowserRouter>
              <RoutedBoundary>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route element={<RequireAuth />}>
                    <Route element={<AppLayout />}>
                      <Route index element={<Navigate to="/consults" replace />} />
                      <Route path="/consults" element={<ConsultsPage />} />
                      <Route path="/jandi" element={<JandiPage />} />
                      <Route path="/collect" element={<CollectPage />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </RoutedBoundary>
            </BrowserRouter>
          </AuthProvider>
        </ToastViewport>
      </Theme>
    </QueryClientProvider>
  )
}
