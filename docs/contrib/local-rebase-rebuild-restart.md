---
description: Windows runbook for rebasing local Cherry Studio commits, rebuilding the packaged app, restarting it safely, and verifying desktop and taskbar shortcuts
sources:
  - package.json
  - electron-builder.yml
  - scripts/packaging/before-pack.js
  - .agents/skills/cherry-electron-dev/references/electron-instance.md
---

# Rebase, rebuild, and restart local Cherry Studio on Windows

Use this guide for the local Windows x64 packaged application built from this
checkout. Examples use `v2.1.6`; select the intended tag explicitly on each run.
A source rebase, a successful build, and a running updated application are three
separate milestones. Do not infer one from another.

Read [development setup](development.md), `CLAUDE.md`, and any `CLAUDE.local.md`
first. For runtime discovery and replacement, follow the authoritative
[Electron instance procedure](../../.agents/skills/cherry-electron-dev/references/electron-instance.md)
with the `persistent` policy. The Windows examples below supplement it.

## 1. Inventory the checkout and running application

Run PowerShell from the repository root. Execute each phase separately and stop
on any failed command. `$ErrorActionPreference` does not make native command
failures terminating in Windows PowerShell, so check `$LASTEXITCODE` explicitly.

```powershell
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$targetTag = 'v2.1.6'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$artifacts = Join-Path $repo ".context/cherry-electron-dev/upgrade-$targetTag-$stamp"
New-Item -ItemType Directory -Path $artifacts | Out-Null
git status --short --branch
git log -10 --oneline
git remote -v
Get-Content package.json
if (Test-Path .context/cherry-electron-dev/instance.json) {
    Get-Content .context/cherry-electron-dev/instance.json
}
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -match 'Cherry|electron|node' } |
    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
```

Record the current branch, HEAD, dirty files, executable path, main PID, parent
process, launch arguments, user-data directory, and ports. Process names alone
are insufficient: other checkouts and applications also run Electron or Node.
On Windows, CIM does not expose cwd; use the absolute executable/launch path,
parent command, and CDP target together. If these cannot establish the workspace,
do not control that process. A stale `instance.json` is not proof of identity.

Inspect both the user and Public desktop and the taskbar directory. Windows may
redirect the user desktop to OneDrive, so use the known-folder API:

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$taskbar = Join-Path $env:APPDATA 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @($desktop, $publicDesktop, $taskbar)) {
    Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue |
        ForEach-Object {
            $link = $shell.CreateShortcut($_.FullName)
            if ($_.Name -match 'Cherry' -or $link.TargetPath -match 'Cherry') {
                [pscustomobject]@{
                    Shortcut = $_.FullName
                    Target = $link.TargetPath
                    Arguments = $link.Arguments
                    WorkingDirectory = $link.WorkingDirectory
                    Icon = $link.IconLocation
                }
            }
        }
}
```

Save this inventory under `$artifacts`. Preserve the original launch/profile
arguments. Do not move or reset the user's database, cache, or preferences.

## 2. Protect local work and identify the replay boundary

Create a backup branch before changing history:

```powershell
$originalBranch = git branch --show-current
if (!$originalBranch) { throw 'Check out the intended local branch first.' }
$oldHead = git rev-parse HEAD
$backupBranch = "backup/before-$targetTag-$stamp"
git branch $backupBranch $oldHead
if ($LASTEXITCODE) { throw 'Backup branch creation failed.' }
git fetch --tags origin
if ($LASTEXITCODE) { throw 'Fetch failed; do not rebase.' }
git rev-parse --verify "$targetTag^{commit}"
if ($LASTEXITCODE) { throw 'Target tag is unavailable.' }
```

Confirm `origin` is the intended upstream before fetching; substitute the verified
upstream remote if necessary. Never force-update a conflicting existing tag.

If the worktree is dirty, inspect `git diff` and `git diff --cached`, then stash
the intended changes, including untracked files when required:

```powershell
git stash push --include-untracked -m "before-$targetTag-$stamp"
if ($LASTEXITCODE) { throw 'Stash failed.' }
$savedStash = git rev-parse 'stash@{0}'
git status --short
```

Run this block only when there are changes to stash; otherwise it could capture
an older unrelated stash. Ignored files are not included. Back up any required
ignored assets separately. Keep the saved stash until restoration is verified.

Inspect the history to find the **old upstream boundary**, immediately before
the local commits intended for replay:

```powershell
git log --graph --decorate --oneline -35
git merge-base HEAD $targetTag
```

Set `$oldBase` to the verified commit or old release tag, then inspect:

```powershell
# Replace with the verified boundary; do not guess from this example.
$oldBase = 'REPLACE_WITH_OLD_UPSTREAM_COMMIT'
git log --reverse --oneline "$oldBase..$backupBranch"
git diff --stat "$oldBase..$backupBranch"
```

Every commit in this range must be intentional local work. A merge base may be
too old when release branches diverge: plain `git rebase <tag>` can replay
upstream commits and cause unnecessary conflicts. If the range contains merges,
decide whether their topology must be preserved before proceeding.

## 3. Rebase and restore local files

For a reviewed linear local range, preserve repository signing requirements:

```powershell
git rebase --gpg-sign --onto $targetTag $oldBase $originalBranch
if ($LASTEXITCODE) { throw 'Rebase stopped; inspect conflicts or signing errors.' }
```

Resolve conflicts file by file, stage only the resolved paths, and use
`git rebase --continue`. Preserve DCO sign-offs in commit messages. Do not disable
signing to bypass a signer failure. Use `git rebase --abort` to return to the
pre-rebase branch when resolution is uncertain. Never skip a commit merely to
make the rebase pass.

For migration conflicts, follow `CLAUDE.md`: regenerate the unshipped local
migration rather than renumbering it; never rewrite a shipped migration.

```powershell
git merge-base --is-ancestor $targetTag HEAD
if ($LASTEXITCODE) { throw 'Target tag is not an ancestor of HEAD.' }
git range-diff "$oldBase..$backupBranch" "$targetTag..HEAD"
git log --oneline "$targetTag..HEAD"
git cat-file commit HEAD
```

Review range-diff for dropped or altered changes; inspect signatures on all
replayed commits, not only HEAD. If a stash was created, restore by its saved ID:

```powershell
git stash apply --index $savedStash
if ($LASTEXITCODE) { throw 'Resolve stash conflicts before building.' }
git diff --stat
git diff --cached --stat
git status --short
```

Use `apply` instead of `pop` so recovery remains available. Quote PowerShell
stash references such as `'stash@{0}'`. Never restore whole conflicted files from
the stash without checking whether that would overwrite new upstream content.

## 4. Select the required toolchain and prepare dependencies

Read the target checkout's `engines` and `packageManager` in `package.json`.
At `v2.1.6` this fork requires Node >=24.12.0 and pins pnpm 12.6.0. Use compatible
installed tools; do not bypass engine checks or silently upgrade the lockfile.

```powershell
Get-Command node, pnpm | Select-Object Name, Source
node --version
pnpm --version
pnpm install --frozen-lockfile
if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
pnpm rebuild:electron
if ($LASTEXITCODE) { throw 'Electron/native dependency setup failed.' }
pnpm download:binaries
if ($LASTEXITCODE) { throw 'Required binary download failed.' }
```

For this workstation, an existing compatible Node runtime may be under
`.context/cherry-electron-dev/upgrade-v2.1.4/runtime/`. Its directory name describes
when it was installed, not the app version it can build. Verify its actual version
and prepend its directory to the current process's PATH if needed. Also inspect
any `runtime-bin/pnpm.cmd` shim and verify its target exists before using it.

Put both directories on PATH for the current PowerShell session. Calling a pnpm
shim by absolute path alone is insufficient: scripts such as `pnpm build` invoke
`pnpm` again. For this workstation's existing toolchain:

```powershell
$nodeBin = (Resolve-Path '.context/cherry-electron-dev/upgrade-v2.1.4/runtime/node-v24.21.0-win-x64').Path
$pnpmBin = (Resolve-Path '.context/cherry-electron-dev/upgrade-v2.1.6/runtime-bin').Path
$env:PATH = "$nodeBin;$pnpmBin;$env:PATH"
node --version
pnpm --version
```

Use your verified installed directories if those historical paths are absent.

If native rebuilds fail, inspect the error for missing Electron downloads,
Python/MSVC build prerequisites, or ABI mismatches. Do not globally approve all
dependency scripts. Tests may rebuild `better-sqlite3` for Node; rerun
`pnpm rebuild:electron` afterward before launching Electron.

## 5. Quit the verified old instance and build a fresh package

Finish active chats, indexing, backups, and migrations. Use the verified app's
Quit/Exit action and allow it to finish. Closing a window may only hide it to the
tray. On Windows, `Stop-Process` is not a graceful SIGTERM equivalent; do not use
it as the default shutdown method. The user has authorized force-stopping the
exact verified local Cherry Studio instance as a fallback when Quit fails or
cannot be reached. No additional confirmation is needed for that fallback.
First check that no migration, backup, or indexing operation is active; forced
termination can interrupt writes and lose unsaved work. If such work is active,
wait for it to finish before proceeding.

For the fallback, recheck the main PID from this run's inventory, its executable
path, creation time, and parent immediately before stopping it. Never copy a
historical PID from this guide or stop every process named Electron/Cherry Studio.
After setting `$verifiedMainPid` to that freshly verified main PID:

```powershell
$expectedExe = Join-Path $repo 'dist/win-unpacked/Cherry Studio.exe'
$verifiedMain = Get-CimInstance Win32_Process -Filter "ProcessId = $verifiedMainPid"
if (!$verifiedMain -or $verifiedMain.ExecutablePath -ine $expectedExe) {
    throw 'Process identity changed; rediscover the local app before stopping it.'
}
$stopCandidate = Get-Process -Id $verifiedMainPid
$startTimeDifference = ($stopCandidate.StartTime.ToUniversalTime() - $verifiedMain.CreationDate.ToUniversalTime()).TotalMilliseconds
if ($stopCandidate.Path -ine $expectedExe -or
    [Math]::Abs($startTimeDifference) -ge 1) {
    throw 'Process was replaced; rediscover it before stopping it.'
}
Stop-Process -InputObject $stopCandidate -Force
$stopCandidate.WaitForExit(8000) | Out-Null
if (!$stopCandidate.HasExited) { throw 'Verified process has not exited.' }
```

Reinspect descendants and listeners afterward. If any remain, validate each
against the recorded process tree and executable path before stopping its exact
PID; do not kill arbitrary port owners. Stop a leftover development runner only
after verifying its workspace and relationship to the app. Record whether
shutdown was graceful or forced in the run's evidence.
The creation-time comparison allows submillisecond rounding differences between
CIM and `Get-Process`; their timestamp precision differs on Windows.

Confirm the recorded old main PID has exited and its ports are released. Back up
the existing user-data directory while the app is stopped, including databases
and sidecar files. Keep a copy of the old packaged directory outside the next
build output if rollback is required. Do not copy a live SQLite database as if
it were a consistent backup. Do not delete the profile to solve startup problems.

Build and package explicitly for Windows x64, capturing separate logs:

```powershell
pnpm build 2>&1 | Tee-Object -FilePath (Join-Path $artifacts 'build.log')
if ($LASTEXITCODE) { throw 'Build failed; do not launch stale output.' }
pnpm exec electron-builder --win --x64 --dir 2>&1 |
    Tee-Object -FilePath (Join-Path $artifacts 'package.log')
if ($LASTEXITCODE) { throw 'Packaging failed; do not launch stale output.' }
$exe = Join-Path $repo 'dist/win-unpacked/Cherry Studio.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Expected packaged executable missing.' }
Get-Item -LiteralPath $exe | Select-Object FullName, LastWriteTime, VersionInfo
Get-FileHash -LiteralPath (Join-Path $repo 'dist/win-unpacked/resources/app.asar')
git rev-parse HEAD
git status --short
```

`pnpm build` includes typechecking and utility-process output. It alone does not
produce the packaged executable. Confirm the output path in packaging logs if
builder configuration changes. Save the Git HEAD, dirty-file status, package
version, build time, and ASAR hash in the run's evidence. A version string alone
cannot distinguish local commits built on the same release tag.

### Windows packaging failure: `node-pty` / `MSB8040`

If packaging fails rebuilding `node-pty` because Visual Studio lacks
Spectre-mitigated libraries, inspect the current packaging configuration before
installing build components. In this checkout, `electron-builder.yml` excludes
`node-pty/build/**` and ships the upstream platform prebuilds. The packaging hook
in `scripts/packaging/before-pack.js` separately rebuilds `better-sqlite3` for the
target Electron version.

After verifying those rules still apply and the Windows x64 prebuilds exist,
retry packaging with this command-only override:

```powershell
pnpm exec electron-builder --win --x64 --dir --config.npmRebuild=false 2>&1 |
    Tee-Object -FilePath (Join-Path $artifacts 'package-prebuilt.log')
if ($LASTEXITCODE) { throw 'Prebuilt packaging retry failed.' }
```

Do not change tracked configuration or disable Spectre mitigation to work around
this local toolchain issue. Before accepting the package, test the actual shipped
native modules under the same Electron version: an in-memory SQLite query and a
`node-pty` child-process launch. Use an isolated temporary test profile and close
only that test process afterward. Both checks passed for this workflow on
2026-10-17 with Electron 44.4.0. Repeat them when dependency versions change;
`npmRebuild=false` is not a general fix for native-module failures.

## 6. Relaunch and prove the running build

Choose a free CDP port, for example 9222, after inspecting listener ownership:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

Do not terminate an unrelated port owner. Adjust the port if occupied. Preserve
the inventoried profile arguments; the following example assumes no custom ones:

```powershell
$cdpPort = 9222
$app = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) `
    -ArgumentList "--remote-debugging-port=$cdpPort" -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $artifacts 'launch.stdout.log') `
    -RedirectStandardError (Join-Path $artifacts 'launch.stderr.log')
$app.Id
```

After startup, inspect the actual main process and its listener. A launcher PID
that immediately exits may indicate an existing single-instance application;
do not declare that a successful replacement.

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = $($app.Id)" |
    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
Get-NetTCPConnection -State Listen -LocalPort $cdpPort |
    Select-Object LocalAddress, LocalPort, OwningProcess
Invoke-RestMethod "http://127.0.0.1:$cdpPort/json/version"
Invoke-RestMethod "http://127.0.0.1:$cdpPort/json/list" |
    Select-Object id, type, title, url
```

Match the Cherry Studio main window explicitly. For the packaged build, expect
the URL to point inside this checkout's `dist/win-unpacked/resources/app.asar/`
and end in `/windows/main/index.html`. Development URLs usually use localhost;
they do not prove the packaged application is running.

Check the displayed app version, normal chat and knowledge-base access, and
startup logs. If the local API was already enabled, check its existing health
endpoint without changing API settings. Do not expose keys in logs.

Only after verification, refresh `.context/cherry-electron-dev/instance.json`
with the fields required by the runtime reference: workspace, Git HEAD, policy,
ownership, launch purpose, workflow relation, Electron/runner PIDs, process group,
CDP/inspector ports, exact target URL, profile suffix, command, log path, and
start time. Use null for genuinely absent fields. Also record the verified
user-data path and packaged executable. Leave the healthy app running.

For development-only work, use `pnpm debug` and the runtime reference instead;
do not repoint packaged desktop shortcuts to `node_modules/electron`.

## 7. Update and test desktop and taskbar launchers

The stable target is this checkout's `dist/win-unpacked/Cherry Studio.exe`.
Keep the entire packaged directory together. Back up each identified `.lnk`
before modifying it. Update only the exact Cherry Studio shortcut selected from
the inventory, preserving intentional arguments and profile selection.

```powershell
# Use the exact inventoried path; this example is the current user's desktop.
$shortcutPath = Join-Path $desktop 'Cherry Studio.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $artifacts 'desktop-original.lnk')
}
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = $exe
$link.WorkingDirectory = Split-Path $exe
$link.IconLocation = "$exe,0"
# Review $link.Arguments against the saved inventory before saving.
$link.Save()
$check = $shell.CreateShortcut($shortcutPath)
$check | Select-Object TargetPath, Arguments, WorkingDirectory, IconLocation
```

Apply the same field updates to the exact inventoried taskbar `.lnk`, with a
distinct backup filename. Public desktop changes may require elevated permission;
do not silently create a duplicate user shortcut instead.

Windows may retain cached taskbar identity after a `.lnk` edit. If clicking the
pin still launches an older installation, unpin that item and pin the verified
running packaged application again. Do not restart Explorer or edit unrelated
registry/taskbar entries as a shortcut repair.

Test the desktop shortcut and taskbar item **separately from a fully quit app**.
An already-running app can absorb a launch from an old executable through its
single-instance lock, producing a false positive. After each launch, recheck the
main PID's executable path and version. If the shortcut omits CDP arguments, use
process-path and UI evidence; do not assume the previous CDP endpoint still exists.
Refresh the runtime record to match the final running instance and its actual
ports. Leave that verified instance running.

## Recovery and completion

- Rebase conflict: inspect and resolve, or `git rebase --abort`; retain the backup
  branch and stash. Avoid destructive resets of restored local work.
- Build/package failure: retain logs and the prior package; do not relabel stale
  output as new. Fix the specific toolchain/build error and repeat the failed phase.
- Startup failure: inspect logs, profile locks, native ABI, and migrations. Never
  erase user data. A binary rollback after a database migration may be unsafe;
  use the matching pre-upgrade profile backup only through a deliberate recovery.
- Wrong shortcut target: restore the saved link or repair the exact target and
  repeat the fully-quit launch test.

Report completion with the target tag and new HEAD, preserved local commits and
files, successful build/package logs, executable path and ASAR hash, verified
running PID/profile, desktop and taskbar launch results, and runtime-record path.
List any incomplete phase explicitly. Keep recovery artifacts until the user has
confirmed normal operation; do not automatically drop stashes or delete backups.
