export default defineNuxtRouteMiddleware(async (to) => {
  // Pages that require authentication
  const protectedRoutes = ['/providers', '/api-keys']
  if (!protectedRoutes.includes(to.path)) return

  // Skip check on login page itself
  if (to.path === '/login') return

  // Use useRequestFetch so the session cookie is forwarded during SSR;
  // a plain $fetch on the server omits it and would falsely redirect to login.
  const authFetch = useRequestFetch()
  try {
    const res = await authFetch('/api/auth/status')
    if (!(res as any).authenticated) {
      return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
    }
  } catch (e: any) {
    // Only redirect on explicit 401; transient errors shouldn't block access
    if (e?.statusCode === 401) {
      return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
    }
  }
})
