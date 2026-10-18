import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Empty, Field, Input, Notice } from '@zellige/react'
import { api } from '../api'
import { invalidField } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import type { ProjectView } from '../types'

type FieldName = Exclude<keyof ProjectView, 'id'>

/** The page's own words for each field, and for what is wrong when the server refuses it. */
const FIELDS: readonly { name: FieldName; label: string; hint: string; problem: string }[] = [
  {
    name: 'key',
    label: 'Key',
    hint: 'Starts every task key, as in PAY-1.',
    problem: 'Use 2–10 capital letters and digits, starting with a letter, that no project uses.',
  },
  { name: 'name', label: 'Name', hint: 'Shown beside the key.', problem: 'Enter a name.' },
  {
    name: 'repo_path',
    label: 'Repository path',
    hint: 'The absolute path of the repository on this machine.',
    problem: 'There is no git repository at this path, or another project already uses it.',
  },
  {
    name: 'github_repo',
    label: 'GitHub repository',
    hint: 'owner/name, as a remote of that repository points at it.',
    problem: 'No remote of that repository points at this GitHub repository.',
  },
  {
    name: 'base_branch',
    label: 'Base branch',
    hint: 'Pull requests go into this branch.',
    problem: 'Enter the branch pull requests go into.',
  },
  {
    name: 'test_command',
    label: 'Test command',
    hint: 'Runs in the repository after every Build.',
    problem: 'This command does not run in that repository.',
  },
]

const BLANK: Record<FieldName, string> = {
  key: '',
  name: '',
  repo_path: '',
  github_repo: '',
  base_branch: 'main',
  test_command: 'npm test',
}

export function Projects() {
  const heading = usePage('Projects', 'projects')
  const client = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const [form, setForm] = useState(BLANK)
  const create = useMutation({
    mutationFn: () => api.createProject(form),
    onSuccess: () => {
      setForm(BLANK)
      return client.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const field = invalidField(create.error)
  const named = FIELDS.some((f) => f.name === field)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const summary = useRef<HTMLDivElement>(null)

  // A refusal moves focus to the field it names, which now carries the reason, or else to the
  // summary. Both are rendered by the time this runs, so the reason is read with the focus.
  useEffect(() => {
    if (create.error === null) return
    const input = field === undefined ? undefined : inputs.current.get(field)
    if (input) input.focus()
    else summary.current?.focus()
  }, [create.error, field])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate()
  }

  return (
    <main className="page">
      <h1 ref={heading} tabIndex={-1}>
        Projects
      </h1>

      <section aria-labelledby="registered">
        <h2 id="registered">Registered repositories</h2>
        <Loaded query={projects} failure="The projects could not be loaded.">
          {(list) =>
            list.length === 0 ? (
              <Empty title="No projects yet">Register a repository below.</Empty>
            ) : (
              <ul className="projects">
                {list.map((project) => (
                  <li key={project.id}>
                    <Link to={`/p/${project.key}`}>
                      {project.key} {project.name}
                    </Link>
                    <span className="muted">{project.github_repo}</span>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </section>

      <section aria-labelledby="register">
        <h2 id="register">Register a repository</h2>
        <form className="register" onSubmit={submit}>
          {FIELDS.map((f) => (
            <Field
              key={f.name}
              label={f.label}
              hint={f.hint}
              error={field === f.name ? f.problem : undefined}
            >
              <Input
                name={f.name}
                value={form[f.name]}
                autoComplete="off"
                ref={(node) => {
                  if (node) inputs.current.set(f.name, node)
                  else inputs.current.delete(f.name)
                }}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
              />
            </Field>
          ))}
          <Notice tone="danger" className="announce" ref={summary} tabIndex={-1}>
            {create.isError && !named ? 'The repository could not be registered. Try again.' : ''}
          </Notice>
          <Notice className="announce">
            {create.isSuccess ? `${create.data.key} registered.` : ''}
          </Notice>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Register
          </Button>
        </form>
      </section>
    </main>
  )
}
