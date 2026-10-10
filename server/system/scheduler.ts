export interface UpdateCheckTarget {
  automatic(): Promise<boolean>
  check(): Promise<unknown>
}

export function startSystemUpdateChecks(target: UpdateCheckTarget, delay = 60_000, interval = 6 * 60 * 60 * 1000): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const schedule = (milliseconds: number) => {
    timer = setTimeout(async () => {
      try {
        if (await target.automatic()) await target.check()
      } catch { /* Background detection must never interrupt the host lifecycle. */ }
      finally { if (!stopped) schedule(interval) }
    }, milliseconds)
    timer.unref?.()
  }
  schedule(delay)
  return () => { stopped = true; clearTimeout(timer) }
}
