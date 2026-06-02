export const getStats = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  return { totalCalls }
}

export const incrementCalls = async () => {
  const storage = useStorage('data')
  const totalCalls = (await storage.getItem('stats:totalCalls')) as number || 0
  await storage.setItem('stats:totalCalls', totalCalls + 1)
}