import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GanttRoadmap, milestoneStatus, roadmapLabelSlots, roadmapPositions } from './gantt-roadmap'

const ms = (id: string, day: Date, reached = false) => ({ id, name: id, day, reached })

describe('roadmap helpers', () => {
  const today = new Date(2026, 5, 15)
  it('reads a milestone as reached, late or upcoming', () => {
    expect(milestoneStatus(ms('a', new Date(2026, 5, 1), true), today)).toBe('reached')
    expect(milestoneStatus(ms('a', new Date(2026, 5, 1)), today)).toBe('late')
    expect(milestoneStatus(ms('a', today), today)).toBe('upcoming')
  })
  it('places milestones and today in date order inside a padded span', () => {
    const { pos, todayPos } = roadmapPositions([ms('a', new Date(2026, 0, 1)), ms('b', new Date(2026, 11, 31))], today)
    expect(pos[0]).toBeGreaterThan(0)
    expect(pos[1]).toBeLessThan(100)
    expect(pos[0]).toBeLessThan(todayPos)
    expect(todayPos).toBeLessThan(pos[1])
  })
  it('keeps a lone milestone on today inside the line', () => {
    const { pos, todayPos } = roadmapPositions([ms('a', today)], today)
    expect(pos[0]).toBe(50)
    expect(todayPos).toBe(50)
  })
})

describe('roadmap label slots', () => {
  it('keeps far-apart labels right by the line, above then below', () => {
    expect(roadmapLabelSlots([10, 50, 90], 1000)).toEqual([
      { above: true, level: 0, x: 100 },
      { above: true, level: 0, x: 500 },
      { above: true, level: 0, x: 900 },
    ])
  })
  it('sends crowded labels to the next free lane: below, then further above', () => {
    // Three milestones 20 px apart: 140 px labels can't share a lane.
    const slots = roadmapLabelSlots([50, 52, 54], 1000)
    expect(slots.map((s) => [s.above, s.level])).toEqual([[true, 0], [false, 0], [true, 1]])
  })
  it('reuses a lane once a label is past the previous one', () => {
    const slots = roadmapLabelSlots([10, 11, 40], 1000)
    expect(slots.map((s) => [s.above, s.level])).toEqual([[true, 0], [false, 0], [true, 0]])
  })
  it('pulls labels at the ends inside the line', () => {
    const [first, last] = roadmapLabelSlots([0, 100], 600)
    expect(first.x).toBe(70)
    expect(last.x).toBe(530)
  })
})

describe('GanttRoadmap', () => {
  it('says so when there is no milestone', () => {
    render(<GanttRoadmap milestones={[]} />)
    expect(screen.getByText('No milestones yet.')).toBeInTheDocument()
  })
  it('lists names as plain text without a form to open', () => {
    render(<GanttRoadmap milestones={[ms('Kickoff', new Date(2026, 0, 1), true)]} />)
    expect(screen.queryByRole('button', { name: 'Kickoff' })).toBeNull()
    expect(screen.getAllByText('Kickoff')).toHaveLength(2)
  })
  it('ties a label moved off its milestone to it by a rope', () => {
    // On today: the middle of the line, so only a lane change moves a label.
    const now = new Date()
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    render(<GanttRoadmap milestones={[ms('a', day), ms('b', day), ms('c', day)]} />)
    expect(screen.getByTestId('gantt-roadmap-label-a')).toHaveAttribute('data-lane', 'above-0')
    expect(screen.getByTestId('gantt-roadmap-label-b')).toHaveAttribute('data-lane', 'below-0')
    expect(screen.getByTestId('gantt-roadmap-label-c')).toHaveAttribute('data-lane', 'above-1')
    expect(screen.queryByTestId('gantt-roadmap-rope-a')).toBeNull()
    expect(screen.getByTestId('gantt-roadmap-rope-c')).toBeInTheDocument()
  })
})
