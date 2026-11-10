export type KeyDiff = {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: number
}

/** Where this machine stands compared with the shared (encrypted) file. Computed without a password. */
export type SyncState =
  | "empty"
  | "not-shared"
  | "not-downloaded"
  | "unknown"
  | "synced"
  | "local-changes"
  | "incoming-changes"
  | "conflict"
  | "broken"

export type EnvStatus = {
  name: string
  file: string
  encryptedFile: string
  isDefault: boolean
  sync: SyncState
  local: { exists: boolean; size?: number; modifiedAt?: string; error?: string }
  vault: {
    exists: boolean
    size?: number
    modifiedAt?: string
    valid: boolean
    error?: string
    encryptedAt?: string
    environment?: string
    environmentMatches?: boolean
    kdf?: { N: number; r: number; p: number }
  }
  git: { inRepo: boolean; tracked?: boolean; ignored?: boolean }
  vaultGit: {
    inRepo: boolean
    tracked?: boolean
    /** Changed or new in the working tree. */
    uncommitted?: boolean
    /** Committed but not pushed to the upstream branch. */
    unpushed?: boolean
    /** The upstream branch has a newer version (after a fetch). */
    behind?: boolean
    hasUpstream?: boolean
  }
}

export type UninitializedStatus = {
  initialized: false
  root: string
  configFile: string
  suggestedName: string
  defaultEnvironments: string[]
}

export type InitializedStatus = {
  initialized: true
  root: string
  configFile: string
  vault: { name: string; createdAt: string; cipher: string; kdf: string }
  defaultEnvironment: string
  environments: EnvStatus[]
  gitignoreMissing: string[]
}

export type VaultStatus = UninitializedStatus | InitializedStatus

export type OperationResult = {
  status: "created" | "updated" | "unchanged" | "rotated" | "ok"
  environment?: string
  diff?: KeyDiff
  warnings?: string[]
  gitignoreAdded?: string[]
}

export type DiffResult = { environment: string; localExists: boolean; identical: boolean; diff: KeyDiff }

export type CompareResult = {
  environments: {
    name: string
    state: "compared" | "locked" | "no-vault" | "wrong-password" | "unreadable"
    count?: number
    error?: string
  }[]
  compared: string[]
  /** Variable names (never values) that exist in some compared environments but not in others. */
  missing: { key: string; missingFrom: string[]; presentIn: string[] }[]
  shared: number
}

export type ConfirmationReason = "overwrite" | "password-mismatch" | "unreadable-vault" | "config-exists"

export class ApiError extends Error {
  status: number
  code?: string
  reason?: ConfirmationReason
  diff?: KeyDiff
  hint?: string

  constructor(status: number, payload: { message?: string; code?: string; reason?: ConfirmationReason; diff?: KeyDiff; hint?: string }) {
    super(payload.message ?? `Request failed (${status})`)
    this.status = status
    this.code = payload.code
    this.reason = payload.reason
    this.diff = payload.diff
    this.hint = payload.hint
  }

  get needsConfirmation() {
    return this.code === "CONFIRMATION_REQUIRED"
  }
}

const TOKEN_KEY = "dotcrypt-token"

/** Moves the session token from the URL into sessionStorage so it does not linger in history. */
function initToken(): string | null {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get("token")
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    url.searchParams.delete("token")
    window.history.replaceState(null, "", url.pathname + url.search + url.hash)
    return fromUrl
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

const token = initToken()

export const hasToken = () => Boolean(token)

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token ?? ""}` }
  if (method === "POST") headers["Content-Type"] = "application/json"
  const res = await fetch(path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    cache: "no-store",
    credentials: "omit",
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? {})
  return data as T
}

const envPath = (name: string, action: string) => `/api/environments/${encodeURIComponent(name)}/${action}`

export const api = {
  status: () => request<VaultStatus>("GET", "/api/status"),
  init: (body: { name: string; environments: string[]; defaultEnvironment?: string; overwrite?: boolean }) =>
    request<OperationResult>("POST", "/api/init", body),
  addEnvironment: (body: { name: string; file?: string; encryptedFile?: string }) =>
    request<OperationResult>("POST", "/api/environments", body),
  repairGitignore: () => request<{ gitignoreAdded: string[] }>("POST", "/api/gitignore"),
  encrypt: (name: string, body: { password: string; overwrite?: boolean; replaceExisting?: boolean }) =>
    request<OperationResult>("POST", envPath(name, "encrypt"), body),
  decrypt: (name: string, body: { password: string; overwrite?: boolean }) =>
    request<OperationResult>("POST", envPath(name, "decrypt"), body),
  diff: (name: string, body: { password: string }) => request<DiffResult>("POST", envPath(name, "diff"), body),
  rotate: (name: string, body: { oldPassword: string; newPassword: string }) =>
    request<OperationResult>("POST", envPath(name, "rotate"), body),
  compare: (passwords: Record<string, string>) => request<CompareResult>("POST", "/api/compare", { passwords }),
  setDefault: (name: string) => request<OperationResult>("POST", envPath(name, "default")),
}

export const MIN_PASSWORD_LENGTH = 12

export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Must be at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.trim() !== password) return "Must not start or end with whitespace."
  return null
}

export function relativeTime(iso?: string): string {
  if (!iso) return "—"
  const diff = Date.now() - Date.parse(iso)
  const abs = Math.abs(diff)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ]
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  for (const [unit, ms] of units) {
    if (abs >= ms) return fmt.format(-Math.round(diff / ms), unit)
  }
  return "just now"
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—"
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}
