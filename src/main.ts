import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      (registration) => console.log('SW registered:', registration.scope),
      (error) => console.log('SW registration failed:', error)
    )
  })
}
