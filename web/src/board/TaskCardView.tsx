import { Fragment, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Badge } from '@zellige/react'
import type { TaskCard } from '../types'
import { formatUsd, shortModel } from './columns'

/** The id of a card's link, by which focus finds the card again after it changes columns. */
export const cardDomId = (taskId: string) => `card-${taskId}`

/**
 * A card is one link, named by its key and title first. The spaces between its parts are text,
 * so the accessible name reads as words. Dragging is for the mouse; each move a drag makes is
 * also a button in the card's dialog.
 */
export function TaskCardView({
  card,
  projectKey,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  card: TaskCard
  projectKey: string
  onDragStart: () => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  return (
    <Link
      id={cardDomId(card.id)}
      to={`/p/${projectKey}/${card.id}`}
      className="zl-card task-card"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="card-key">{card.key}</span> <span className="card-title">{card.title}</span>{' '}
      <span className="card-meta">
        {card.question_waiting && (
          <>
            <Badge tone="warning">Question waiting</Badge>{' '}
          </>
        )}
        {(card.state === 'running' || card.state === 'spec_draft') && card.phase !== null && (
          <>
            <Badge tone="accent">
              {card.phase}
              {card.attempt !== null && card.attempt > 1 ? ` · attempt ${card.attempt}` : ''}
            </Badge>{' '}
          </>
        )}
        {card.models.map((model) => (
          <Fragment key={model}>
            <Badge>{shortModel(model)}</Badge>{' '}
          </Fragment>
        ))}
        {(card.cost_usd > 0 || !card.cost_complete) && (
          <Badge tone="success">
            {formatUsd(card.cost_usd)}
            {!card.cost_complete && (
              <>
                <span aria-hidden="true">+</span>
                <span className="zl-visually-hidden"> or more: a model has no price yet</span>
              </>
            )}
          </Badge>
        )}
      </span>
    </Link>
  )
}
