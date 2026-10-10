import { defineEventHandler, setHeader } from 'h3'
import { PANEL_CLIENT_SCRIPT } from '../../../utils/plugin-panel'

export default defineEventHandler(event => {
  setHeader(event, 'Content-Type', 'text/javascript; charset=utf-8')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Cache-Control', 'no-store')
  return PANEL_CLIENT_SCRIPT
})
