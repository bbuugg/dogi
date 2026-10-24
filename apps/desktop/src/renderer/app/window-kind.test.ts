import { describe, expect, it } from 'vitest'
import { resolveWindowKind } from './window-kind'

describe('resolveWindowKind', () => {
  it('defaults to main when there is no window param', () => {
    expect(resolveWindowKind('')).toEqual({ kind: 'main' })
  })
  it('detects the settings window', () => {
    expect(resolveWindowKind('?window=settings')).toEqual({ kind: 'settings' })
  })
  it('passes the initial settings tab through', () => {
    expect(resolveWindowKind('?window=settings&tab=models')).toEqual({
      kind: 'settings',
      initialTab: 'models'
    })
  })
  it('drops an unknown settings tab (query params are untrusted)', () => {
    expect(resolveWindowKind('?window=settings&tab=../../etc')).toEqual({ kind: 'settings' })
  })
  it('detects a conversation float window and passes its seed id', () => {
    expect(resolveWindowKind('?window=conversation&conversationId=abc')).toEqual({
      kind: 'conversation',
      initialConversationId: 'abc'
    })
  })
  it('renders the float window even without a seed id (draft / current)', () => {
    expect(resolveWindowKind('?window=conversation')).toEqual({ kind: 'conversation' })
  })
})
