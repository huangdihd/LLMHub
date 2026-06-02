export default defineNuxtRouteMiddleware(async (to) => {
  // Pages that require authentication
  const protectedRoutes = ['/providers']
  if (!protectedRoutes.includes(to.path)) return

  try {
    const { $fetch } = useNuxtApp()
    const res = await $fetch('/api/auth/status')
    const status = res as any

    if (!status.authenticated) {
      return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
    }
  } catch {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
