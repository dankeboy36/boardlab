// @ts-check
import { StrictMode } from 'react'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'

import { useCodiconStylesheet } from '@vscode-ardunno/base'
import { PortinoClientContextProvider } from '@vscode-ardunno/monitor-shared/serial-monitor'
import { store } from './app/store.js'
import App from './features/app/App.jsx'

/**
 * Root component that mirrors the production composition in `main.jsx`. Useful
 * for tests to render the exact app tree (StrictMode, Router, Redux, Portino
 * client provider) without duplicating wrappers.
 */
function Root() {
  useCodiconStylesheet()

  return (
    <StrictMode>
      <BrowserRouter>
        <Provider store={store}>
          <PortinoClientContextProvider>
            <App />
          </PortinoClientContextProvider>
        </Provider>
      </BrowserRouter>
    </StrictMode>
  )
}

export default Root
