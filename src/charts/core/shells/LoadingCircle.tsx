import React from 'react'
import { uiText } from '../../../localization'

function LoadingCircle(): JSX.Element {
  return (
    <div className="loading-circle" aria-label={uiText('auto.8f26c6520d61')} role="status">
      <span className="loading-circle-spinner" />
    </div>
  )
}

export default LoadingCircle
