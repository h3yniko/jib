import { join } from 'node:path'
import type { Config } from '@jib/config'
import { dockerAllHealthy, dockerCheckHealth, dockerComposeFor } from '@jib/docker'
import {
  InternalError,
  type JibError,
  NotFoundError,
  ValidationError,
  errorsToJibError,
} from '@jib/errors'
import { ingressClaim, ingressCreateOperator } from '@jib/ingress'
import type { Paths } from '@jib/paths'
import { type AppState, stateAcquireLock, stateLoad, stateSave } from '@jib/state'
import { deployLinkSecrets, deploySyncOverride } from '@/modules/deploy/support.ts'
import { ingressApplyNginxConfig } from '@/modules/ingress/backends/nginx/config.ts'
import { reconcileDesiredState } from './desired.ts'

interface ReconcileContext {
  cfg: Config
  paths: Paths
}
interface ReconcileInput {
  app: string
  workdir: string
  rebuild: boolean
  preDeploy?: boolean
  emit?: (step: string, message: string) => void
}

const defaultDeps = {
  syncOverride: deploySyncOverride,
  linkSecrets: deployLinkSecrets,
  composeFor: dockerComposeFor,
  load: stateLoad,
  save: stateSave,
  checkHealth: dockerCheckHealth,
  acquireLock: stateAcquireLock,
  applyGlobal: ingressApplyNginxConfig,
  createOperator: ingressCreateOperator,
  claim: ingressClaim,
}

/** Reconciles one app while its caller holds the app lock. */
export async function reconcileApp(
  ctx: ReconcileContext,
  input: ReconcileInput,
  deps = defaultDeps,
): Promise<JibError | undefined> {
  const appCfg = ctx.cfg.apps[input.app]
  if (!appCfg) {
    return new NotFoundError(`app "${input.app}" not found in config`)
  }
  const emit = input.emit ?? (() => {})
  try {
    const state = await deps.load(ctx.paths.stateDir, input.app)
    if (state instanceof Error) {
      return state
    }
    emit('override', 'preparing current compose configuration')
    const overrideError = await deps.syncOverride(ctx.paths, input.app, appCfg, input.workdir)
    if (overrideError) {
      return overrideError
    }
    const secretsError = await deps.linkSecrets(ctx.paths, input.app, input.workdir)
    if (secretsError) {
      return secretsError
    }
    const compose = deps.composeFor(ctx.cfg, ctx.paths, input.app, { workdir: input.workdir })
    if (compose instanceof Error) {
      return compose
    }
    const model = await compose.resolvedConfig()
    if (model instanceof Error) {
      return model
    }
    const desired = reconcileDesiredState(ctx, input.app, appCfg, model)
    if (desired instanceof Error) {
      return desired
    }
    const buildPending = desired.hasBuild && state.applied.build !== desired.build
    if (input.rebuild) {
      if (desired.hasBuild) {
        emit('build', `building ${input.app}`)
        const error = await compose.build()
        if (error) {
          return error
        }
      }
      state.applied.build = desired.build
      const error = await deps.save(ctx.paths.stateDir, input.app, state)
      if (error) {
        return error
      }
    }
    if (input.preDeploy) {
      for (const hook of appCfg.pre_deploy ?? []) {
        emit('pre_deploy', `running ${hook.service}`)
        const error = await compose.run(hook.service, [])
        if (error) {
          return error
        }
      }
    }
    emit(
      'up',
      state.applied.runtime === desired.runtime
        ? 'recreating containers'
        : 'applying changed container configuration',
    )
    const upError = await compose.up({ services: appCfg.services ?? [], noBuild: true })
    if (upError) {
      return upError
    }
    if (appCfg.health?.length) {
      emit('health', 'running health checks')
      const results = await deps.checkHealth(appCfg.health)
      if (!dockerAllHealthy(results)) {
        return new InternalError(`health check failed: ${JSON.stringify(results)}`)
      }
    }
    state.applied.runtime = desired.runtime
    const runtimeSaveError = await deps.save(ctx.paths.stateDir, input.app, state)
    if (runtimeSaveError) {
      return runtimeSaveError
    }
    const ingressError = await applyIngress(ctx, input, deps, {
      state,
      fingerprint: desired.ingress,
    })
    if (ingressError) {
      return ingressError
    }
    if (!input.rebuild && buildPending) {
      return new ValidationError(
        `runtime and ingress applied for ${input.app}, but build inputs changed or the previous build is unverified; run "jib rebuild ${input.app}" or "jib deploy ${input.app}"`,
      )
    }
  } catch (error) {
    return errorsToJibError(error)
  }
}

/** Serializes nginx validation and reload because they observe every app's routes. */
async function applyIngress(
  ctx: ReconcileContext,
  input: ReconcileInput,
  deps: typeof defaultDeps,
  applied: { state: AppState; fingerprint: string },
): Promise<JibError | undefined> {
  input.emit?.('ingress', 'reconciling current routes and global ingress settings')
  // nginx validation/reload observes every app, so serialize across app locks.
  const release = await deps.acquireLock(join(ctx.paths.locksDir, 'ingress'), 'global')
  if (release instanceof Error) {
    return release
  }
  try {
    const globalError = await deps.applyGlobal(ctx.paths, ctx.cfg)
    if (globalError) {
      return globalError
    }
    const error = await deps.claim(
      deps.createOperator(ctx.paths),
      input.app,
      ctx.cfg.apps[input.app]!,
    )
    if (error) {
      return error
    }
  } finally {
    await release()
  }
  applied.state.applied.ingress = applied.fingerprint
  return await deps.save(ctx.paths.stateDir, input.app, applied.state)
}
