/** One run of `work` for a burst of calls (A71): the first call waits `wait` ms for others to join it, and a call made
 * while a run is going starts one more after it. Every caller gets the result of the run that covered its call. */
export function coalesce<T>(work: () => Promise<T>, wait: number): () => Promise<T> {
  let next: Promise<T> | null = null, running: Promise<unknown> = Promise.resolve();
  return () => next ??= new Promise<T>((resolve, reject) => setTimeout(() => {
    running = running.then(() => {
      next = null;
      const run = work();
      run.then(resolve, reject);
      return run.catch(() => undefined);
    });
  }, wait));
}
