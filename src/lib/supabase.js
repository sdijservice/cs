// src/lib/supabase.js
// Supabase 클라이언트 초기화
// 환경변수: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  if (import.meta.env.DEV) {
    console.info('[CS] Supabase 환경변수 미설정')
  }
}

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        global: { headers: { 'x-app-name': 'sdijservice-cs' } },
      })
    : null

export const isSupabaseEnabled = Boolean(supabase)
