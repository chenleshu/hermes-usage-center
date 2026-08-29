import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reuse the installed host's React and DOM libraries; do not install a second React.
const hostRequire = createRequire(resolve(process.env.HERMES_DESKTOP_ROOT, 'package.json'))
const hostModules = Object.fromEntries(
  ['react', 'react/jsx-runtime', 'react-dom/server', 'jsdom'].map(name => [name, pathToFileURL(hostRequire.resolve(name)).href])
)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@hermes/plugin-sdk') {
      return { url: new URL('./desktop-sdk.mjs', import.meta.url).href, shortCircuit: true }
    }
    if (hostModules[specifier]) {
      return { url: hostModules[specifier], shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
