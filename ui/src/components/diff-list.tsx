import { MinusIcon, PlusIcon, PencilIcon } from "lucide-react"

import type { KeyDiff } from "@/lib/api"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export type DiffLabels = { added: string; removed: string; changed?: string }

export const DIFF_LABELS = {
  encrypt: { added: "new in local", removed: "will be removed from vault" },
  decrypt: { added: "local only — will be lost", removed: "will be restored from vault" },
  diff: { added: "local only — not yet encrypted", removed: "vault only — missing locally" },
} satisfies Record<string, DiffLabels>

export function diffSummary(diff: KeyDiff) {
  return `${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length} changed`
}

export function hasDifferences(diff: KeyDiff) {
  return diff.added.length + diff.removed.length + diff.changed.length > 0
}

/** Lists key names only. Secret values never reach the browser. */
export function DiffList({ diff, labels, className }: { diff: KeyDiff; labels: DiffLabels; className?: string }) {
  const rows = [
    ...diff.added.map((key) => ({ key, kind: "added" as const, label: labels.added })),
    ...diff.removed.map((key) => ({ key, kind: "removed" as const, label: labels.removed })),
    ...diff.changed.map((key) => ({ key, kind: "changed" as const, label: labels.changed ?? "value differs" })),
  ]
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No key differences.</p>
  }
  return (
    <ScrollArea className={cn("rounded-md border **:data-[slot=scroll-area-viewport]:max-h-64", className)}>
      <ul className="divide-y text-sm">
        {rows.map(({ key, kind, label }) => (
          <li key={`${kind}-${key}`} className="flex items-center gap-2 px-3 py-1.5">
            {kind === "added" && <PlusIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
            {kind === "removed" && <MinusIcon className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
            {kind === "changed" && <PencilIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
            <code className="truncate font-mono text-xs">{key}</code>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
      {diff.unchanged > 0 && (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{diff.unchanged} unchanged</p>
      )}
    </ScrollArea>
  )
}
