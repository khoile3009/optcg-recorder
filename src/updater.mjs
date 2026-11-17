// Update checks against GitHub releases.
// Installed builds download the update in the background and install it on restart
// (electron-updater reads latest.yml from the release). The portable exe can't replace
// itself, so it only learns that a newer version exists and links to the release page.
import { app, net } from 'electron'
import updaterPkg from 'electron-updater'

const { autoUpdater } = updaterPkg
const REPO = 'khoile3009/optcg-recorder'
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** Newer semver (x.y.z, optional leading v)? Pre-release suffixes are ignored. */
export function isNewer(latest, current) {
  const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const a = parts(latest)
  const b = parts(current)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * @param {(u: {version: string, ready: boolean, url?: string}) => void} onUpdate
 *   ready: downloaded and installable with installUpdate(); url: portable, download it manually.
 */
export function startUpdateChecks(onUpdate, log = console.warn) {
  if (!app.isPackaged) return
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR

  if (portable) {
    const check = async () => {
      try {
        const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'optcg-recorder' },
        })
        if (!res.ok) return
        const rel = await res.json()
        if (rel.tag_name && isNewer(rel.tag_name, app.getVersion()))
          onUpdate({ version: rel.tag_name.replace(/^v/, ''), ready: false, url: rel.html_url })
      } catch (e) {
        log('update check failed:', e?.message ?? e)
      }
    }
    void check()
    setInterval(check, CHECK_EVERY_MS)
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => onUpdate({ version: info.version, ready: true }))
  autoUpdater.on('error', (e) => log('auto-update failed:', e?.message ?? e))
  const check = () => autoUpdater.checkForUpdates().catch((e) => log('update check failed:', e?.message ?? e))
  void check()
  setInterval(check, CHECK_EVERY_MS)
}

export function installUpdate() {
  // Silent install, then relaunch the app.
  autoUpdater.quitAndInstall(true, true)
}
