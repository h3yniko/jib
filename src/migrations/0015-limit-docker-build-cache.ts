import { dockerConfigureBuildCacheResult } from '@jib/docker'
import { loggingCreateLogger } from '@jib/logging'
import type { JibMigration } from './types.ts'

export const m0015_limit_docker_build_cache: JibMigration = {
  id: '0015_limit_docker_build_cache',
  description: 'Limit Docker build cache GC based on Docker data filesystem capacity',
  async up() {
    const target = await dockerConfigureBuildCacheResult()
    if (target instanceof Error) {
      return target
    }
    if (target) {
      loggingCreateLogger('migrate').warn(
        `Docker build cache GC target set to ${target}. Restart Docker during a maintenance window to activate it (sudo systemctl restart docker); running containers may be interrupted.`,
      )
    }
  },
}
