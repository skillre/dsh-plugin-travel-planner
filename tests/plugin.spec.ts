import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('@skillre/dsh-plugin-travel-planner', () => {
  it('exports the minimal Cordis function-plugin contract', () => {
    expect(plugin.name).toBe('skillre-travel-planner')
    expect(plugin.apply).toBeTypeOf('function')
    expect('default' in plugin).toBe(false)
  })

  it('writes Trip Projects at the current schema version', () => {
    expect(plugin.CURRENT_TRIP_SCHEMA_VERSION).toBe(2)
  })
})
