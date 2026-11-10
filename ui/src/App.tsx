import { useCallback, useEffect, useState } from "react"
import {
  CircleHelpIcon,
  LockIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SunIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import { toast } from "sonner"

import type { DiffResult, EnvStatus, InitializedStatus, OperationResult, UninitializedStatus, VaultStatus } from "@/lib/api"
import { ApiError, api, hasToken, relativeTime } from "@/lib/api"
import { ActivityLog, type LogEntry, type LogLevel } from "@/components/activity-log"
import { EnvCard, needsAttention, type EnvAction } from "@/components/env-card"
import { HowItWorks } from "@/components/how-it-works"
import { InitView } from "@/components/init-view"
import { useTheme } from "@/components/theme-provider"
import {
  AddEnvironmentDialog,
  ConfirmDialog,
  CompareDialog,
  PasswordDialog,
  RotateDialog,
  type Choice,
  type PasswordMode,
  type PendingConfirmation,
} from "@/components/vault-dialogs"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster } from "@/components/ui/sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

const POLL_MS = 5000
const GUIDE_HIDDEN_KEY = "dotcrypt-guide-hidden"

type WriteMode = "encrypt" | "decrypt"
type Options = { overwrite?: boolean; replaceExisting?: boolean }
type Confirmation = PendingConfirmation & { password: string; options: Options }

let logId = 0

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Passwords live only in React memory for this tab; "Lock" clears them.
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<{ env: string; action: EnvAction } | null>(null)
  const [prompt, setPrompt] = useState<{ env: EnvStatus; mode: PasswordMode } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null)
  const [rotateEnv, setRotateEnv] = useState<EnvStatus | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [guideOpen, setGuideOpen] = useState(() => localStorage.getItem(GUIDE_HIDDEN_KEY) !== "1")

  const initialized = status?.initialized ? status : null
  const unlockedCount = Object.keys(passwords).length

  const addLog = useCallback((level: LogLevel, message: string) => {
    setLog((prev) => [{ id: ++logId, time: new Date(), level, message }, ...prev].slice(0, 200))
  }, [])

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      setStatus(await api.status())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err : new ApiError(0, { message: String(err) }))
    } finally {
      if (manual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!hasToken()) return
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  const remember = (env: string, password: string) => setPasswords((prev) => ({ ...prev, [env]: password }))
  const forget = (env: string) =>
    setPasswords((prev) => {
      const next = { ...prev }
      delete next[env]
      return next
    })

  const fail = (context: string) => (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    addLog("error", `${context}: ${message}`)
    toast.error(context, { description: message })
  }

  const reportWarnings = (warnings?: string[]) => {
    for (const warning of warnings ?? []) {
      addLog("warn", warning)
      toast.warning(warning)
    }
  }

  const reportResult = (env: EnvStatus, mode: WriteMode, result: OperationResult) => {
    if (result.status === "unchanged") {
      const message =
        mode === "encrypt" ? `${env.name}: nothing new to share` : `${env.name}: your ${env.file} is already up to date`
      addLog("info", message)
      toast.info(message)
    } else if (mode === "encrypt") {
      addLog("success", `Encrypted ${env.file} → ${env.encryptedFile}. Commit and push it to send it to your team.`)
      toast.success(`${env.name} is ready to send`, {
        description: `Last step: commit and push ${env.encryptedFile}. The card shows the command.`,
      })
    } else {
      addLog("success", `Updated ${env.file} from ${env.encryptedFile}`)
      toast.success(`${env.name} is up to date`, { description: `${env.file} now has your team's latest secrets.` })
    }
    reportWarnings(result.warnings)
  }

  /** Runs encrypt/decrypt/diff. 409s open the confirmation dialog; other errors are rethrown. */
  const execute = async (env: EnvStatus, mode: PasswordMode, password: string, options: Options = {}) => {
    setBusy({ env: env.name, action: mode })
    try {
      if (mode === "diff") {
        const result = await api.diff(env.name, { password })
        addLog("info", `Compared ${env.file} with ${env.encryptedFile}: ${result.identical ? "same" : "different"}`)
        if (result.identical) toast.success(`${env.name} is up to date`, { description: `${env.file} matches your team's version.` })
        else setDiffResult(result)
      } else {
        const call = mode === "encrypt" ? api.encrypt : api.decrypt
        reportResult(env, mode, await call(env.name, { password, ...options }))
      }
      remember(env.name, password)
      setPrompt(null)
    } catch (err) {
      if (err instanceof ApiError && err.needsConfirmation && mode !== "diff") {
        if (err.reason === "overwrite") remember(env.name, password)
        setPrompt(null)
        setConfirmation({ env, action: mode, error: err, password, options })
        return
      }
      if (err instanceof ApiError && err.code === "DECRYPT_FAILED") forget(env.name)
      throw err
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const handleAction = (env: EnvStatus, action: EnvAction) => {
    if (action === "rotate") return setRotateEnv(env)
    if (action === "default") {
      setBusy({ env: env.name, action })
      api
        .setDefault(env.name)
        .then(() => {
          addLog("success", `Default environment set to ${env.name}`)
          return refresh()
        })
        .catch(fail("Could not set default"))
        .finally(() => setBusy(null))
      return
    }
    const cached = passwords[env.name]
    if (!cached) return setPrompt({ env, mode: action })
    execute(env, action, cached).catch((err) => {
      fail(`${action} ${env.name} failed`)(err)
      if (err instanceof ApiError && err.code === "DECRYPT_FAILED") setPrompt({ env, mode: action })
    })
  }

  const onPasswordSubmit = async (password: string) => {
    if (!prompt) return
    try {
      await execute(prompt.env, prompt.mode, password)
    } catch (err) {
      if (err instanceof Error) addLog("error", `${prompt.mode} ${prompt.env.name}: ${err.message}`)
      throw err
    }
  }

  const onConfirm = async () => {
    if (!confirmation) return
    const { env, action, password, options, error } = confirmation
    setConfirmation(null)
    const next: Options =
      error.reason === "overwrite" ? { ...options, overwrite: true } : { ...options, overwrite: true, replaceExisting: true }
    await execute(env, action, password, next).catch(fail(`${action} ${env.name} failed`))
  }

  const onChoose = async (choice: Choice) => {
    const env = initialized?.environments.find((e) => e.name === diffResult?.environment)
    const password = env && passwords[env.name]
    if (!env || !password) return setDiffResult(null)
    await execute(env, choice, password, { overwrite: true })
      .then(() => setDiffResult(null))
      .catch(fail(`${choice === "encrypt" ? "Sharing" : "Updating"} ${env.name} failed`))
  }

  const onRotate = async ({ oldPassword, newPassword }: { oldPassword: string; newPassword: string }) => {
    if (!rotateEnv) return
    const env = rotateEnv
    setBusy({ env: env.name, action: "rotate" })
    try {
      await api.rotate(env.name, { oldPassword, newPassword })
      remember(env.name, newPassword)
      setRotateEnv(null)
      addLog("success", `Changed the ${env.name} password. Commit and push ${env.encryptedFile}, then give teammates the new password privately.`)
      toast.success(`Changed the ${env.name} password`, {
        description: `Commit and push ${env.encryptedFile}, then give teammates the new password privately.`,
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === "DECRYPT_FAILED") forget(env.name)
      if (err instanceof Error) addLog("error", `rotate ${env.name}: ${err.message}`)
      throw err
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const onAddEnvironment = async (value: { name: string; file?: string; encryptedFile?: string }) => {
    const result = await api.addEnvironment(value)
    setAddOpen(false)
    addLog("success", `Added environment ${value.name}`)
    if (result.gitignoreAdded?.length) addLog("info", `.gitignore: added ${result.gitignoreAdded.join(", ")}`)
    toast.success(`Added ${value.name}`)
    await refresh()
  }

  const onInit = async (value: { name: string; environments: string[]; defaultEnvironment?: string }) => {
    const result = await api.init(value)
    addLog("success", `Created .dotcrypt.json with ${value.environments.join(", ")}`)
    if (result.gitignoreAdded?.length) addLog("info", `.gitignore: added ${result.gitignoreAdded.join(", ")}`)
    reportWarnings(result.warnings)
    toast.success("Vault initialized")
    await refresh()
  }

  const onRepairGitignore = () =>
    api
      .repairGitignore()
      .then((result) => {
        addLog("success", `.gitignore: added ${result.gitignoreAdded.join(", ") || "nothing"}`)
        toast.success(".gitignore updated")
        return refresh()
      })
      .catch(fail("Could not update .gitignore"))

  const showGuide = (open: boolean) => {
    setGuideOpen(open)
    localStorage.setItem(GUIDE_HIDDEN_KEY, open ? "0" : "1")
  }

  const lockAll = () => {
    setPasswords({})
    addLog("info", "Locked: cleared all passwords from memory")
    toast.info("All passwords cleared from memory")
  }

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-background">
        <Header
          status={status}
          refreshing={refreshing}
          unlockedCount={unlockedCount}
          onRefresh={() => void refresh(true)}
          onLock={lockAll}
          onAdd={initialized ? () => setAddOpen(true) : undefined}
          onHelp={initialized && !guideOpen ? () => showGuide(true) : undefined}
        />
        <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6">
          {!hasToken() || loadError?.status === 401 ? (
            <SessionError />
          ) : loadError && !status ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Could not reach the vault server</AlertTitle>
              <AlertDescription>{loadError.message}. Is `dotcrypt ui` still running?</AlertDescription>
            </Alert>
          ) : !status ? (
            <LoadingSkeleton />
          ) : !initialized ? (
            <InitView status={status as UninitializedStatus} onInit={onInit} />
          ) : (
            <Dashboard
              status={initialized}
              passwords={passwords}
              busy={busy}
              onAction={handleAction}
              onRepairGitignore={onRepairGitignore}
              offline={Boolean(loadError)}
              guide={guideOpen ? <HowItWorks onHide={() => showGuide(false)} /> : null}
            />
          )}
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>What happened in this browser session. Secret values are never shown.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActivityLog entries={log} />
            </CardContent>
          </Card>
        </main>
      </div>

      <PasswordDialog
        env={prompt?.env ?? null}
        mode={prompt?.mode ?? "decrypt"}
        onOpenChange={(open) => !open && setPrompt(null)}
        onSubmit={onPasswordSubmit}
      />
      <ConfirmDialog pending={confirmation} onCancel={() => setConfirmation(null)} onConfirm={onConfirm} />
      <CompareDialog
        result={diffResult}
        env={initialized?.environments.find((e) => e.name === diffResult?.environment)}
        onOpenChange={(open) => !open && setDiffResult(null)}
        onChoose={onChoose}
      />
      <RotateDialog
        env={rotateEnv}
        initialPassword={rotateEnv ? (passwords[rotateEnv.name] ?? "") : ""}
        onOpenChange={(open) => !open && setRotateEnv(null)}
        onSubmit={onRotate}
      />
      <AddEnvironmentDialog open={addOpen} onOpenChange={setAddOpen} onSubmit={onAddEnvironment} />
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  )
}

function Header({
  status,
  refreshing,
  unlockedCount,
  onRefresh,
  onLock,
  onAdd,
  onHelp,
}: {
  status: VaultStatus | null
  refreshing: boolean
  unlockedCount: number
  onRefresh: () => void
  onLock: () => void
  onAdd?: () => void
  onHelp?: () => void
}) {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const title = status?.initialized ? status.vault.name : "dotcrypt"

  return (
    <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ShieldCheckIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground" title={status?.root}>
            {status?.root ?? "dotcrypt dashboard"}
          </p>
        </div>
        {onHelp && (
          <Button variant="ghost" size="sm" onClick={onHelp}>
            <CircleHelpIcon data-icon="inline-start" />
            <span className="hidden sm:inline">How it works</span>
          </Button>
        )}
        {unlockedCount > 0 && (
          <Button variant="outline" size="sm" onClick={onLock}>
            <LockIcon data-icon="inline-start" />
            Lock ({unlockedCount})
          </Button>
        )}
        {onAdd && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            <PlusIcon data-icon="inline-start" />
            <span className="hidden sm:inline">Add environment</span>
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={onRefresh} />}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          </TooltipTrigger>
          <TooltipContent>Refresh (auto every 5s)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle theme"
                onClick={() => setTheme(isDark ? "light" : "dark")}
              />
            }
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </TooltipTrigger>
          <TooltipContent>
            Toggle theme <Kbd>D</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}

function Dashboard({
  status,
  passwords,
  busy,
  onAction,
  onRepairGitignore,
  offline,
  guide,
}: {
  status: InitializedStatus
  passwords: Record<string, string>
  busy: { env: string; action: EnvAction } | null
  onAction: (env: EnvStatus, action: EnvAction) => void
  onRepairGitignore: () => void
  offline: boolean
  guide: React.ReactNode
}) {
  const attention = status.environments.filter(needsAttention).length
  const tracked = status.environments.filter((e) => e.git.tracked)

  return (
    <>
      {offline && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Connection lost</AlertTitle>
          <AlertDescription>Showing the last known state. Is `dotcrypt ui` still running?</AlertDescription>
        </Alert>
      )}
      {tracked.length > 0 && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>Plaintext secrets are tracked by Git</AlertTitle>
          <AlertDescription>
            <span>
              {tracked.map((e) => e.file).join(", ")} {tracked.length === 1 ? "is" : "are"} committed. Run{" "}
              <code className="font-mono">git rm --cached {tracked.map((e) => e.file).join(" ")}</code>, commit, and
              rotate the exposed secrets.
            </span>
          </AlertDescription>
        </Alert>
      )}
      {status.gitignoreMissing.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>.gitignore does not protect all plaintext env files</AlertTitle>
          <AlertDescription>
            <span>
              Missing rules: <code className="font-mono">{status.gitignoreMissing.join(", ")}</code>
            </span>
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={onRepairGitignore}>
              <WrenchIcon data-icon="inline-start" />
              Fix
            </Button>
          </AlertAction>
        </Alert>
      )}

      {guide}

      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Environments</h2>
        <p className="text-xs text-muted-foreground">
          {attention ? `${attention} need${attention === 1 ? "s" : ""} your attention` : "Everything is up to date"}
        </p>
      </div>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {status.environments.map((env) => (
          <EnvCard
            key={env.name}
            env={env}
            unlocked={Boolean(passwords[env.name])}
            busy={busy?.env === env.name ? busy.action : null}
            onAction={(action) => onAction(env, action)}
          />
        ))}
      </section>

      <p className="text-xs text-muted-foreground">
        Vault created {relativeTime(status.vault.createdAt)} · {status.vault.cipher} · {status.vault.kdf} key derivation ·
        config in <code className="font-mono">{status.configFile}</code>
      </p>
    </>
  )
}

function SessionError() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>Session token missing or expired</EmptyTitle>
        <EmptyDescription>
          Open the exact URL printed by <code className="font-mono">dotcrypt ui</code>. Each run creates a new
          token.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-64 rounded-xl" />
      ))}
    </div>
  )
}

export default App
