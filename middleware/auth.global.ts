export default defineNuxtRouteMiddleware(async (to) => {
  // Pages that require authentication
  const protectedRoutes = ['/providers', '/api-keys']
  if (!protectedRoutes.includes(to.path)) return

  // Skip check on login page itself
  if (to.path === '/login') return

  try {
    const res = await $fetch('/api/auth/status')
    if (!(res as any).authenticated) {
      return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
    }
  } catch {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
