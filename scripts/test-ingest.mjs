// 서버 함수(kakao-ingest) 테스트는 Deno 로 돈다. Supabase Edge Functions 가 Deno 이기 때문이다.
// Deno 가 없는 컴퓨터에서는 건너뛴다(설치를 강제하지 않는다). 나머지 테스트는 그대로 돈다.
import { spawnSync } from 'node:child_process'

const has = spawnSync('deno', ['--version'], { stdio: 'ignore' }).status === 0
if (!has) {
  console.log('\n건너뜀: 서버 함수 테스트는 Deno 가 필요합니다.')
  console.log('        설치: curl -fsSL https://deno.land/install.sh | sh')
  console.log('        (설치 안 해도 나머지 테스트는 정상입니다.)\n')
  process.exit(0)
}

const r = spawnSync(
  'deno',
  ['test', '--allow-env', '--allow-net', '--allow-write=/var/tmp', '--allow-read', '--no-check', 'test/ingest_test.ts'],
  { stdio: 'inherit' },
)
process.exit(r.status ?? 1)
