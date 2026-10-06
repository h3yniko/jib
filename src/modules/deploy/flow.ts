import { InternalError, type JibError, errorsToJibError } from '@jib/errors'
import { type AppState, stateLoad, stateSave } from '@jib/state'
import { reconcileApp } from '@/flows/reconcile/app.ts'
import { deployReadDiskFree } from './support.ts'
import type { DeployCmd, DeployDeps, DeployResult, DeployProgress } from './types.ts'
import { MIN_DISK_BYTES } from './types.ts'

/** Executes the deploy steps after the app config has already been resolved. */
export async function deployRunFlow(
  deps: DeployDeps,
  cmd: DeployCmd,
  emit: DeployProgress,
): Promise<JibError | DeployResult> {
  const start = Date.now()

  emit('disk', 'checking disk space')
  const free = await deployReadDiskFree(cmd.workdir)
  if (free instanceof Error) {
    return free
  }
  if (free < MIN_DISK_BYTES) {
    return new InternalError(`insufficient disk space: ${free} bytes free`)
  }

  try {
    const error = await reconcileApp(
      { cfg: deps.config, paths: deps.paths },
      { app: cmd.app, workdir: cmd.workdir, rebuild: true, preDeploy: true, emit },
    )
    if (error) {
      return error
    }
    // Reconciliation records each completed stage; preserve those records.
    const appliedState = await stateLoad(deps.stateDir, cmd.app)
    if (appliedState instanceof Error) {
      return appliedState
    }
    const next: AppState = {
      ...appliedState,
      app: cmd.app,
      deployed_sha: cmd.sha,
      deployed_workdir: cmd.workdir,
      last_deploy: new Date().toISOString(),
      last_deploy_status: 'success',
      last_deploy_error: '',
    }
    emit('state', 'recording deployment')
    const saveError = await stateSave(deps.stateDir, cmd.app, next)
    if (saveError) {
      return saveError
    }
    return { deployedSHA: cmd.sha, durationMs: Date.now() - start }
  } catch (error) {
    return errorsToJibError(error)
  }
}
