import { mount } from 'svelte'
import App from './App.svelte'
import '@leonardschwier/leoforma/fonts.css'
import '@leonardschwier/leoforma/tokens.css'
import './app.css'

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
