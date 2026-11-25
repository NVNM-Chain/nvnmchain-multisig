import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// GitHub Pages cannot send X-Frame-Options or a `frame-ancestors` CSP directive, so
// refuse to render inside a frame: Sign and Execute must never be clickjackable.
if (window.self !== window.top) {
  const message = document.createElement('p')
  message.style.cssText = 'font:16px system-ui;padding:24px'
  message.textContent = 'This app refuses to run inside a frame. Open it in its own tab.'
  document.body.replaceChildren(message)
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
