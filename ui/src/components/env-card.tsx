import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  FileKeyIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  KeyRoundIcon,
  LockOpenIcon,
  StarIcon,
} from "lucide-react"

import type { EnvStatus } from "@/lib/api"
import { formatBytes, relativeTime } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type EnvAction = "encrypt" | "decrypt" | "diff" | "rotate" | "default"

type Health = { label: string; tone: "ok" | "warn" | "danger" | "muted"; detail: string }

/** Summarizes what the user should do next for this environment. */
export function envHealth(env: EnvStatus): Health {
  if (env.git.tracked) return { label: "Plaintext tracked!", tone: "danger", detail: `${env.file} is committed to Git. Remove it and rotate its secrets.` }
  if (env.vault.exists && !env.vault.valid) return { label: "Vault unreadable", tone: "danger", detail: env.vault.error ?? "The encrypted file is invalid." }
  if (env.vault.valid && env.vault.environmentMatches === false) return { label: "Env mismatch", tone: "danger", detail: `Vault belongs to "${env.vault.environment}".` }
  if (!env.local.exists && !env.vault.exists) return { label: "Empty", tone: "muted", detail: `Create ${env.file}, then encrypt it.` }
  if (!env.vault.exists) return { label: "Not encrypted", tone: "warn", detail: "Local file exists but has never been encrypted." }
  if (!env.local.exists) return { label: "Not decrypted", tone: "warn", detail: "Vault exists. Decrypt it to create the local file." }
  if (env.localNewerThanVault) return { label: "Local changed", tone: "warn", detail: "Local file was modified after the last encryption." }
  return { label: "Synced", tone: "ok", detail: "Local file is not newer than the vault." }
}

const toneClass: Record<Health["tone"], string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "bg-red-500/10 text-red-700 dark:text-red-400",
  muted: "bg-muted text-muted-foreground",
}

function FileRow({
  icon,
  label,
  path,
  exists,
  meta,
  badges,
}: {
  icon: React.ReactNode
  label: string
  path: string
  exists: boolean
  meta: string
  badges?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={exists ? "mt-0.5 text-foreground" : "mt-0.5 text-muted-foreground/50"}>{icon}</div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
          {badges}
        </div>
        <code className="block truncate font-mono text-xs" title={path}>
          {path}
        </code>
        <p className="text-xs text-muted-foreground">{exists ? meta : "missing"}</p>
      </div>
    </div>
  )
}

export function EnvCard({
  env,
  unlocked,
  busy,
  onAction,
}: {
  env: EnvStatus
  unlocked: boolean
  busy: EnvAction | null
  onAction: (action: EnvAction) => void
}) {
  const health = envHealth(env)
  const canDecrypt = env.vault.valid
  const disabled = busy !== null

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="truncate">{env.name}</span>
          {env.isDefault && <Badge variant="secondary">default</Badge>}
          {unlocked && (
            <Tooltip>
              <TooltipTrigger render={<span className="text-muted-foreground" aria-label="Unlocked" />}>
                <LockOpenIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Password held in this tab's memory</TooltipContent>
            </Tooltip>
          )}
        </CardTitle>
        <CardDescription>{health.detail}</CardDescription>
        <CardAction>
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[health.tone]}`}>{health.label}</span>
        </CardAction>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <FileRow
          icon={<FileTextIcon className="size-4" />}
          label="Local"
          path={env.file}
          exists={env.local.exists}
          meta={`${formatBytes(env.local.size)} · modified ${relativeTime(env.local.modifiedAt)}`}
          badges={
            env.git.inRepo &&
            (env.git.tracked ? (
              <Badge variant="destructive">tracked</Badge>
            ) : env.git.ignored ? (
              <Badge variant="outline">ignored</Badge>
            ) : (
              <Badge variant="destructive">not ignored</Badge>
            ))
          }
        />
        <Separator />
        <FileRow
          icon={<FileKeyIcon className="size-4" />}
          label="Vault"
          path={env.encryptedFile}
          exists={env.vault.exists}
          meta={
            env.vault.valid
              ? `${formatBytes(env.vault.size)} · encrypted ${relativeTime(env.vault.encryptedAt)}`
              : (env.vault.error ?? "invalid")
          }
          badges={
            env.vault.exists &&
            env.vaultGit.inRepo &&
            (env.vaultGit.tracked ? <Badge variant="outline">committed</Badge> : <Badge variant="secondary">uncommitted</Badge>)
          }
        />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled || !env.local.exists} onClick={() => onAction("encrypt")}>
          <ArrowUpFromLineIcon data-icon="inline-start" />
          {busy === "encrypt" ? "Encrypting…" : "Encrypt"}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || !canDecrypt} onClick={() => onAction("decrypt")}>
          <ArrowDownToLineIcon data-icon="inline-start" />
          {busy === "decrypt" ? "Decrypting…" : "Decrypt"}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || !canDecrypt} onClick={() => onAction("diff")}>
          <GitCompareArrowsIcon data-icon="inline-start" />
          Diff
        </Button>
        <div className="ml-auto flex gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Rotate key"
                  disabled={disabled || !canDecrypt}
                  onClick={() => onAction("rotate")}
                />
              }
            >
              <KeyRoundIcon />
            </TooltipTrigger>
            <TooltipContent>Rotate password</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Set as default"
                  disabled={disabled || env.isDefault}
                  onClick={() => onAction("default")}
                />
              }
            >
              <StarIcon className={env.isDefault ? "fill-current" : undefined} />
            </TooltipTrigger>
            <TooltipContent>{env.isDefault ? "Default environment" : "Set as default"}</TooltipContent>
          </Tooltip>
        </div>
      </CardFooter>
    </Card>
  )
}
