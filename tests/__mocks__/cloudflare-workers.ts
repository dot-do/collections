/**
 * Mock for cloudflare:workers module for unit testing
 */

export class DurableObject<T = unknown> {
  ctx: any
  env: T

  constructor(ctx: any, env: T) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkerEntrypoint<T = unknown> {
  ctx: any
  env: T

  constructor(ctx: any, env: T) {
    this.ctx = ctx
    this.env = env
  }
}
