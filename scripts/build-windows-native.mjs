import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { release } from 'node:os'

if (process.platform !== 'win32' || process.arch !== 'x64' || Number(release().split('.')[0]) < 10) {
  console.error('Build the Windows context bridge on Windows 10/11 x64 with Visual Studio C++ Build Tools and a Windows SDK. Linux cannot validate this bridge.')
  process.exit(1)
}
const require = createRequire(import.meta.url)
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../native/windows-context')
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--arch=x64', '--directory', directory], {
  stdio: 'inherit', windowsHide: true, env: { ...process.env }
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
