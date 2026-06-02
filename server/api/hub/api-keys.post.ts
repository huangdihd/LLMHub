import { getAuthStore } from '../../stores/auth.store'

export default defineEventHandler(async (event) => {
  const { name } = await readBody(event)
  const store = getAuthStore()
  const { entry, plainKey } = await store.generateKey(name || 'Unnamed')
  return {
    key: {
      id: entry.id,
      name: entry.name,
      created_at: entry.created_at,
      plain_key: plainKey // shown only once
    }
  }
})
