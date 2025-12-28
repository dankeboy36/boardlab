import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import temp from 'temp'

import {
  readProfiles,
  updateProfile,
  writeProfiles,
} from '../../profile/profiles'
import type { Profiles } from '../../profile/types'

describe('profiles', () => {
  describe('readProfile', function () {
    this.slow(250)

    let tracked: typeof temp
    let testDir: string

    before(() => (tracked = temp.track()))
    after(() => tracked.cleanupSync())
    beforeEach(() => (testDir = tracked.mkdirSync()))

    it('should create the profiles file if absent', async () => {
      const sketchYamlPath = path.join(testDir, 'sketch.yaml')
      await assert.rejects(fs.readFile(sketchYamlPath))

      const actual = await readProfiles(testDir, true)

      await assert.doesNotReject(fs.readFile(sketchYamlPath))
      assert.deepStrictEqual(actual, {})
    })

    it('should read the profiles file', async () => {
      const expected: Profiles = {
        profiles: {
          alma: {
            fqbn: 'a:b:c',
          },
        },
      }
      await writeProfiles(testDir, expected)
      const actual = await readProfiles(testDir, true)
      assert.deepStrictEqual(actual, expected)
    })

    it('should update the fqbn', async () => {
      await writeProfiles(testDir, {
        profiles: {
          alma: {
            fqbn: 'a:b:c',
          },
        },
      })

      await updateProfile(testDir, 'alma', { fqbn: 'x:y:z' })
      const profiles = await readProfiles(testDir, true)
      const actual = profiles.profiles?.['alma']
      assert.deepStrictEqual(actual, { fqbn: 'x:y:z' })
    })

    it('should update the fqbn and keep the formatting and comments', async () => {
      const createProfiles = (fqbn: string) => `profiles:

  # a profile comment

  alma:
    fqbn: ${fqbn} # fqbn comment
`
      const yaml = createProfiles('a:b:c')
      const sketchYamlPath = path.join(testDir, 'sketch.yaml')
      await fs.writeFile(sketchYamlPath, yaml, { encoding: 'utf8' })
      let actual: unknown = await readProfiles(testDir, true)
      assert.deepStrictEqual(actual, {
        profiles: {
          alma: {
            fqbn: 'a:b:c',
          },
        },
      })

      await updateProfile(testDir, 'alma', { fqbn: 'x:y:z' })
      const profiles = await readProfiles(testDir, true)
      actual = profiles.profiles?.['alma']
      assert.deepStrictEqual(actual, { fqbn: 'x:y:z' })

      const expected = createProfiles('x:y:z')
      actual = await fs.readFile(sketchYamlPath, { encoding: 'utf8' })
      assert.strictEqual(expected, actual)
    })
  })
})
