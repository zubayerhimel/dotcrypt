import { useState } from "react"
import { CircleCheckIcon, CopyIcon, ListChecksIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type { CompareResult, EnvStatus } from "@/lib/api"
import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const SKIPPED: Record<string, string> = {
  locked: "no password",
  "wrong-password": "wrong password",
  unreadable: "unreadable file",
  "no-vault": "not shared yet",
}

/** Changes whenever any shared file changes, so an old result can be marked out of date. */
const signatureOf = (envs: EnvStatus[]) => envs.map((e) => `${e.name}:${e.vault.modifiedAt ?? ""}`).join("|")

export function MissingVariables({
  environments,
  passwords,
  onUnlocked,
  onWrongPassword,
}: {
  environments: EnvStatus[]
  passwords: Record<string, string>
  onUnlocked: (env: string, password: string) => void
  onWrongPassword: (env: string) => void
}) {
  const shared = environments.filter((e) => e.vault.exists && e.vault.valid && e.vault.environmentMatches)
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ data: CompareResult; signature: string } | null>(null)
  const [loading, setLoading] = useState(false)

  if (shared.length < 2) return null

  const locked = shared.filter((e) => !passwords[e.name])
  const stale = result !== null && result.signature !== signatureOf(shared)

  const check = async () => {
    const all = { ...passwords, ...Object.fromEntries(Object.entries(typed).filter(([, pw]) => pw)) }
    setLoading(true)
    try {
      const data = await api.compare(all)
      for (const env of data.environments) {
        if (env.state === "compared" && typed[env.name]) onUnlocked(env.name, typed[env.name])
        if (env.state === "wrong-password") onWrongPassword(env.name)
      }
      setTyped({})
      setResult({ data, signature: signatureOf(shared) })
    } catch (err) {
      toast.error("Could not compare environments", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecksIcon className="size-4 text-muted-foreground" />
          Missing variables
        </CardTitle>
        <CardDescription>
          Finds variables that exist in one environment but not in another, for example a new key you added to
          development and forgot in production. Only names are compared; values are never shown.
        </CardDescription>
        {result && (
          <CardAction>
            <Button size="icon-sm" variant="ghost" aria-label="Clear result" onClick={() => setResult(null)}>
              <XIcon />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void check()
          }}
        >
          {locked.map((env) => (
            <label key={env.name} className="grid gap-1 text-xs text-muted-foreground">
              Password for {env.name}
              <Input
                type="password"
                autoComplete="off"
                placeholder="optional"
                className="w-44"
                value={typed[env.name] ?? ""}
                onChange={(event) => setTyped((prev) => ({ ...prev, [env.name]: event.target.value }))}
              />
            </label>
          ))}
          <Button type="submit" variant={result && !stale ? "outline" : "default"} disabled={loading}>
            {loading ? <Spinner data-icon="inline-start" /> : <ListChecksIcon data-icon="inline-start" />}
            {result ? "Check again" : "Check environments"}
          </Button>
        </form>
        {locked.length > 0 && !result && (
          <p className="text-xs text-muted-foreground">
            Environments you already unlocked are included automatically. Leave a password empty to skip that
            environment.
          </p>
        )}
        {result && <ResultView data={result.data} stale={stale} />}
      </CardContent>
    </Card>
  )
}

function ResultView({ data, stale }: { data: CompareResult; stale: boolean }) {
  const skipped = data.environments.filter((e) => e.state !== "compared")
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied", { description: text }),
      () => toast.error("Could not copy to the clipboard"),
    )

  return (
    <div className="grid gap-3">
      {stale && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          A shared file changed since this check. Check again to see the latest.
        </p>
      )}
      {data.compared.length < 2 ? (
        <p className="text-sm text-muted-foreground">Enter the passwords of at least two environments to compare them.</p>
      ) : data.missing.length === 0 ? (
        <p className="flex items-center gap-2 text-sm">
          <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          All {data.shared} variables exist in {data.compared.join(", ")}.
        </p>
      ) : (
        <>
          <p className="text-sm">
            {data.missing.length} variable{data.missing.length === 1 ? " is" : "s are"} missing somewhere ·{" "}
            <span className="text-muted-foreground">{data.shared} exist everywhere</span>
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variable</TableHead>
                  {data.compared.map((name) => (
                    <TableHead key={name}>{name}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.missing.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="font-mono text-xs">{row.key}</TableCell>
                    {data.compared.map((name) =>
                      row.missingFrom.includes(name) ? (
                        <TableCell key={name}>
                          <Button
                            size="xs"
                            variant="outline"
                            className="border-destructive/40 text-destructive"
                            title={`Copy: dotcrypt set ${row.key} -e ${name}`}
                            onClick={() => void copy(`dotcrypt set ${row.key} -e ${name}`)}
                          >
                            Missing
                            <CopyIcon data-icon="inline-end" />
                          </Button>
                        </TableCell>
                      ) : (
                        <TableCell key={name}>
                          <Badge variant="secondary">present</Badge>
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            To fix one, add it to that environment's <code className="font-mono">.env</code> file and click{" "}
            <strong className="font-medium text-foreground">Share changes</strong>, or click{" "}
            <strong className="font-medium text-foreground">Missing</strong> to copy a{" "}
            <code className="font-mono">dotcrypt set</code> command for your terminal.
          </p>
        </>
      )}
      {skipped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not compared: {skipped.map((e) => `${e.name} (${SKIPPED[e.state] ?? e.state})`).join(", ")}
        </p>
      )}
    </div>
  )
}
