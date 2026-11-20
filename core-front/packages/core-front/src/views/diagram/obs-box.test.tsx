import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Position, type EdgeProps } from '@xyflow/react'
import { BusEdge, type BusEdgeType } from './obs-box'

describe('BusEdge', () => {
  it('runs down to the bus, across to the trunk left of the child, down, then into its left side', () => {
    const props = {
      id: 'e', source: 'p', target: 'c', sourceX: 100, sourceY: 110, targetX: 300, targetY: 255,
      sourcePosition: Position.Bottom, targetPosition: Position.Left, data: { trunk: 20 },
    } as unknown as EdgeProps<BusEdgeType>
    const { container } = render(<svg><BusEdge {...props} /></svg>)
    expect(container.querySelector('path')!.getAttribute('d')).toBe('M100,110V140H280V255H300')
  })
})
