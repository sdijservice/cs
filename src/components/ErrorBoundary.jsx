// src/components/ErrorBoundary.jsx
// 화면 어딘가에서 예상 못 한 오류가 나면, 아무 안내 없는 흰 화면 대신 안내와 복구 버튼을 보여준다.
//
// 왜 필요한가: React 는 렌더 중 예외가 나면 화면 전체를 통째로 비운다. 이 장치가 없으면
// 사용자는 흰 화면만 보고 "고장났다"는 것 외에 아무 정보도, 다시 시도할 방법도 얻지 못한다.
// 원본 앱(sdij-wiki)에는 라우트마다 이 장치가 걸려 있었는데 이 저장소로 옮겨올 때 빠졌다.
//
// 주소가 바뀌면(resetKey) 자동으로 정상 상태로 되돌린다 - 오류 화면에 갇혀서 다른 메뉴로
// 못 가는 상황을 막기 위해서다.
import React from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '@astryxdesign/core/Heading'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidUpdate(prevProps) {
    // 다른 화면으로 이동하면 오류 상태를 푼다.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error, info) {
    // 브라우저 콘솔에는 남겨 둔다(개발자가 원인을 찾을 때 필요).
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div style={{ padding: 'var(--spacing-8)' }} role="alert">
        <Card>
          <VStack gap={4} paddingBlock={6} paddingInline={6}>
            <Heading level={2} size="sm">화면을 여는 중 문제가 생겼어요</Heading>
            <Text type="supporting">
              잠시 후 다시 시도해 주세요. 계속 같은 화면이 나오면 아래 오류 내용과 함께 알려 주세요.
            </Text>
            <Text type="supporting" size="sm">
              {String(this.state.error?.message ?? this.state.error)}
            </Text>
            <HStack gap={2}>
              <Button
                variant="primary"
                size="sm"
                label="다시 시도"
                onClick={() => this.setState({ error: null })}
              />
              <Button
                variant="secondary"
                size="sm"
                label="새로고침"
                onClick={() => window.location.reload()}
              />
            </HStack>
          </VStack>
        </Card>
      </div>
    )
  }
}
