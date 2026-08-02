export function createStorageMutationQueue() {
  let tail = Promise.resolve()

  return <T>(operation: () => Promise<T>) => {
    const current = tail.catch(() => undefined).then(operation)
    tail = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }
}
