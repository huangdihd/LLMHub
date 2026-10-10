export const getStats = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  return { totalCalls }
}

let pendingIncrement: Promise<void> = Promise.resolve()

export const incrementCalls = (): Promise<void> => {
  const increment = pendingIncrement.then(persistIncrement)
  // Keep the queue usable after a failure; the caller still receives the rejection.
  pendingIncrement = increment.catch(() => {})
  return increment
}

const persistIncrement = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  await storage.setItem('stats:totalCalls', totalCalls + 1)
}
