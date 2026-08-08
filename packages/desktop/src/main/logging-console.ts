export interface ConsoleTransport<T = unknown> {
  level: string | false
  writeFn(options: T): void
}

export function configureConsoleTransport<T>(transport: ConsoleTransport<T>, packaged: boolean) {
  // Packaged GUI processes already persist every message through the file
  // transport. Writing to an inherited pipe is unsafe because the launcher can
  // exit while Electron is still running, turning a later console write into an
  // asynchronous EPIPE that bypasses a local try/catch and crashes the process.
  if (packaged) {
    transport.level = false
    return
  }

  const write = transport.writeFn.bind(transport)
  transport.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      transport.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}
