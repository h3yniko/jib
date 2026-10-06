import { existsSync } from 'node:fs'
import { InternalError } from '@jib/errors'
import { type DockerExec, type ExecResult, dockerRealExec } from './exec.ts'

export interface ComposeConfig {
  app: string
  dir: string
  files: string[]
  envFile?: string
  override?: string
  /** Injected exec, defaults to zx-backed docker execution — tests pass a stub. */
  exec?: DockerExec
}

export interface UpOptions {
  services?: string[]
  noBuild?: boolean
  buildArgs?: Record<string, string>
  quiet?: boolean
}

export interface DockerCompose {
  cfg: ComposeConfig
  projectName(): string
  baseArgs(): string[]
  build(
    buildArgs?: Record<string, string>,
    opts?: { quiet?: boolean },
  ): Promise<InternalError | undefined>
  up(opts?: UpOptions): Promise<InternalError | undefined>
  down(removeVolumes?: boolean, opts?: { quiet?: boolean }): Promise<InternalError | undefined>
  exec(service: string, cmd: string[]): Promise<InternalError | undefined>
  run(service: string, cmd: string[]): Promise<InternalError | undefined>
  logs(
    service?: string,
    opts?: { follow?: boolean; tail?: number },
  ): Promise<InternalError | undefined>
  resolvedConfig(): Promise<Record<string, unknown> | InternalError>
  ps(): Promise<ExecResult | InternalError>
}

/** Shared project-name mapping for Compose execution and status queries. */
export function dockerProjectName(app: string): string {
  return `jib-${app}`
}

/** Creates a plain docker-compose runner object for one app. */
export function dockerCreateCompose(cfg: ComposeConfig): DockerCompose {
  const runner = cfg.exec ?? dockerRealExec

  function baseArgs(): string[] {
    const args = ['compose', '-p', dockerProjectName(cfg.app)]
    for (const file of cfg.files) {
      args.push('-f', file)
    }
    if (cfg.override && existsSync(cfg.override)) {
      args.push('-f', cfg.override)
    }
    return args
  }

  function envArgs(): string[] {
    return cfg.envFile ? ['--env-file', cfg.envFile] : []
  }

  return {
    cfg,
    projectName: () => dockerProjectName(cfg.app),
    baseArgs,
    async build(buildArgs: Record<string, string> = {}, opts: { quiet?: boolean } = {}) {
      const args = ['docker', ...baseArgs(), ...envArgs(), 'build']
      return runResult(cfg, runner, args, {
        ...(Object.keys(buildArgs).length > 0 ? { env: buildArgs } : {}),
        ...(opts.quiet ? { capture: true } : {}),
      })
    },
    async up(opts: UpOptions = {}) {
      const args = [
        'docker',
        ...baseArgs(),
        ...envArgs(),
        'up',
        '-d',
        '--force-recreate',
        '--remove-orphans',
        ...(opts.noBuild ? ['--no-build'] : []),
        ...(opts.services ?? []),
      ]
      return runResult(cfg, runner, args, {
        ...(opts.buildArgs && Object.keys(opts.buildArgs).length > 0
          ? { env: opts.buildArgs }
          : {}),
        ...(opts.quiet ? { capture: true } : {}),
      })
    },
    async down(removeVolumes = false, opts: { quiet?: boolean } = {}) {
      const args = ['docker', ...baseArgs(), 'down']
      if (removeVolumes) {
        args.push('-v')
      }
      return runResult(cfg, runner, args, opts.quiet ? { capture: true } : {})
    },
    async exec(service: string, cmd: string[]) {
      return runResult(cfg, runner, ['docker', ...baseArgs(), 'exec', service, ...cmd], {
        tty: true,
      })
    },
    async run(service: string, cmd: string[]) {
      return runResult(
        cfg,
        runner,
        ['docker', ...baseArgs(), ...envArgs(), 'run', '--rm', service, ...cmd],
        { tty: true },
      )
    },
    async logs(service?: string, opts: { follow?: boolean; tail?: number } = {}) {
      const args = ['docker', ...baseArgs(), ...envArgs(), 'logs']
      if (opts.follow) {
        args.push('-f')
      }
      if (opts.tail && opts.tail > 0) {
        args.push('--tail', String(opts.tail))
      }
      if (service) {
        args.push(service)
      }
      return runResult(cfg, runner, args)
    },
    resolvedConfig() {
      return resolveComposeConfig(cfg, runner, [
        'docker',
        ...baseArgs(),
        ...envArgs(),
        'config',
        '--format',
        'json',
      ])
    },
    async ps() {
      return captureResult(cfg, runner, ['docker', ...baseArgs(), 'ps', '--format', 'json'])
    },
  }
}

/** Executes a Compose mutation or streaming command, retaining its exit diagnostics. */
async function runResult(
  cfg: ComposeConfig,
  runner: DockerExec,
  args: string[],
  opts: { env?: Record<string, string>; tty?: boolean; capture?: boolean } = {},
): Promise<InternalError | undefined> {
  try {
    const result = await runner(args, { cwd: cfg.dir, ...opts })
    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout
      return new InternalError(`${args.slice(0, 4).join(' ')} exited ${result.exitCode}: ${detail}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`${args.slice(0, 4).join(' ')} failed: ${message}`, { cause: error })
  }
}

/** Captures Compose status output, preserving its stderr-only failure diagnostics. */
async function captureResult(
  cfg: ComposeConfig,
  runner: DockerExec,
  args: string[],
): Promise<ExecResult | InternalError> {
  try {
    const result = await runner(args, { cwd: cfg.dir, capture: true })
    if (result.exitCode !== 0) {
      return new InternalError(
        `${args.slice(0, 4).join(' ')} exited ${result.exitCode}: ${result.stderr}`,
      )
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new InternalError(`${args.slice(0, 4).join(' ')} failed: ${message}`, { cause: error })
  }
}

/** Owns the Compose model inspection command and response validation. */
async function resolveComposeConfig(
  cfg: ComposeConfig,
  runner: DockerExec,
  args: string[],
): Promise<Record<string, unknown> | InternalError> {
  const result = await captureResult(cfg, runner, args)
  if (result instanceof Error) {
    return result
  }
  try {
    const model: unknown = JSON.parse(result.stdout)
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      return new InternalError('docker compose config returned an invalid model')
    }
    return model as Record<string, unknown>
  } catch (error) {
    return new InternalError('docker compose config returned invalid JSON', { cause: error })
  }
}
