import { ArrowDownToLineIcon, ArrowUpFromLineIcon, KeyRoundIcon, UserPlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

function Flow({ icon, title, steps }: { icon: React.ReactNode; title: string; steps: React.ReactNode[] }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h3>
      <ol className="space-y-1.5 text-sm text-muted-foreground">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground tabular-nums">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const b = (text: string) => <strong className="font-medium text-foreground">{text}</strong>
const c = (text: string) => <code className="font-mono text-xs text-foreground">{text}</code>

export function HowItWorks({ onHide }: { onHide: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>How sharing works</CardTitle>
        <CardDescription>
          Your secrets stay in normal {c(".env")} files. dotcrypt locks them into {c(".enc")} files that are safe to
          commit, so your team gets them through Git like any other change.
        </CardDescription>
        <CardAction>
          <Button size="icon-sm" variant="ghost" aria-label="Hide guide" onClick={onHide}>
            <XIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <Flow
          icon={<ArrowUpFromLineIcon />}
          title="You added or changed a variable"
          steps={[
            <>Edit your {c(".env")} file in your editor, as usual.</>,
            <>Click {b("Share changes")} on its card.</>,
            <>Commit and push the {c(".enc")} file. The card shows the exact command.</>,
          ]}
        />
        <Flow
          icon={<ArrowDownToLineIcon />}
          title="A teammate changed something"
          steps={[
            <>Run {c("git pull")}.</>,
            <>The card says {b("New changes from your team")}.</>,
            <>Click {b("Get latest")}. Your {c(".env")} file is updated.</>,
          ]}
        />
        <Flow
          icon={<UserPlusIcon />}
          title="Someone new joins"
          steps={[
            <>They clone the repo and run {c("npx dotcrypt ui")}.</>,
            <>They click {b("Get secrets")} on each card.</>,
            <>They enter the password you gave them privately.</>,
          ]}
        />
      </CardContent>
      <CardFooter className="gap-2 text-xs text-muted-foreground">
        <KeyRoundIcon className="size-3.5 shrink-0" />
        Each environment has one password. Share it once, privately (for example in a password manager), never in Git or
        chat.
      </CardFooter>
    </Card>
  )
}
