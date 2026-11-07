import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"

import { ScrollArea } from "@/components/ui/scroll-area"

export type LogLevel = "info" | "success" | "warn" | "error"
export type LogEntry = { id: number; time: Date; level: LogLevel; message: string }

const icons: Record<LogLevel, React.ReactNode> = {
  info: <InfoIcon className="size-3.5 text-muted-foreground" />,
  success: <CircleCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />,
  warn: <TriangleAlertIcon className="size-3.5 text-amber-600 dark:text-amber-400" />,
  error: <CircleAlertIcon className="size-3.5 text-red-600 dark:text-red-400" />,
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Actions you take in this session appear here.</p>
  }
  return (
    <ScrollArea className="h-64">
      <ol className="space-y-1 pr-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{icons[entry.level]}</span>
            <span className="min-w-0 flex-1 break-words">{entry.message}</span>
            <time className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {entry.time.toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>
    </ScrollArea>
  )
}
