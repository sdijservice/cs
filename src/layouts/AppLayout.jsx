// src/layouts/AppLayout.jsx — 2개 화면(카카오 상담 / 잔디 대화)만 갖는 최소 레이아웃.
// sdij-wiki 의 AdminLayout 과 같은 골격(Astryx AppShell)을 쓰되, 위키 없이 이 앱 단독으로 존재하므로
// 브레드크럼·역할 필터링·"사용자 사이트로 나가기" 링크 없이 로그아웃 버튼만 둔다.
import { Outlet, useLocation, Link as RRLink, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { Headset, ChatsCircle as Chats, CloudArrowUp, Moon, Sun, SignOut as LogOut } from '@phosphor-icons/react'

import { LinkProvider } from '@astryxdesign/core/Link'
import { AppShell, useAppShellMobile } from '@astryxdesign/core/AppShell'
import { SideNav, SideNavSection, SideNavItem } from '@astryxdesign/core/SideNav'
import { TopNav } from '@astryxdesign/core/TopNav'
import { Button } from '@astryxdesign/core/Button'

import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'

import { useAuth } from '@/store/authStore'
import { useDarkMode } from '@/hooks/useDarkMode'
import RouterLink from '@/components/RouterLink'
import './AppLayout.astryx.css'

const NAV_ITEMS = [
  { title: '카카오 상담', to: '/consults', icon: Headset },
  { title: '잔디 대화', to: '/jandi', icon: Chats },
]

// 조회가 아니라 "데이터를 모으는 쪽" 설정이라 섹션을 나눈다.
const SETUP_ITEMS = [
  { title: '수집 설정', to: '/collect', icon: CloudArrowUp },
]

function AppSideNav() {
  const { pathname } = useLocation()
  return (
    <SideNav
      className="app-sidenav"
      header={
        <RRLink to="/consults" aria-label="시대인재 CS 데이터" className="cs-brand">
          <span className="cs-brand-icon"><Headset weight="bold" size={16} /></span>
          <span className="cs-brand-text">
            <span className="cs-brand-title">CS 데이터</span>
            <span className="cs-brand-sub">시대인재</span>
          </span>
        </RRLink>
      }
    >
      <SideNavSection title="조회">
        {NAV_ITEMS.map(item => (
          <SideNavItem
            key={item.to}
            href={item.to}
            icon={item.icon}
            label={item.title}
            isSelected={pathname === item.to}
          />
        ))}
      </SideNavSection>
      <SideNavSection title="설정">
        {SETUP_ITEMS.map(item => (
          <SideNavItem
            key={item.to}
            href={item.to}
            icon={item.icon}
            label={item.title}
            isSelected={pathname === item.to}
          />
        ))}
      </SideNavSection>
    </SideNav>
  )
}

function ThemeToggle() {
  const { isDark, toggle } = useDarkMode()
  return (
    <Button isIconOnly variant="ghost" size="sm"
      label={isDark ? '라이트 모드로' : '다크 모드로'}
      icon={isDark ? <Sun size={18} /> : <Moon size={18} />}
      onClick={toggle} />
  )
}

function LogoutButton() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const onLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }
  return (
    <Button variant="ghost" size="sm" label="로그아웃" icon={<LogOut size={16} />} onClick={onLogout} />
  )
}

function AppTopNav() {
  const { user } = useAuth()
  return (
    <TopNav
      label="상단 내비게이션"
      startContent={<span className="cs-user-email">{user?.email}</span>}
      endContent={<div className="cs-topnav-actions"><ThemeToggle /><LogoutButton /></div>}
    />
  )
}

// AppShell 모바일 서랍은 라우터를 모른다 — 경로 변경 시 자동으로 닫아준다.
function CloseMobileNavOnNavigate() {
  const { pathname } = useLocation()
  const { closeMobileNav } = useAppShellMobile()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { closeMobileNav() }, [pathname])
  return null
}

export default function AppLayout() {
  // <Theme> 는 App.jsx 가 라우터 전체를 감싸며 한 번만 건다(로그인 화면도 같은 테마를 받도록).
  // 여기서 다시 감싸면 토큰이 중복 정의돼 모드 전환이 어긋날 수 있으므로 감싸지 않는다.
  return (
    <LinkProvider component={RouterLink}>
      <AppShell
        height="fill"
        contentPadding={0}
        sideNav={<AppSideNav />}
        topNav={<AppTopNav />}
        mobileNav={{ hasToggle: true }}
      >
        <CloseMobileNavOnNavigate />
        <div className="cs-content">
          <Outlet />
        </div>
      </AppShell>
    </LinkProvider>
  )
}
