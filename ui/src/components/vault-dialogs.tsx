import { useState } from "react"
import { TriangleAlertIcon } from "lucide-react"

import type { ApiError, DiffResult, EnvStatus } from "@/lib/api"
import { MIN_PASSWORD_LENGTH, newPasswordProblem } from "@/lib/api"
import { DIFF_LABELS, DiffList, diffSummary, hasDifferences } from "@/components/diff-list"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

type Submit<T> = (value: T) => Promise<void>

function useSubmit<T>(onSubmit: Submit<T>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (value: T) => {
    setPending(true)
    setError(null)
    try {
      await onSubmit(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }
  return { pending, error, setError, run }
}

// ---------------------------------------------------------------------------
// Password prompt for encrypt / decrypt / diff
// ---------------------------------------------------------------------------

export type PasswordMode = "encrypt" | "decrypt" | "diff"

function passwordCopy(env: EnvStatus, mode: PasswordMode, isNew: boolean) {
  if (isNew) {
    return {
      title: `Create a password for ${env.name}`,
      description:
        "Teammates need this password to get these secrets. Share it once, privately (for example in a password manager) — never in Git or chat.",
      action: "Share",
    }
  }
  const known = `Enter the ${env.name} password your team uses.`
  if (mode === "encrypt") return { title: `Share ${env.name}`, description: known, action: "Share" }
  if (mode === "decrypt") return { title: `Get ${env.name} secrets`, description: known, action: "Get secrets" }
  return { title: `Check ${env.name}`, description: `${known} Your file is compared with the shared version.`, action: "Check" }
}

export function PasswordDialog({
  env,
  mode,
  onOpenChange,
  onSubmit,
}: {
  env: EnvStatus | null
  mode: PasswordMode
  onOpenChange: (open: boolean) => void
  onSubmit: Submit<string>
}) {
  const isNew = mode === "encrypt" && env !== null && !env.vault.valid
  return (
    <Dialog open={env !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {env && <PasswordForm key={`${env.name}-${mode}`} env={env} mode={mode} isNew={isNew} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  )
}

function PasswordForm({ env, mode, isNew, onSubmit }: { env: EnvStatus; mode: PasswordMode; isNew: boolean; onSubmit: Submit<string> }) {
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const { pending, error, setError, run } = useSubmit(onSubmit)
  const copy = passwordCopy(env, mode, isNew)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (isNew) {
      const problem = newPasswordProblem(password)
      if (problem) return setError(problem)
      if (password !== confirmation) return setError("Passwords do not match.")
    } else if (!password) {
      return setError("Password is required.")
    }
    void run(password)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={Boolean(error) || undefined}>
          <FieldLabel htmlFor="vault-password">{isNew ? "New password" : "Password"}</FieldLabel>
          <Input
            id="vault-password"
            type="password"
            autoComplete={isNew ? "new-password" : "current-password"}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(error) || undefined}
          />
          {isNew && <FieldDescription>At least {MIN_PASSWORD_LENGTH} characters.</FieldDescription>}
        </Field>
        {isNew && (
          <Field>
            <FieldLabel htmlFor="vault-password-confirm">Confirm password</FieldLabel>
            <Input
              id="vault-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
        )}
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        dotcrypt remembers it in this tab until you press Lock or close the tab. It is never saved to disk.
      </p>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          {copy.action}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Confirmation (409 from the server)
// ---------------------------------------------------------------------------

export type PendingConfirmation = {
  env: EnvStatus
  action: "encrypt" | "decrypt"
  error: ApiError
}

function confirmCopy({ env, action, error }: PendingConfirmation) {
  switch (error.reason) {
    case "overwrite":
      return action === "encrypt"
        ? {
            title: `Share these ${env.name} changes?`,
            description: `Teammates get them after you commit and push ${env.encryptedFile}.`,
            confirm: "Share",
          }
        : {
            title: `Update your ${env.file}?`,
            description: "Your file is replaced with the version your team shared.",
            confirm: "Update my file",
          }
    case "password-mismatch":
      return {
        title: "That password doesn't match",
        description: `It doesn't open the shared ${env.encryptedFile}. Ask your team for the right ${env.name} password and try again.`,
        hint: "Only replace the shared file if you want to start over with a new password. Everyone will need the new password.",
        confirm: "Replace shared file",
      }
    default:
      return {
        title: "Shared file can't be read",
        description: error.message,
        hint: "This is usually an unresolved Git merge conflict. Replacing it re-creates the shared file from your local file.",
        confirm: "Replace shared file",
      }
  }
}

export function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingConfirmation | null
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const error = pending?.error
  const destructive = error?.reason !== "overwrite"
  const copy = pending ? confirmCopy(pending) : null

  const confirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {destructive && <TriangleAlertIcon className="size-4 text-destructive" />}
            {copy?.title}
          </AlertDialogTitle>
          <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error?.diff && pending && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">{diffSummary(error.diff)}</p>
            <DiffList diff={error.diff} labels={DIFF_LABELS[pending.action]} />
          </div>
        )}
        {copy?.hint && <p className="text-xs text-muted-foreground">{copy.hint}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} disabled={busy} onClick={confirm}>
            {busy && <Spinner data-icon="inline-start" />}
            {copy?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Diff results
// ---------------------------------------------------------------------------

export type Choice = "encrypt" | "decrypt"

export function CompareDialog({
  result,
  env,
  onOpenChange,
  onChoose,
}: {
  result: DiffResult | null
  env: EnvStatus | undefined
  onOpenChange: (open: boolean) => void
  onChoose: (choice: Choice) => Promise<void>
}) {
  const [pending, setPending] = useState<Choice | null>(null)
  const differs = result !== null && !result.identical
  const choose = async (choice: Choice) => {
    setPending(choice)
    try {
      await onChoose(choice)
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={result !== null} onOpenChange={(open) => !pending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {differs ? "Your file and your team's version differ" : `${result?.environment} is up to date`}
          </DialogTitle>
          <DialogDescription>
            {differs
              ? `Choose which version of ${env?.name} to keep. Only variable names are shown, never values.`
              : `${env?.file} matches the version your team shares.`}
          </DialogDescription>
        </DialogHeader>
        {result && differs && (
          <div className="grid gap-2">
            {!result.localExists && (
              <p className="text-sm text-amber-700 dark:text-amber-400">You don't have {env?.file} yet.</p>
            )}
            {hasDifferences(result.diff) ? (
              <>
                <p className="text-sm font-medium">{diffSummary(result.diff)}</p>
                <DiffList diff={result.diff} labels={DIFF_LABELS.diff} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Same variables and values — only comments or formatting differ.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Need parts of both? Copy the missing variables into your {env?.file} first, then choose "Keep mine".
            </p>
          </div>
        )}
        <DialogFooter showCloseButton={!differs}>
          {differs && (
            <>
              <Button variant="outline" disabled={pending !== null} onClick={() => void choose("decrypt")}>
                {pending === "decrypt" && <Spinner data-icon="inline-start" />}
                Use team's version
              </Button>
              <Button disabled={pending !== null || !result?.localExists} onClick={() => void choose("encrypt")}>
                {pending === "encrypt" && <Spinner data-icon="inline-start" />}
                Keep mine and share it
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rotate key
// ---------------------------------------------------------------------------

export function RotateDialog({
  env,
  initialPassword,
  onOpenChange,
  onSubmit,
}: {
  env: EnvStatus | null
  initialPassword: string
  onOpenChange: (open: boolean) => void
  onSubmit: Submit<{ oldPassword: string; newPassword: string }>
}) {
  return (
    <Dialog open={env !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {env && <RotateForm key={env.name} env={env} initialPassword={initialPassword} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  )
}

function RotateForm({
  env,
  initialPassword,
  onSubmit,
}: {
  env: EnvStatus
  initialPassword: string
  onSubmit: Submit<{ oldPassword: string; newPassword: string }>
}) {
  const [oldPassword, setOldPassword] = useState(initialPassword)
  const [newPassword, setNewPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const { pending, error, setError, run } = useSubmit(onSubmit)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!oldPassword) return setError("Current password is required.")
    const problem = newPasswordProblem(newPassword)
    if (problem) return setError(`New password: ${problem}`)
    if (newPassword !== confirmation) return setError("New passwords do not match.")
    if (newPassword === oldPassword) return setError("The new password must differ from the current one.")
    void run({ oldPassword, newPassword })
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Change password for <span className="font-mono">{env.name}</span>
        </DialogTitle>
        <DialogDescription>
          Re-encrypts {env.encryptedFile} with a new password. After you push it, teammates need the new password. If
          someone left the team, also change the secrets themselves — old versions stay in Git history.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="rotate-old">Current password</FieldLabel>
          <Input
            id="rotate-old"
            type="password"
            autoComplete="current-password"
            autoFocus={!initialPassword}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="rotate-new">New password</FieldLabel>
          <Input
            id="rotate-new"
            type="password"
            autoComplete="new-password"
            autoFocus={Boolean(initialPassword)}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <FieldDescription>At least {MIN_PASSWORD_LENGTH} characters.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="rotate-confirm">Confirm new password</FieldLabel>
          <Input
            id="rotate-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Change password
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Add environment
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/i

export function AddEnvironmentDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: Submit<{ name: string; file?: string; encryptedFile?: string }>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open && <AddEnvironmentForm onSubmit={onSubmit} />}</DialogContent>
    </Dialog>
  )
}

function AddEnvironmentForm({ onSubmit }: { onSubmit: Submit<{ name: string; file?: string; encryptedFile?: string }> }) {
  const [name, setName] = useState("")
  const [file, setFile] = useState("")
  const [encryptedFile, setEncryptedFile] = useState("")
  const { pending, error, setError, run } = useSubmit(onSubmit)
  const trimmed = name.trim()
  const defaultFile = trimmed ? `.env.${trimmed}` : ".env.<name>"

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!ENV_NAME_PATTERN.test(trimmed)) return setError('Use 1-64 letters, digits, "-" or "_", starting and ending alphanumeric.')
    void run({ name: trimmed, file: file.trim() || undefined, encryptedFile: encryptedFile.trim() || undefined })
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add environment</DialogTitle>
        <DialogDescription>Adds a mapping to .dotcrypt.json and protects the local file in .gitignore.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="env-name">Name</FieldLabel>
          <Input id="env-name" autoFocus placeholder="e.g. preview" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="env-file">Local file</FieldLabel>
          <Input id="env-file" placeholder={defaultFile} value={file} onChange={(e) => setFile(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="env-enc">Encrypted file</FieldLabel>
          <Input
            id="env-enc"
            placeholder={`${defaultFile}.enc`}
            value={encryptedFile}
            onChange={(e) => setEncryptedFile(e.target.value)}
          />
          <FieldDescription>Leave blank to use the defaults. Paths are relative to the project root.</FieldDescription>
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Add environment
        </Button>
      </DialogFooter>
    </form>
  )
}
