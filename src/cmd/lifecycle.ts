import { configLoadContext } from '@jib/config'
import { deployRebuildApp, deployRestartApp, deployStartApp, deployStopApp } from '@jib/deploy'
import { consola } from 'consola'
import type { CommandModule } from 'yargs'
import { cmdCreateHandler } from './handler.ts'

const lifecycleCommands = [
  {
    command: 'start <app>',
    run: deployStartApp,
    aliases: ['up'],
    describe: 'Start containers and reconcile ingress with current config; no sync or rebuild',
    success: 'started',
  },
  {
    command: 'stop <app>',
    run: deployStopApp,
    aliases: ['down'],
    describe: 'Stop and remove containers, preserving app config and persistent data',
    success: 'stopped',
  },
  {
    command: 'restart <app>',
    run: deployRestartApp,
    aliases: [],
    describe: 'Recreate containers and reconcile ingress with current config; no sync or rebuild',
    success: 'restarted',
  },
  {
    command: 'rebuild <app>',
    run: deployRebuildApp,
    aliases: [],
    describe: 'Build from the local checkout, recreate containers, and reconcile ingress; no sync',
    success: 'rebuilt',
  },
]

export default lifecycleCommands.map(
  ({ run, success, ...command }) =>
    ({
      ...command,
      handler: cmdCreateHandler<{ app: string }>(async (args) => {
        const app = String(args.app)
        const ctx = await configLoadContext()
        if (ctx instanceof Error) {
          return ctx
        }
        const error = await run(ctx, app)
        if (error) {
          return error
        }
        consola.success(`${success} ${app}`)
      }),
    }) satisfies CommandModule<Record<string, unknown>, { app: string }>,
)
