import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { SIM_DIR_RE, simSearchRoots } from '../src/simdirs.mjs'

// A fake filesystem: a map of dir -> child dir names.
function fakeReaddir(tree) {
  return (dir) => {
    const kids = tree[path.normalize(dir)]
    if (!kids) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return kids.map((name) => ({ name, isDirectory: () => true }))
  }
}

const home = path.join(path.sep, 'home', 'tester')
const j = (...p) => path.join(home, ...p)

test('SIM_DIR_RE matches unpacked sim folders only', () => {
  for (const ok of ['1.31a_Windows', '1.4_Windows', '2.10b_windows']) assert.ok(SIM_DIR_RE.test(ok), ok)
  for (const no of ['Windows', '1.31a_Mac', 'v1.31a_Windows', '1.31a_Windows.zip']) assert.ok(!SIM_DIR_RE.test(no), no)
})

test('Windows searches home, Downloads and Desktop only', () => {
  const roots = simSearchRoots({ home, platform: 'win32', env: {}, readdir: fakeReaddir({}) })
  assert.deepEqual(roots, [home, j('Downloads'), j('Desktop')])
})

test('Linux adds Wine, Bottles, Proton and Lutris prefixes', () => {
  const tree = {
    [j('.wine', 'drive_c', 'users')]: ['tester', 'Public'],
    [j('.local', 'share', 'bottles', 'bottles')]: ['Games'],
    [j('.local', 'share', 'bottles', 'bottles', 'Games', 'drive_c', 'users')]: ['tester'],
    [j('.steam', 'steam', 'steamapps', 'compatdata')]: ['3141592'],
    [j('Games')]: ['optcg-sim'],
  }
  const roots = simSearchRoots({ home, platform: 'linux', env: { WINEPREFIX: '/opt/wine-sim' }, readdir: fakeReaddir(tree) })
  for (const want of [
    home,
    j('Downloads'),
    j('Games'),
    path.join('/opt/wine-sim', 'drive_c'),
    j('.wine', 'drive_c'),
    j('.wine', 'drive_c', 'users', 'tester', 'Downloads'),
    j('.wine', 'drive_c', 'users', 'Public', 'Desktop'),
    j('.local', 'share', 'bottles', 'bottles', 'Games', 'drive_c', 'users', 'tester', 'Desktop'),
    j('.steam', 'steam', 'steamapps', 'compatdata', '3141592', 'pfx', 'drive_c'),
    j('Games', 'optcg-sim', 'drive_c'),
  ]) assert.ok(roots.includes(want), want)
  assert.equal(new Set(roots).size, roots.length, 'no duplicates')
})

test('Linux with nothing installed still returns the basic roots', () => {
  const roots = simSearchRoots({ home, platform: 'linux', env: {}, readdir: fakeReaddir({}) })
  assert.ok(roots.includes(j('Desktop')))
  assert.ok(roots.includes(j('.wine', 'drive_c')))
})
