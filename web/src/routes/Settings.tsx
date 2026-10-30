import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Notice } from '@zellige/react'
import { api } from '../api'
import { invalidField } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import { testCommandsKey } from '../stream'
import type { TestCommand } from '../types'

const NAME_PROBLEM = 'Use 1 to 40 characters that no other test command of this project uses.'
const COMMAND_PROBLEM = 'Enter a command of up to 500 characters that runs in that repository.'
const SAVE_FAILED = 'The test command could not be saved. Try again.'
const REMOVE_FAILED = 'The test command could not be removed. Try again.'

export function Settings() {
  const { key = '' } = useParams()
  const heading = usePage(`${key} settings`, `settings:${key}`)
  const commands = useQuery({
    queryKey: testCommandsKey(key),
    queryFn: () => api.testCommands(key),
  })
  const [status, setStatus] = useState('')

  return (
    <main className="page">
      <Link to={`/p/${key}`} aria-label={`Board of ${key}`}>
        Board
      </Link>
      <h1 ref={heading} tabIndex={-1}>{`${key} settings`}</h1>
      <Notice className="announce">{status}</Notice>
      <Loaded query={commands} failure="This project could not be loaded.">
        {(list) => <TestCommands projectKey={key} list={list} announce={setStatus} />}
      </Loaded>
    </main>
  )
}

/** Which control gets focus once the list has been drawn again. */
type Landing = { to: 'edit'; id: string } | { to: 'list' } | { to: 'name' }

function TestCommands({
  projectKey,
  list,
  announce,
}: {
  projectKey: string
  list: TestCommand[]
  announce: (text: string) => void
}) {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: testCommandsKey(projectKey) })
  const [editing, setEditing] = useState<string | undefined>()
  const [landing, setLanding] = useState<Landing | undefined>()
  const listBox = useRef<HTMLUListElement>(null)
  const listAlert = useRef<HTMLDivElement>(null)
  const addAlert = useRef<HTMLDivElement>(null)
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const addName = useRef<HTMLInputElement>(null)
  const addCommand = useRef<HTMLInputElement>(null)
  const editName = useRef<HTMLInputElement>(null)
  const editCommand = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState({ name: '', command: '' })
  const [draft, setDraft] = useState({ name: '', command: '' })

  const add = useMutation({
    mutationFn: () => api.addTestCommand(projectKey, form),
    onSuccess: async (added) => {
      await refresh()
      announce(`${added.name} added.`)
      setForm({ name: '', command: '' })
      setLanding({ to: 'name' })
    },
  })
  const edit = useMutation({
    mutationFn: (id: string) => api.updateTestCommand(projectKey, id, draft),
    onSuccess: async (saved) => {
      await refresh()
      announce(`${saved.name} saved.`)
      setEditing(undefined)
      setLanding({ to: 'edit', id: saved.id })
    },
  })
  const makeDefault = useMutation({
    mutationFn: (command: TestCommand) =>
      api.updateTestCommand(projectKey, command.id, { is_default: true }),
    onSuccess: async (made) => {
      await refresh()
      announce(`${made.name} is now the default.`)
      setLanding({ to: 'edit', id: made.id })
    },
  })
  const remove = useMutation({
    mutationFn: (command: TestCommand) => api.removeTestCommand(projectKey, command.id),
    onSuccess: async (_none, command) => {
      await refresh()
      announce(`${command.name} removed. Tasks that chose it now use the default.`)
      setLanding({ to: 'list' })
    },
  })

  // Focus moves once the list shows the outcome, so the control it lands on exists.
  useEffect(() => {
    if (landing === undefined) return
    if (landing.to === 'name') addName.current?.focus()
    else if (landing.to === 'list') listBox.current?.focus()
    else editButtons.current.get(landing.id)?.focus()
    setLanding(undefined)
  }, [landing])

  useEffect(() => {
    if (editing !== undefined) editName.current?.focus()
  }, [editing])

  const addField = invalidField(add.error)
  const editField = invalidField(edit.error)
  const addNamed = addField === 'name' || addField === 'command'
  const editNamed = editField === 'name' || editField === 'command'
  const listMessage = remove.isError
    ? REMOVE_FAILED
    : (edit.isError && !editNamed) || makeDefault.isError
      ? SAVE_FAILED
      : ''

  // A refusal moves focus to the field it names, which carries the reason; any other failure
  // moves it to the alert that now holds the message.
  useEffect(() => {
    if (add.error === null) return
    if (addField === 'name') addName.current?.focus()
    else if (addField === 'command') addCommand.current?.focus()
    else addAlert.current?.focus()
  }, [add.error, addField])
  useEffect(() => {
    if (edit.error === null) return
    if (editField === 'name') editName.current?.focus()
    else if (editField === 'command') editCommand.current?.focus()
    else listAlert.current?.focus()
  }, [edit.error, editField])
  useEffect(() => {
    if (makeDefault.error !== null || remove.error !== null) listAlert.current?.focus()
  }, [makeDefault.error, remove.error])

  return (
    <>
      <h2>Test commands</h2>
      <Notice tone="danger" className="announce" ref={listAlert} tabIndex={-1}>
        {listMessage}
      </Notice>
      <ul
        className="projects"
        aria-label={`Test commands of ${projectKey}`}
        ref={listBox}
        tabIndex={-1}
      >
        {list.map((command) =>
          editing === command.id ? (
            <li key={command.id}>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  edit.mutate(command.id)
                }}
              >
                <Field
                  label={`Name of ${command.name}`}
                  error={editField === 'name' ? NAME_PROBLEM : undefined}
                >
                  <Input
                    ref={editName}
                    value={draft.name}
                    autoComplete="off"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </Field>
                <Field
                  label={`Command of ${command.name}`}
                  error={editField === 'command' ? COMMAND_PROBLEM : undefined}
                >
                  <Input
                    ref={editCommand}
                    value={draft.command}
                    autoComplete="off"
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                </Field>
                <Button type="submit" variant="primary" busy={edit.isPending}>
                  Save
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setEditing(undefined)
                    setLanding({ to: 'edit', id: command.id })
                  }}
                >
                  Cancel
                </Button>
              </form>
            </li>
          ) : (
            <li key={command.id}>
              <span>{command.name}</span>
              <span className="muted">{command.command}</span>
              {command.is_default && <span>Default</span>}
              <Button
                type="button"
                ref={(node) => {
                  if (node) editButtons.current.set(command.id, node)
                  else editButtons.current.delete(command.id)
                }}
                onClick={() => {
                  edit.reset()
                  setDraft({ name: command.name, command: command.command })
                  setEditing(command.id)
                }}
              >
                {`Edit ${command.name}`}
              </Button>
              {!command.is_default && (
                <>
                  <Button
                    type="button"
                    busy={makeDefault.isPending && makeDefault.variables?.id === command.id}
                    onClick={() => makeDefault.mutate(command)}
                  >
                    {`Make ${command.name} the default`}
                  </Button>
                  <Button
                    type="button"
                    busy={remove.isPending && remove.variables?.id === command.id}
                    onClick={() => remove.mutate(command)}
                  >
                    {`Remove ${command.name}`}
                  </Button>
                </>
              )}
            </li>
          ),
        )}
      </ul>

      <h2>Add a test command</h2>
      <form
        className="register"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <Field label="Name" error={addField === 'name' ? NAME_PROBLEM : undefined}>
          <Input
            ref={addName}
            value={form.name}
            autoComplete="off"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Command" error={addField === 'command' ? COMMAND_PROBLEM : undefined}>
          <Input
            ref={addCommand}
            value={form.command}
            autoComplete="off"
            onChange={(e) => setForm({ ...form, command: e.target.value })}
          />
        </Field>
        <Notice tone="danger" className="announce" ref={addAlert} tabIndex={-1}>
          {add.isError && !addNamed ? SAVE_FAILED : ''}
        </Notice>
        <Button type="submit" variant="primary" busy={add.isPending}>
          Add command
        </Button>
      </form>
    </>
  )
}
