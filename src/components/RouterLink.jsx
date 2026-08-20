// src/components/RouterLink.jsx
// Astryx LinkProvider용 어댑터 — Astryx 컴포넌트가 넘기는 `href`를 react-router SPA 이동으로 연결.
import { forwardRef } from 'react'
import { NavLink } from 'react-router-dom'

const RouterLink = forwardRef(function RouterLink({ href, to, ...props }, ref) {
  const target = href ?? to ?? '#'
  const isInternal = typeof target === 'string' && target.startsWith('/')
  if (!isInternal) {
    return <a ref={ref} href={target} {...props} />
  }
  return <NavLink ref={ref} to={target} end {...props} />
})

export default RouterLink
