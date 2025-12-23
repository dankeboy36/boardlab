// @ts-check
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import Root from './Root.jsx'

describe('Root', () => {
  const setup = () => {
    return render(<Root />)
  }

  it('renders without crashing', async () => {
    setup()
    // Expect the default tab header text to be present
    expect(screen.getByText('Terminal')).toBeDefined()
  })
})
