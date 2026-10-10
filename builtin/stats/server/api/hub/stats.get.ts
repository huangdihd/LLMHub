import { getStats } from '../../../service'

export default defineEventHandler(async (event) => {
  const stats = await getStats()
  return stats
})
