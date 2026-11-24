import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GanttRoadmap, milestoneStatus, roadmapPositions } from './gantt-roadmap'

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
})
