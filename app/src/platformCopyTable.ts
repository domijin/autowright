// §9 per-OS copy rule — the one place the renderer's platform-naming wording
// lives. Every substitution the §9 table lists is read from here, keyed by the
// §9 store's `platformOs` token (the §19 GET /health `os` value): 'windows'
// and 'linux' take their own forms, every other token — including the '' boot
// default — keeps the macOS copy, so a mac render is byte-identical to a
// pre-rule one. No component ever sniffs the platform itself (§2/§9).
// Store-free on purpose: the e2e harness imports this table into a Node
// process (§15), where the renderer store's window listeners cannot load —
// components go through platformCopy.ts's usePlatformCopy instead.

export interface PlatformCopy {
  // §9 table machine noun: "this Mac" / "this PC". Uppercase surfaces
  // (eyebrows, mini badges) uppercase it themselves.
  machine: string
  // §9 table secret store: the §1 promise, the Secrets page, every "your
  // Keychain" line.
  secretStore: string
  // §9 table reveal target — the file manager's own name, for labels that name
  // it inside a longer phrase ("Show workspace in Finder").
  fileManager: string
  // §9 table reveal action — the standard button label.
  reveal: string
  // §4.9 PATH row: the hint sentence above the command block. The Windows form
  // carries the §9 "open a new terminal" instruction.
  pathHint: string
  // §4.9 PATH command block: the exact line the Copy button puts on the
  // clipboard.
  pathCommand: string
  // §9 table: the §3 per-OS shim location the COMMAND LINE card names as the
  // install location.
  cliBinDir: string
  // §9 table: "the Terminal" (the macOS app) → "a terminal" on Windows, for
  // copy that names where the `autowright` command is used.
  terminalNoun: string
  // §9 table: the §13 surface's own name — "menu bar" on macOS, "tray" on
  // Windows. Interpolated into the sentences that name it ("starts quietly in
  // the …", "Show in the …", "Execute now and the … still work").
  menuBar: string
  // §4.9 keepAwake row: the §3 sleep disclaimer sentence — what the idle-sleep
  // assertion cannot do (a closed-lid laptop runs nothing until it wakes).
  sleepNote: string
}

const MACOS: PlatformCopy = {
  machine: 'Mac',
  secretStore: 'Keychain',
  fileManager: 'Finder',
  reveal: 'Show in Finder',
  // Appends to ~/.zprofile (the login-shell init macOS Terminal reads) so it persists.
  pathHint: 'If your Terminal can’t find autowright, add ~/.local/bin to your PATH:',
  pathCommand: 'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zprofile && source ~/.zprofile',
  cliBinDir: '~/.local/bin',
  terminalNoun: 'the Terminal',
  menuBar: 'menu bar',
  sleepNote: 'Works best on an always-on Mac like a Mac mini or Mac Studio. A MacBook that is asleep would not trigger the automation.',
}

const WINDOWS: PlatformCopy = {
  machine: 'PC',
  secretStore: 'Credential Manager',
  fileManager: 'Explorer',
  reveal: 'Show in Explorer',
  pathHint: 'If your terminal can’t find autowright, add %LOCALAPPDATA%\\Autowright\\bin to your PATH, then open a new terminal:',
  // §9: never `setx` — it truncates at 1024 chars and bakes the expanded
  // system PATH into the user value. The user PATH is read and rewritten
  // through [Environment], which leaves the machine PATH alone.
  pathCommand: `[Environment]::SetEnvironmentVariable('Path', "$env:LOCALAPPDATA\\Autowright\\bin;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`,
  cliBinDir: '%LOCALAPPDATA%\\Autowright\\bin',
  terminalNoun: 'a terminal',
  menuBar: 'tray',
  sleepNote: 'Works best on an always-on desktop PC. A laptop that is asleep would not trigger the automation.',
}

const LINUX: PlatformCopy = {
  machine: 'PC',
  // §9 table: the freedesktop Secret Service store's plain name — the §1
  // promise reads "Secrets live in your system keyring".
  secretStore: 'system keyring',
  fileManager: 'file manager',
  reveal: 'Show in file manager',
  // §9: appends to ~/.profile — sourced by desktop sessions and login shells
  // alike (the same profile rule as the §19 installer's PATH guarantee).
  pathHint: 'If your terminal can’t find autowright, add ~/.local/bin to your PATH, then open a new terminal:',
  pathCommand: 'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.profile',
  cliBinDir: '~/.local/bin',
  terminalNoun: 'a terminal',
  menuBar: 'tray',
  sleepNote: 'Works best on an always-on desktop PC. A laptop that is asleep would not trigger the automation.',
}

/** §9 per-OS copy for a §5.1 platform token — the pure form, for module-level
 *  callers that read `platformOs` off the store themselves. */
export function platformCopy(os: string): PlatformCopy {
  return os === 'windows' ? WINDOWS : os === 'linux' ? LINUX : MACOS
}
