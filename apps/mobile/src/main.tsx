import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

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
