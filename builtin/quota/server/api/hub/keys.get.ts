import { listKeys } from '../../../service'

export default defineEventHandler(async () => {
  const keys = await listKeys()
  return { keys }
})
