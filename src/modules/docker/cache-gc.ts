import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { InternalError } from '@jib/errors'
import { $ } from '@/libs/shell'

const DOCKER_DAEMON_CONFIG = '/etc/docker/daemon.json'

interface DockerCacheDeps {
  daemonConfigPath?: string
  dockerRootDir?: () => Promise<string>
  filesystem?: (path: string) => Promise<{ blocks: number; bsize: number }>
}

interface DaemonGcConfig {
  config: Record<string, unknown>
  builder: Record<string, unknown>
  settings: Record<string, unknown>
  mode: number
}

/** Targets 10% of Docker's filesystem capacity, up to 20 GB (decimal units). */
export function dockerBuildCacheTarget(totalBytes: number): string | InternalError {
  if (!Number.isFinite(totalBytes) || totalBytes < 10_000_000) {
    return new InternalError('Docker data filesystem capacity is unavailable or too small')
  }
  const megabytes = Math.min(20_000, Math.floor(totalBytes / 10 / 1_000_000))
  return megabytes % 1_000 === 0 ? `${megabytes / 1_000}GB` : `${megabytes}MB`
}

/** Reads daemon config, preserving its permissions and any operator-owned GC settings. */
async function readDaemonGcConfig(
  path: string,
): Promise<DaemonGcConfig | InternalError | undefined> {
  let raw: string | undefined
  let mode = 0o644
  try {
    const file = await lstat(path)
    if (file.isSymbolicLink()) {
      return new InternalError(`refusing to replace symlink ${path}`)
    }
    mode = file.mode & 0o777
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (!(typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')) {
      return new InternalError(
        `read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      )
    }
  }

  let config: Record<string, unknown>
  try {
    const parsed: unknown = raw === undefined ? {} : JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new InternalError(`${path} must contain a JSON object`)
    }
    config = parsed as Record<string, unknown>
  } catch (error) {
    return new InternalError(
      `parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }

  const builder = config.builder === undefined ? {} : config.builder
  if (!builder || typeof builder !== 'object' || Array.isArray(builder)) {
    return new InternalError(`${path} builder must be a JSON object`)
  }
  const gc = (builder as Record<string, unknown>).gc
  const settingsValue = gc === undefined ? {} : gc
  if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) {
    return new InternalError(`${path} builder.gc must be a JSON object`)
  }
  const settings = settingsValue as Record<string, unknown>
  if ('enabled' in settings && typeof settings.enabled !== 'boolean') {
    return new InternalError(`${path} builder.gc.enabled must be a boolean`)
  }
  // Explicit settings are operator-owned; defaultKeepStorage does not control custom policies.
  if (settings.enabled === false || 'policy' in settings || 'defaultKeepStorage' in settings) {
    return undefined
  }
  return { config, builder: builder as Record<string, unknown>, settings, mode }
}

/** Reads the filesystem hosting Docker's data directory, not the host root or current free space. */
async function dockerCacheTargetForHost(deps: DockerCacheDeps): Promise<string | InternalError> {
  try {
    let root: string
    if (deps.dockerRootDir) {
      root = await deps.dockerRootDir()
    } else {
      const result = await $({ timeout: '5s' })`docker info --format ${'{{.DockerRootDir}}'}`
      if (result.exitCode !== 0) {
        return new InternalError(`docker info: ${result.stderr.trim() || 'command failed'}`)
      }
      root = result.stdout.trim()
    }
    if (!isAbsolute(root)) {
      return new InternalError(`Docker data directory is not an absolute path: ${root}`)
    }
    const space = await (deps.filesystem ?? statfs)(root)
    return dockerBuildCacheTarget(space.blocks * space.bsize)
  } catch (error) {
    return new InternalError(
      `read Docker data filesystem: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }
}

/** Adds Docker's default-builder GC target without overriding an administrator's GC policy. Returns the new target if written. */
export async function dockerConfigureBuildCacheResult(
  deps: DockerCacheDeps = {},
): Promise<string | InternalError | undefined> {
  const path = deps.daemonConfigPath ?? DOCKER_DAEMON_CONFIG
  const loaded = await readDaemonGcConfig(path)
  if (!loaded || loaded instanceof Error) {
    return loaded
  }
  const target = await dockerCacheTargetForHost(deps)
  if (target instanceof Error) {
    return target
  }
  loaded.config.builder = {
    ...loaded.builder,
    gc: {
      ...loaded.settings,
      enabled: loaded.settings.enabled ?? true,
      defaultKeepStorage: target,
    },
  }
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temp, `${JSON.stringify(loaded.config, null, 2)}\n`, { mode: loaded.mode })
    await rename(temp, path)
    return target
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    return new InternalError(
      `write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }
}
