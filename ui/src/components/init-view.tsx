import { useState } from "react"
import { ShieldPlusIcon } from "lucide-react"

import type { UninitializedStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function InitView({
  status,
  onInit,
}: {
  status: UninitializedStatus
  onInit: (value: { name: string; environments: string[]; defaultEnvironment?: string }) => Promise<void>
}) {
  const [name, setName] = useState(status.suggestedName)
  const [environments, setEnvironments] = useState(status.defaultEnvironments.join(", "))
  const [defaultEnvironment, setDefaultEnvironment] = useState("development")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const envList = environments
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (envList.length === 0) return setError("Add at least one environment.")
    setPending(true)
    setError(null)
    try {
      await onInit({
        name: name.trim(),
        environments: envList,
        defaultEnvironment: envList.includes(defaultEnvironment) ? defaultEnvironment : envList[0],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldPlusIcon />
        </EmptyMedia>
        <EmptyTitle>No vault in this project yet</EmptyTitle>
        <EmptyDescription>
          Create <code className="font-mono">{status.configFile}</code> in <code className="font-mono break-all">{status.root}</code>{" "}
          and protect plaintext env files in .gitignore.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-md">
        <Card className="w-full text-left">
          <form onSubmit={submit}>
            <CardHeader>
              <CardTitle>Initialize vault</CardTitle>
              <CardDescription>You can add more environments later.</CardDescription>
            </CardHeader>
            <CardContent className="py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="init-name">Vault name</FieldLabel>
                  <Input id="init-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="init-envs">Environments</FieldLabel>
                  <Input id="init-envs" value={environments} onChange={(e) => setEnvironments(e.target.value)} />
                  <FieldDescription>Comma-separated. Each maps to .env.&lt;name&gt; and .env.&lt;name&gt;.enc.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="init-default">Default environment</FieldLabel>
                  <Input id="init-default" value={defaultEnvironment} onChange={(e) => setDefaultEnvironment(e.target.value)} />
                </Field>
                {error && <FieldError>{error}</FieldError>}
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                Create {status.configFile}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </EmptyContent>
    </Empty>
  )
}
