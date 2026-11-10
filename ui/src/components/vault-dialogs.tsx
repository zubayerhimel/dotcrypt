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

const passwordCopy: Record<PasswordMode, { title: string; action: string }> = {
  encrypt: { title: "Encrypt", action: "Encrypt" },
  decrypt: { title: "Decrypt", action: "Decrypt" },
  diff: { title: "Compare", action: "Compare" },
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
  const copy = passwordCopy[mode]

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
        <DialogTitle>
          {copy.title} <span className="font-mono">{env.name}</span>
        </DialogTitle>
        <DialogDescription>
          {isNew
            ? `Choose the password that protects ${env.encryptedFile}. Share it with teammates over a secure channel, never via Git.`
            : `Enter the vault password for ${env.encryptedFile}.`}
        </DialogDescription>
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
        The password stays in this tab's memory until you press Lock or close the tab. It is never written to disk.
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
  env: string
  action: "encrypt" | "decrypt"
  error: ApiError
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
            {error?.reason === "overwrite" ? "Confirm overwrite" : "Replace vault file?"}
          </AlertDialogTitle>
          <AlertDialogDescription>{error?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {error?.diff && pending && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">{diffSummary(error.diff)}</p>
            <DiffList diff={error.diff} labels={DIFF_LABELS[pending.action]} />
          </div>
        )}
        {error?.hint && <p className="text-xs text-muted-foreground">{error.hint}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} disabled={busy} onClick={confirm}>
            {busy && <Spinner data-icon="inline-start" />}
            {error?.reason === "overwrite" ? "Overwrite" : "Replace"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Diff results
// ---------------------------------------------------------------------------

export function DiffDialog({
  result,
  env,
  onOpenChange,
}: {
  result: DiffResult | null
  env: EnvStatus | undefined
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Diff <span className="font-mono">{result?.environment}</span>
          </DialogTitle>
          <DialogDescription>
            Comparing <code className="font-mono">{env?.file}</code> (local) with{" "}
            <code className="font-mono">{env?.encryptedFile}</code> (vault). Only key names are shown.
          </DialogDescription>
        </DialogHeader>
        {result && (
          <div className="grid gap-2">
            {!result.localExists && (
              <p className="text-sm text-amber-700 dark:text-amber-400">The local file does not exist; treated as empty.</p>
            )}
            <p className="text-sm font-medium">
              {hasDifferences(result.diff)
                ? diffSummary(result.diff)
                : `In sync (${result.diff.unchanged} key${result.diff.unchanged === 1 ? "" : "s"})`}
            </p>
            {hasDifferences(result.diff) && <DiffList diff={result.diff} labels={DIFF_LABELS.diff} />}
          </div>
        )}
        <DialogFooter showCloseButton />
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
          Rotate key for <span className="font-mono">{env.name}</span>
        </DialogTitle>
        <DialogDescription>
          Re-encrypts {env.encryptedFile} with a new password, fresh salt and IV. Teammates will need the new password.
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
          Rotate key
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
