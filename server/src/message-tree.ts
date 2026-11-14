import type { Session } from '../../src/services/chat/types.js'

export class MessageTreeIntegrityError extends Error {}

/** Validate the complete tree, including currently unselected branches, before any write. */
export function assertMessageTree(session: Session): void {
  const fail = (reason: string): never => {
    throw new MessageTreeIntegrityError(`Invalid message tree: ${reason}`)
  }
  const nodes = new Map(session.messages.map((node) => [node.id, node]))
  if (nodes.size !== session.messages.length) {
    fail('duplicate node id')
  }
  if (nodes.size === 0) {
    if (session.rootMessageId != null) {
      fail('empty tree must have no selected root')
    }
    return
  }
  const root = session.rootMessageId ? nodes.get(session.rootMessageId) : undefined
  if (!root || root.parentId != null || root.role !== 'user') {
    fail('selected root must be a root user node')
  }
  for (const node of nodes.values()) {
    if (!node.id || (node.role !== 'user' && node.role !== 'assistant')) {
      fail('invalid node identity or role')
    }
    if (node.parentId != null) {
      const parent = nodes.get(node.parentId)
      if (!parent || parent.role === node.role) {
        fail('parent must exist in this conversation and alternate roles')
      }
    } else if (node.role !== 'user') {
      fail('all alternative roots must be user nodes')
    }
    if (node.selectedChildId != null) {
      const selected = nodes.get(node.selectedChildId)
      if (!selected || selected.parentId !== node.id) {
        fail('selected child must be a direct child in this conversation')
      }
    }
  }
  // Walk each ancestry once. No recursion, so a long valid history cannot overflow the stack.
  const completed = new Set<string>()
  for (const node of nodes.values()) {
    const path = new Set<string>()
    let current: typeof node | undefined = node
    while (current && !completed.has(current.id)) {
      if (path.has(current.id)) {
        fail('cycle')
      }
      path.add(current.id)
      current = current.parentId == null ? undefined : nodes.get(current.parentId)
    }
    for (const id of path) {
      completed.add(id)
    }
  }
}
