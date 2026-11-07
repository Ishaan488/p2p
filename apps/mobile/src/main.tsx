import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@fontsource-variable/inter'
import './styles/tokens.css'
import './styles/compat.css'
import './styles/base.css'
import './styles/ui.css'
import './styles/media.css'
import './styles/screens.css'

// Ensure any stale ServiceWorker caches in WebView are purged immediately
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const r of registrations) {
      r.unregister();
    }
  }).catch(() => {});
}
if ('caches' in window) {
  caches.keys().then(names => {
    for (const name of names) {
      caches.delete(name);
    }
  }).catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
