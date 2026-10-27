import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Empty, Field, Input, Notice, Select } from '@zellige/react'
import { api } from '../api'
import { invalidField } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import type { ProjectView, ProjectWithLinks } from '../types'

type FieldName = Exclude<keyof ProjectView, 'id'>

const SETUP_PROBLEM = 'This command does not run in that repository.'

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
  {
    name: 'setup_command',
    label: 'Setup command',
    hint: 'Optional. Runs in each run’s fresh checkout before any agent starts, such as npm ci.',
    problem: SETUP_PROBLEM,
  },
]

const TARGET_PROBLEM = 'Pick a project this one does not already link to.'
const NOTE_PROBLEM = 'Enter a note of up to 500 characters.'

const BLANK: Record<FieldName, string> = {
  key: '',
  name: '',
  repo_path: '',
  github_repo: '',
  base_branch: 'main',
  test_command: 'npm test',
  setup_command: '',
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
  const [announcement, setAnnouncement] = useState('')

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
                    <SetupCommand project={project} />
                    <Links project={project} all={list} announce={setAnnouncement} />
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
        <Notice className="announce">{announcement}</Notice>
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

/** A project's setup command, and the control that sets or clears it. */
function SetupCommand({ project }: { project: ProjectView }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const edit = useRef<HTMLButtonElement>(null)
  const save = useMutation({
    mutationFn: () => api.setSetupCommand(project.key, value.trim() === '' ? null : value),
    onSuccess: async () => {
      setEditing(false)
      await client.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const refused = invalidField(save.error) === 'setup_command'

  useEffect(() => {
    if (save.error !== null && refused) input.current?.focus()
  }, [save.error, refused])
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  if (!editing) {
    return (
      <>
        <span className="muted">
          {project.setup_command === null
            ? 'No setup command'
            : `Setup command: ${project.setup_command}`}
        </span>
        <Button
          ref={edit}
          type="button"
          onClick={() => {
            setValue(project.setup_command ?? '')
            save.reset()
            setEditing(true)
          }}
        >
          {`Edit setup command of ${project.key}`}
        </Button>
      </>
    )
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <Field
        label={`Setup command of ${project.key}`}
        hint="Leave it empty to clear it."
        error={refused ? SETUP_PROBLEM : undefined}
      >
        <Input
          ref={input}
          name="setup_command"
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Notice tone="danger" className="announce">
        {save.isError && !refused ? 'The setup command could not be saved. Try again.' : ''}
      </Notice>
      <Button type="submit" variant="primary" busy={save.isPending}>
        Save
      </Button>
      <Button type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  )
}

/** The projects a project links to, each removable, and the form that adds one. */
function Links({
  project,
  all,
  announce,
}: {
  project: ProjectWithLinks
  all: ProjectWithLinks[]
  announce: (text: string) => void
}) {
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const select = useRef<HTMLSelectElement>(null)
  const noteInput = useRef<HTMLInputElement>(null)
  const linked = new Set(project.links.map((link) => link.key))
  const offered = all.filter((other) => other.key !== project.key && !linked.has(other.key))

  const add = useMutation({
    mutationFn: () => api.addLink(project.key, { target, note }),
    onSuccess: async () => {
      announce(`${project.key} now links to ${target}.`)
      setTarget('')
      setNote('')
      await client.invalidateQueries({ queryKey: ['projects'] })
    },
  })
  const remove = useMutation({
    mutationFn: (key: string) => api.removeLink(project.key, key),
    onSuccess: async (_data, key) => {
      announce(`${project.key} no longer links to ${key}.`)
      await client.invalidateQueries({ queryKey: ['projects'] })
      // The Remove button that had focus is gone: the form is the next place to work.
      select.current?.focus()
    },
  })
  const field = invalidField(add.error)
  const named = field === 'target' || field === 'note'

  useEffect(() => {
    if (add.error === null) return
    if (field === 'note') noteInput.current?.focus()
    else if (field === 'target') select.current?.focus()
  }, [add.error, field])

  return (
    <div className="links">
      {project.links.length > 0 && (
        <ul aria-label={`Links of ${project.key}`}>
          {project.links.map((link) => (
            <li key={link.key}>
              <span>
                {link.key} {link.name}
              </span>
              <span className="muted">{link.note}</span>
              <Button
                type="button"
                busy={remove.isPending && remove.variables === link.key}
                onClick={() => remove.mutate(link.key)}
              >
                {`Remove link to ${link.key}`}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Notice tone="danger" className="announce">
        {remove.isError ? 'The link could not be removed. Try again.' : ''}
      </Notice>
      <form
        aria-label={`Add a link from ${project.key}`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <Field
          label={`Link ${project.key} to`}
          error={field === 'target' ? TARGET_PROBLEM : undefined}
        >
          <Select ref={select} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a project</option>
            {offered.map((other) => (
              <option key={other.key} value={other.key}>
                {other.key} – {other.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={`Note on the link from ${project.key}`}
          hint="Required. Says what the project is for."
          error={field === 'note' ? NOTE_PROBLEM : undefined}
        >
          <Input
            ref={noteInput}
            required
            value={note}
            autoComplete="off"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Notice tone="danger" className="announce">
          {add.isError && !named ? 'The link could not be added. Try again.' : ''}
        </Notice>
        <Button type="submit" variant="primary" busy={add.isPending}>
          Add link
        </Button>
      </form>
    </div>
  )
}
