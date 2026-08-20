// src/lib/astryxMode.js
// Astryx <Theme mode> 를 앱의 다크모드(.dark 클래스)에 동기화하는 훅.
// <html>.dark 클래스를 MutationObserver로 관찰 — 어느 컴포넌트가 토글하든 즉시 반영된다.
import { useEffect, useState } from 'react'

function readDarkClass() {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

/** 현재 앱 다크모드 상태를 Astryx mode('light' | 'dark')로 반환. .dark 클래스 변화를 실시간 반영. */
export function useAstryxMode() {
  const [isDark, setIsDark] = useState(readDarkClass)

  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      const dark = root.classList.contains('dark')
      setIsDark(prev => (prev === dark ? prev : dark))
    }
    sync()

    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDark ? 'dark' : 'light'
}
