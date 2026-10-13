export function createBoundedQueue(limit: number, onError: (error: unknown) => void = () => {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Queue limit must be a positive integer.')
  let pending = 0
  let tail: Promise<void> = Promise.resolve()
  return {
    enqueue(task: () => Promise<void>): boolean {
      if (pending >= limit) return false
      pending++
      tail = tail.then(task).catch(onError).finally(() => { pending-- })
      return true
    },
    async drain(): Promise<void> { await tail }
  }
}
