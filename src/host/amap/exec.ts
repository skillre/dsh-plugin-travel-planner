import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AmapCliError } from './cli.js'

/** One CLI invocation request. */
export interface ExecRequest {
  /** Executable and arguments; never shell-interpreted. */
  readonly argv: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Extra environment entries merged onto the scrubbed parent environment. */
  readonly env: Readonly<Record<string, string>>
  /** Cooperative timeout budget in milliseconds. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/** Settled result of one CLI invocation. */
export interface ExecResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
}

/** Executes one CLI invocation. Structural so the gateway is testable. */
export type ExecLike = (request: ExecRequest) => Promise<ExecResult>

/** In-memory output cap per stream, in bytes. */
const OUTPUT_CAP_BYTES = 512 * 1024
/** Grace period granted to the child's termination procedure. */
const GRACE_MS = 2_000

/** Structural view of the subprocess service this file needs. */
export interface SubprocessLike {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/**
 * Build an `ExecLike` over the DSH subprocess and timer services.
 * @param subprocess - the subprocess service.
 * @param delay - a fiber-owned timer resolving after the given milliseconds.
 * @returns the executor.
 */
export function createSubprocessExec(subprocess: SubprocessLike, delay: (ms: number) => Promise<void>): ExecLike {
  return async (request) => {
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    if (request.signal?.aborted === true) controller.abort()
    request.signal?.addEventListener('abort', forwardAbort, { once: true })

    let timedOut = false
    let settled = false
    const timeout = delay(Math.max(1, request.timeoutMs)).then(() => {
      // A budget that has already been spent must not abort a finished child.
      if (settled) return
      timedOut = true
      controller.abort()
    })

    let handle: SubprocessHandle
    try {
      handle = subprocess.spawn({
        argv: [...request.argv],
        cwd: request.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_CAP_BYTES },
          stderr: { maxBytes: OUTPUT_CAP_BYTES },
        },
        graceMs: GRACE_MS,
        ...request.env === undefined ? {} : { env: { ...request.env } },
        signal: controller.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new AmapCliError(
        /ENOENT|not found/i.test(message) ? 'AMAP_CLI_NOT_FOUND' : 'AMAP_COMMAND_FAILED',
        `amap-gui could not start: ${message}`,
      )
    }

    try {
      const outcome = await handle.done
      settled = true
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: readCollected(handle, 'stdout'),
        stderr: readCollected(handle, 'stderr'),
        timedOut,
        aborted: request.signal?.aborted === true,
      }
    } catch (error) {
      settled = true
      const message = error instanceof Error ? error.message : String(error)
      throw new AmapCliError(
        /ENOENT|not found/i.test(message) ? 'AMAP_CLI_NOT_FOUND' : 'AMAP_COMMAND_FAILED',
        `amap-gui failed: ${message}`,
      )
    } finally {
      request.signal?.removeEventListener('abort', forwardAbort)
      // The timer is a ceiling, not a floor. Awaiting it here made every call
      // cost the full `commandTimeoutMs` — a 45s default — even when the CLI
      // answered in milliseconds, which is what made a single POI lookup look
      // like a hang in the sidebar. It settles on its own and then does nothing.
      void timeout
    }
  }
}

/**
 * Read one collected stream in full.
 * @param handle - live subprocess handle.
 * @param stream - stream to read.
 * @returns the retained text, or an empty string when the stream was not collected.
 */
function readCollected(handle: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  const reader = stream === 'stdout' ? handle.collected.stdout : handle.collected.stderr
  return reader === undefined ? '' : reader.readFrom(0).text
}

/**
 * Build a fiber-owned delay function from a Cordis context.
 * The plugin must declare the `timer` injection before calling this; the
 * context type gains `timeout` from the composed timer plugin's mixin.
 * @param ctx - plugin context carrying the timer mixin.
 * @returns a function resolving after the requested delay.
 */
export function delayFrom(ctx: Context): (ms: number) => Promise<void> {
  const timer = ctx as unknown as { timeout(delay: number): Promise<void> }
  return (ms: number) => timer.timeout(ms)
}
