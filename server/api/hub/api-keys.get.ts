import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async () => {
  const store = getAuthStore()
  const keys = await store.listKeys()
  return { keys }
})
