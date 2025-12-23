// @ts-check
import { createRoot } from 'react-dom/client'

import Root from './Root.jsx'

const elementId = 'root'
const rootElement = document.getElementById(elementId)
if (rootElement) {
  createRoot(rootElement).render(<Root />)
} else {
  throw new Error(`No element with id '${elementId}' found in the document.`)
}
