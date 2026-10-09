import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'

// The plugin's components read React + api off the shared runtime module (set in
// `register()` at runtime); seed it with the mock's real React before any render.
const mock = createMockValleyApi()
beforeAll(() => initRuntime(mock.api))

// Imported after initRuntime so the module's `runtime.React` is already assigned.
import { PermissionControl, ModelPicker, EffortPicker } from '../src/Page'

afterEach(cleanup)

describe('PermissionControl', () => {
  it('uses the compact host-owned access widget without supplying policy or a selected mode', () => {
    const host = mock.accessControl, onChanged = vi.fn()
    render(<PermissionControl onChanged={onChanged} />)
    expect(host).toHaveBeenCalled()
    expect(Object.keys(host.mock.calls.at(-1)![0]).sort()).toEqual(['disabled', 'iconOnly', 'onChange', 'variant'])
    expect(host.mock.calls.at(-1)![0]).toMatchObject({ variant: 'compact' })
    fireEvent.click(screen.getByRole('button', { name: 'Host access control' }))
    expect(onChanged).toHaveBeenCalledOnce()
    expect(mock.driverCalls.some(call => call.method === 'saveGuard')).toBe(false)
    host.mockClear()
  })
  it('passes disabled state through to the host control', () => {
    render(<PermissionControl disabled onChanged={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Host access control' })).toBeDisabled()
  })
})

it('focuses the selected model and supports keyboard selection in the compact menu', () => {
  const onSelect = vi.fn()
  render(<ModelPicker value="fern" onSelect={onSelect} options={[
    { value: 'auto', label: 'Automatic', description: 'Route automatically' },
    { value: 'fern', label: 'Fern', description: 'Forest connection' },
    { value: 'moss', label: 'Moss', description: 'Forest connection' }
  ]} />)
  expect(screen.queryByRole('textbox')).toBeNull()
  const current = screen.getByRole('option', { name: 'Fern' })
  expect(current).toHaveFocus()
  fireEvent.keyDown(current, { key: 'ArrowDown' })
  const next = screen.getByRole('option', { name: 'Moss' })
  expect(next).toHaveFocus()
  fireEvent.click(next)
  expect(onSelect).toHaveBeenCalledWith('moss')
})

it('keeps large model lists searchable and duplicate model connections distinguishable', () => {
  render(<ModelPicker value="fern-0" onSelect={vi.fn()} options={Array.from({ length: 9 }, (_, index) => ({
    value: `fern-${index}`, label: 'Fern', description: `Forest connection ${index}`
  }))} />)
  const search = screen.getByRole('textbox')
  fireEvent.change(search, { target: { value: 'connection 8' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.getByRole('option')).toHaveTextContent('Forest connection 8')
  fireEvent.change(search, { target: { value: 'no such model' } })
  expect(screen.getByRole('status')).toHaveTextContent('No matching models')
})

it('selects and resets model effort while hiding unsupported levels', () => {
  const onChange = vi.fn(), onModels = vi.fn()
  const { rerender } = render(<EffortPicker value="medium" supported={['low', 'medium', 'high', 'xhigh', 'max']} modelLabel="Canopy" onChange={onChange} onModels={onModels} />)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } })
  expect(onChange).toHaveBeenLastCalledWith('max')
  fireEvent.click(screen.getByRole('button', { name: 'Reset effort' }))
  expect(onChange).toHaveBeenLastCalledWith(undefined)
  fireEvent.click(screen.getByRole('button', { name: 'Select model' }))
  expect(onModels).toHaveBeenCalledOnce()
  rerender(<EffortPicker value="medium" supported={['low', 'medium', 'high']} modelLabel="Fern" onChange={onChange} onModels={onModels} />)
  expect(screen.queryByRole('button', { name: 'Max' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Extra High' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Low' }))
  expect(onChange).toHaveBeenLastCalledWith('low')
})


it('offers Low, High and Max without choosing an effort on mount', () => {
  const onChange = vi.fn()
  render(<EffortPicker supported={['low', 'high', 'max']} modelLabel="Fern" onChange={onChange} onModels={() => {}} />)
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Default')
  for (const name of ['Low', 'High', 'Max']) expect(screen.getByRole('button', { name })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Medium' })).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})
