// src/store/authStore.jsx — Supabase Auth 연동. 역할·권한 체계 없이 로그인 여부만 본다
// (이 앱은 카카오 상담·잔디 데이터 조회 전용 단일 목적 도구라 역할 구분이 필요 없다).
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseEnabled } from '@/lib/supabase'

const AuthContext = createContext(null)

function mapSupabaseUser(u) {
  const meta = u.user_metadata || {}
  return {
    id:    u.id,
    email: u.email,
    name:  meta.full_name || meta.name || u.email?.split('@')[0] || '사용자',
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(isSupabaseEnabled)

  useEffect(() => {
    if (!isSupabaseEnabled) return
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session ? mapSupabaseUser(session.user) : null)
      setIsLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? mapSupabaseUser(session.user) : null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const loginWithEmail = useCallback(async (email, password) => {
    if (!isSupabaseEnabled) throw new Error('Supabase 환경변수가 설정되지 않았습니다')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data.user
  }, [])

  const logout = useCallback(async () => {
    if (isSupabaseEnabled) await supabase.auth.signOut()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{
      user, isLoading,
      loginWithEmail, logout,
      isAuthenticated: Boolean(user),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth는 AuthProvider 안에서만 사용 가능합니다')
  return ctx
}
