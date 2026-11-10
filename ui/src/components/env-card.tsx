import { useState } from "react"
import {
  ArrowDownToLineIcon,
  ArrowRightLeftIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  FileKeyIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  KeyRoundIcon,
  LockOpenIcon,
  MoreHorizontalIcon,
  ScanSearchIcon,
  StarIcon,
} from "lucide-react"

import type { EnvStatus } from "@/lib/api"
import { relativeTime } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type EnvAction = "encrypt" | "decrypt" | "diff" | "rotate" | "default"

type Tone = "ok" | "info" | "warn" | "danger" | "muted"

type Summary = {
  tone: Tone
  title: string
  detail: string
  primary?: { action: EnvAction; label: string; icon: React.ReactNode; destructive?: boolean }
}

const share = { action: "encrypt" as const, icon: <ArrowUpFromLineIcon data-icon="inline-start" /> }
const get = { action: "decrypt" as const, icon: <ArrowDownToLineIcon data-icon="inline-start" /> }

/** True when the encrypted file has changes that teammates cannot see yet. */
export function isUnsent(env: EnvStatus) {
  return env.vault.exists && env.vaultGit.inRepo && Boolean(env.vaultGit.uncommitted || env.vaultGit.unpushed)
}

/** Plain-language state of an environment and the one thing to do next. */
export function summarize(env: EnvStatus): Summary {
  switch (env.sync) {
    case "broken":
      return {
        tone: "danger",
        title: "Shared file can't be read",
        detail:
          env.vault.error ??
          `${env.encryptedFile} belongs to "${env.vault.environment}". This is usually a Git merge conflict — fix it in Git, or replace it with your file.`,
        primary: env.local.exists
          ? { ...share, label: "Replace with my file", destructive: true }
          : undefined,
      }
    case "empty":
      return {
        tone: "muted",
        title: "No secrets yet",
        detail: `Create ${env.file} in your editor and add your variables. It will show up here automatically.`,
      }
    case "not-shared":
      return {
        tone: "warn",
        title: "Not shared yet",
        detail: `${env.file} only exists on this machine. Share it so your team can get it.`,
        primary: { ...share, label: "Share with team" },
      }
    case "not-downloaded":
      return {
        tone: "info",
        title: "Ready to download",
        detail: `Your team shared these secrets. Get them to create ${env.file} on this machine.`,
        primary: { ...get, label: "Get secrets" },
      }
    case "unknown":
      return {
        tone: "muted",
        title: "Not checked yet",
        detail: "This machine hasn't compared your file with the shared one yet. Enter the password once to check.",
        primary: { action: "diff", label: "Check", icon: <ScanSearchIcon data-icon="inline-start" /> },
      }
    case "local-changes":
      return {
        tone: "warn",
        title: "You have unshared changes",
        detail: `You edited ${env.file}. Share it so your team gets the changes.`,
        primary: { ...share, label: "Share changes" },
      }
    case "incoming-changes":
      return {
        tone: "info",
        title: "New changes from your team",
        detail: `A teammate updated these secrets. Get them to update your ${env.file}.`,
        primary: { ...get, label: "Get latest" },
      }
    case "conflict":
      return {
        tone: "danger",
        title: "Changed on both sides",
        detail: "You edited your file and a teammate shared changes too. Review them and choose which version to keep.",
        primary: { action: "diff", label: "Review", icon: <GitCompareArrowsIcon data-icon="inline-start" /> },
      }
    case "synced":
      return isUnsent(env)
        ? {
            tone: "warn",
            title: "Not sent to your team yet",
            detail: "Your changes are encrypted on this machine. Push them so teammates can get them.",
          }
        : { tone: "ok", title: "Up to date", detail: `${env.file} matches the version your team shares.` }
  }
}

export function needsAttention(env: EnvStatus) {
  return env.git.tracked || !["ok", "muted"].includes(summarize(env).tone) || isUnsent(env)
}

const toneStyles: Record<Tone, { text: string; icon: React.ReactNode }> = {
  ok: { text: "text-emerald-700 dark:text-emerald-400", icon: <CircleCheckIcon /> },
  info: { text: "text-sky-700 dark:text-sky-400", icon: <ArrowDownToLineIcon /> },
  warn: { text: "text-amber-700 dark:text-amber-400", icon: <ArrowUpFromLineIcon /> },
  danger: { text: "text-red-700 dark:text-red-400", icon: <CircleAlertIcon /> },
  muted: { text: "text-muted-foreground", icon: <CircleDashedIcon /> },
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  return (
    <div className="flex items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <Button size="icon-xs" variant="ghost" aria-label="Copy command" onClick={() => void copy()}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

/** Git steps that move the encrypted file between this machine and the team. */
function TeamStep({ env }: { env: EnvStatus }) {
  if (env.vaultGit.behind) {
    return (
      <div className="space-y-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
        <p className="text-xs font-medium">A teammate pushed a newer version. Pull it first:</p>
        <CopyCommand command="git pull" />
      </div>
    )
  }
  if (!isUnsent(env)) return null
  const command = env.vaultGit.uncommitted
    ? `git add ${env.encryptedFile} && git commit -m "Update ${env.name} secrets" && git push`
    : "git push"
  return (
    <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-xs font-medium">Last step — send it to your team:</p>
      <CopyCommand command={command} />
    </div>
  )
}

function FileBadge({ env }: { env: EnvStatus }) {
  if (!env.git.inRepo || !env.local.exists) return null
  if (env.git.tracked) return <Badge variant="destructive">committed to Git!</Badge>
  if (!env.git.ignored) return <Badge variant="destructive">not in .gitignore</Badge>
  return null
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
  const summary = summarize(env)
  const tone = toneStyles[summary.tone]
  const disabled = busy !== null
  const canRead = env.vault.valid && env.vault.environmentMatches !== false

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
              <TooltipContent>Password remembered in this tab until you lock or close it</TooltipContent>
            </Tooltip>
          )}
        </CardTitle>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label={`More actions for ${env.name}`} disabled={disabled} />}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem disabled={!canRead} onClick={() => onAction("diff")}>
                <GitCompareArrowsIcon />
                Compare with team's version
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!env.local.exists} onClick={() => onAction("encrypt")}>
                <ArrowUpFromLineIcon />
                Share my version
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canRead} onClick={() => onAction("decrypt")}>
                <ArrowDownToLineIcon />
                Replace mine with team's version
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!canRead} onClick={() => onAction("rotate")}>
                <KeyRoundIcon />
                Change password
              </DropdownMenuItem>
              <DropdownMenuItem disabled={env.isDefault} onClick={() => onAction("default")}>
                <StarIcon />
                Make default environment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
        <CardDescription className="sr-only">Status of the {env.name} environment</CardDescription>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        <div className="flex gap-3">
          <div className={cn("mt-0.5 [&_svg]:size-5", tone.text)}>{tone.icon}</div>
          <div className="min-w-0 space-y-1">
            <p className={cn("font-medium", tone.text)}>{summary.title}</p>
            <p className="text-sm text-muted-foreground">{summary.detail}</p>
          </div>
        </div>

        <TeamStep env={env} />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1", !env.local.exists && "opacity-50")}>
            <FileTextIcon className="size-3.5" />
            <code className="font-mono">{env.file}</code>
          </span>
          <FileBadge env={env} />
          <ArrowRightLeftIcon className="size-3" />
          <span className={cn("inline-flex items-center gap-1", !env.vault.exists && "opacity-50")}>
            <FileKeyIcon className="size-3.5" />
            <code className="font-mono">{env.encryptedFile}</code>
          </span>
          {env.vault.encryptedAt && <span>· shared {relativeTime(env.vault.encryptedAt)}</span>}
        </div>
      </CardContent>

      {summary.primary && (
        <CardFooter>
          <Button
            className="w-full"
            variant={summary.primary.destructive ? "destructive" : "default"}
            disabled={disabled}
            onClick={() => onAction(summary.primary!.action)}
          >
            {summary.primary.icon}
            {busy === summary.primary.action ? "Working…" : summary.primary.label}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
