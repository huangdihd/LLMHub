import { readFile } from 'node:fs/promises'
import { setHeader, type H3Event } from 'h3'

/** Kept dependency-free: the same source is injected before plugin scripts and served for inspection. */
export const PANEL_CLIENT_SCRIPT = String.raw`(() => {
  'use strict';
  const channel = 'llmhub:panel:v1';
  const pending = new Map();
  let sequence = 0;
  const send = message => parent.postMessage({ channel, ...message }, '*');
  const api = {
    theme: 'light',
    fetch(path, options = {}) {
      if (pending.size >= 32) return Promise.reject(new Error('Too many panel requests'));
      const requestId = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Panel request timed out')); }, 30000);
        pending.set(requestId, { resolve, reject, timer });
        try {
          send({ type: 'fetch', requestId, path, method: options.method || 'GET', ...('body' in options ? { body: options.body } : {}) });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    setHeight(height) { send({ type: 'height', height }); }
  };
  Object.defineProperty(window, 'llmhub', { value: api });
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || event.data.channel !== channel) return;
    const message = event.data;
    if (message.type === 'theme' && ['light', 'dark'].includes(message.theme)) {
      api.theme = message.theme;
      document.documentElement.dataset.theme = message.theme;
      document.documentElement.style.colorScheme = message.theme;
      dispatchEvent(new CustomEvent('llmhub:theme', { detail: message.theme }));
      return;
    }
    if (message.type !== 'response' || typeof message.requestId !== 'string' || typeof message.ok !== 'boolean') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || 'Panel request failed'));
  });
  send({ type: 'ready' });
  addEventListener('DOMContentLoaded', () => {
    const report = () => api.setHeight(Math.max(120, Math.min(1200, Math.ceil(document.documentElement.scrollHeight))));
    new ResizeObserver(report).observe(document.body || document.documentElement);
    report();
  });
})();`

export const PANEL_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export async function servePluginPanel(event: H3Event, filename: string): Promise<string> {
  const html = await readFile(filename, 'utf8')
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Security-Policy', PANEL_CSP)
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  // Insert before any plugin-controlled markup, without invalidating a leading HTML doctype.
  const doctype = html.match(/^\s*<!doctype\s+html\s*>/i)?.[0] || ''
  // srcdoc does not inherit this response's headers. Repeat resource restrictions in a
  // leading meta policy; sandbox itself is enforced by both the header and host iframe.
  const resourcePolicy = PANEL_CSP.replace('sandbox allow-scripts; ', '')
  return `${doctype}<meta http-equiv="Content-Security-Policy" content="${resourcePolicy}"><script>${PANEL_CLIENT_SCRIPT}</script>${html.slice(doctype.length)}`
}
