// Where to look for an unpacked OPTCG Sim (folders like `1.31a_Windows`).
// On Windows that is home, Downloads and Desktop. On Linux the Windows build runs
// under Wine, so the same folders are also searched inside Wine prefixes: the
// default ~/.wine, $WINEPREFIX, Bottles, Steam Proton (non-Steam games) and
// Lutris' ~/Games. Pure apart from the injected readdir, so it is testable.
import fs from 'node:fs'
import path from 'node:path'

export const SIM_DIR_RE = /^\d+\.\d+\w*_Windows$/i

function subdirs(dir, readdir) {
  try {
    return readdir(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
  } catch {
    return []
  }
}

/** The folders that may hold a `<version>_Windows` sim folder, in search order. */
export function simSearchRoots({ home, platform = process.platform, env = process.env, readdir = fs.readdirSync } = {}) {
  const near = (dir) => [dir, path.join(dir, 'Downloads'), path.join(dir, 'Desktop')]
  const roots = near(home)
  if (platform !== 'linux') return roots

  roots.push(path.join(home, 'Games'))
  const prefixes = [
    env.WINEPREFIX,
    path.join(home, '.wine'),
    ...subdirs(path.join(home, '.local', 'share', 'bottles', 'bottles'), readdir),
    ...subdirs(path.join(home, '.steam', 'steam', 'steamapps', 'compatdata'), readdir).map((d) => path.join(d, 'pfx')),
    ...subdirs(path.join(home, 'Games'), readdir),
  ].filter(Boolean)
  for (const prefix of prefixes) {
    const c = path.join(prefix, 'drive_c')
    roots.push(c)
    for (const user of subdirs(path.join(c, 'users'), readdir)) roots.push(...near(user))
  }
  return [...new Set(roots)]
}
