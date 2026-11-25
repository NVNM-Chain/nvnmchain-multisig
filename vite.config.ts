import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages cannot send headers, so the built page carries its policy as a meta
 * tag. It is added for `build` only: `npm run dev` injects an inline module (the
 * React refresh preamble), which a strict `script-src 'self'` would block.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // React writes inline style attributes; the theme boot script is same-origin.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The chain RPC endpoints; the local network is listed by `npm run dev` only.
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ')
  return {
    name: 'nvnm-chain:content-security-policy',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

/**
 * Resolve the public base path.
 *
 * GitHub Pages serves a project site under `/<repo>/`, while user/org sites
 * (`<user>.github.io`) and custom domains serve from the root. We derive it from
 * the repo so no per-repo edit is needed, and allow an explicit override via
 * `BASE_PATH` (e.g. a custom domain sub-path).
 */
function resolveBase(): string {
  if (process.env.BASE_PATH) return process.env.BASE_PATH
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  if (repo && !repo.endsWith('.github.io')) return `/${repo}/`
  return '/'
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: resolveBase(),
  server: {
    port: 5174,
    host: true,
  },
})
