// @ts-check
import { StrictMode } from 'react'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'

import { useCodiconStylesheet } from '@boardlab/base'
import { MonitorClientContextProvider } from '@boardlab/monitor-shared/serial-monitor'
import { store } from './app/store.js'
import App from './features/app/App.jsx'

/**
 * Root component that mirrors the production composition in `main.jsx`. Useful
 * for tests to render the exact app tree (StrictMode, Router, Redux, Monitor
 * client provider) without duplicating wrappers.
 */
function Root() {
  useCodiconStylesheet()

  return (
    <StrictMode>
      <BrowserRouter>
        <Provider store={store}>
          <MonitorClientContextProvider>
            <App />
          </MonitorClientContextProvider>
        </Provider>
      </BrowserRouter>
    </StrictMode>
  )
}

export default Root
