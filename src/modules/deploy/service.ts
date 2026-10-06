import type { Config } from '@jib/config'
import { dockerComposeFor } from '@jib/docker'
import { InternalError, type JibError, NotFoundError, errorsToJibError } from '@jib/errors'
import { type Paths, pathsRepoPath } from '@jib/paths'
import { stateAcquireLock, stateRecordFailure } from '@jib/state'
import { reconcileApp } from '@/flows/reconcile/app.ts'
import { deployRunFlow } from './flow.ts'
import { deployLinkSecrets, deploySyncOverride } from './support.ts'
import type { DeployCmd, DeployDeps, DeployResult, DeployProgress } from './types.ts'

export { MIN_DISK_BYTES } from './types.ts'
export type { DeployCmd, DeployDeps, DeployResult, DeployProgress } from './types.ts'

/** Runs the full deploy flow for one prepared app workdir and records deploy state updates. */
export async function deployApp(
  deps: DeployDeps,
  cmd: DeployCmd,
  emit: DeployProgress,
): Promise<JibError | DeployResult> {
  const appCfg = deps.config.apps[cmd.app]
  if (!appCfg) {
    return new NotFoundError(`app "${cmd.app}" not found in config`)
  }

  emit('lock', `acquiring lock for ${cmd.app}`)
  const release = await stateAcquireLock(deps.paths.locksDir, cmd.app, { blocking: false })
  if (release instanceof Error) {
    return new InternalError(`acquire lock for ${cmd.app}: ${release.message}`, { cause: release })
  }

  const result = await deployRunFlow(deps, cmd, emit)
  if (result instanceof Error) {
    deps.log.error(`deploy ${cmd.app} failed: ${result.message}`)
    const recordFailureError = await stateRecordFailure(deps.stateDir, cmd.app, result.message)
    if (recordFailureError) {
      deps.log.error(`deploy ${cmd.app} failure state update failed: ${recordFailureError.message}`)
    }
  }

  try {
    await release()
  } catch (error) {
    const cause = errorsToJibError(error)
    const releaseError = new InternalError(`release lock for ${cmd.app}: ${cause.message}`, {
      cause,
    })
    if (!(result instanceof Error)) {
      return releaseError
    }
    deps.log.error(`deploy ${cmd.app} lock release failed: ${releaseError.message}`)
  }
  return result
}

type AppContext = { cfg: Config; paths: Paths }

/** Starts containers with current env/config without syncing source or rebuilding. */
export function deployStartApp(ctx: AppContext, app: string): Promise<JibError | undefined> {
  return withAppCompose(ctx, app, 'start')
}

/** Recreates containers to apply env/config changes, just like starting them. */
export function deployRestartApp(ctx: AppContext, app: string): Promise<JibError | undefined> {
  return deployStartApp(ctx, app)
}

/** Stops containers while retaining persistent data and app configuration. */
export function deployStopApp(ctx: AppContext, app: string): Promise<JibError | undefined> {
  return withAppCompose(ctx, app, 'stop')
}

/** Builds from the local checkout, then recreates containers without syncing source. */
export function deployRebuildApp(ctx: AppContext, app: string): Promise<JibError | undefined> {
  return withAppCompose(ctx, app, 'rebuild')
}

/** Owns Compose preparation and keeps the app lock held until the operation completes. */
async function withAppCompose(
  ctx: AppContext,
  app: string,
  operation: 'start' | 'stop' | 'rebuild',
): Promise<JibError | undefined> {
  const appCfg = ctx.cfg.apps[app]
  if (!appCfg) {
    return new NotFoundError(`app "${app}" not found in config`)
  }
  try {
    const release = await stateAcquireLock(ctx.paths.locksDir, app, { blocking: false })
    if (release instanceof Error) {
      return release
    }
    try {
      const workdir = pathsRepoPath(ctx.paths, app, appCfg.repo)
      if (operation !== 'stop') {
        return await reconcileApp(ctx, { app, workdir, rebuild: operation === 'rebuild' })
      }
      const overrideError = await deploySyncOverride(ctx.paths, app, appCfg, workdir)
      if (overrideError) {
        return overrideError
      }
      const secretsError = await deployLinkSecrets(ctx.paths, app, workdir)
      if (secretsError) {
        return secretsError
      }
      const compose = dockerComposeFor(ctx.cfg, ctx.paths, app, { workdir })
      if (compose instanceof Error) {
        return compose
      }
      return await compose.down(false)
    } finally {
      await release()
    }
  } catch (error) {
    return errorsToJibError(error)
  }
}
