# OPTCG Recorder

Records your OPTCG Sim games automatically, tags each one from the sim's combat log
(your leader, the opponent's leader, going 1st/2nd, win/loss), and lets you search,
filter and rewatch them.

## Download

**[⬇ Download the latest release](https://github.com/khoile3009/optcg-recorder/releases/latest)** (Windows)

The release page has two files; either works:

- **`OPTCG-Recorder-Setup-<version>.exe`**: installer, adds a Start menu shortcut.
- **`OPTCG-Recorder-<version>-portable.exe`**: single exe, no install, just run it.

Windows only. The builds are not code-signed, so Windows SmartScreen will say
"Windows protected your PC" the first time. Click **More info → Run anyway**.

On first start the app asks where OPTCG Sim is installed (the folder you unzipped,
like `1.31a_Windows`). It usually finds it on its own. After that, start a game in the
sim and it records; finished games show up in the library.

Recordings live in `%APPDATA%\optcg-recorder\recordings` ("Open library folder" in
settings). Lower the quality in settings if files are too big.

## Develop

```bash
npm install
npm start        # run the app
npm test         # unit tests
npm run dist     # build dist/*.exe locally
```

## Cutting a release

```bash
npm version patch          # bumps package.json and creates tag vX.Y.Z
git push --follow-tags     # the Release workflow builds and publishes the exes
```
