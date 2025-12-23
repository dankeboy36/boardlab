import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SketchFolder } from 'vscode-arduino-api'
import { isMap, parse, parseDocument, stringify } from 'yaml'

import type { Profile, Profiles } from './types'

type SketchPathLike = SketchFolder | string

export async function readProfiles(
  sketch: SketchPathLike,
  createIfAbsent = false
): Promise<Profiles> {
  const sketchPath = typeof sketch === 'string' ? sketch : sketch.sketchPath
  const sketchYamlPath = path.join(sketchPath, 'sketch.yaml')
  const flag = createIfAbsent ? 'a+' : 'r'
  const content = await fs.readFile(sketchYamlPath, { encoding: 'utf8', flag })
  return parse(content) ?? {}
}

// TODO: it should be possible to update the file instead of rewriting it
// https://stackoverflow.com/a/60891175/23163794
// https://eemeli.org/yaml/#collections
export async function writeProfiles(
  sketch: SketchPathLike,
  profiles: Profiles
): Promise<void> {
  const sketchPath = typeof sketch === 'string' ? sketch : sketch.sketchPath
  const sketchYamlPath = path.join(sketchPath, 'sketch.yaml')
  const content = stringify(profiles)
  await fs.writeFile(sketchYamlPath, content, { encoding: 'utf8' })
}

export async function updateProfile(
  sketch: SketchPathLike,
  profileName: string,
  newProfile: Partial<Profile>
): Promise<void> {
  const sketchPath = typeof sketch === 'string' ? sketch : sketch.sketchPath
  const sketchYamlPath = path.join(sketchPath, 'sketch.yaml')
  const content = await fs.readFile(sketchYamlPath, { encoding: 'utf8' })
  const doc = parseDocument(content)
  let profilesNode = doc.get('profiles')
  if (!profilesNode) {
    profilesNode = doc.createNode<Profiles>({})
    doc.add(profilesNode)
  }
  if (!isMap(profilesNode)) {
    throw new Error('expected a map')
  }
  let profileNode = profilesNode.get(profileName)
  if (!profileNode) {
    profileNode = doc.createNode({})
    profilesNode.add(profileNode as any)
  }
  if (!isMap(profileNode)) {
    throw new Error('expected a map')
  }
  const scalarProperties: (keyof Pick<Profile, 'fqbn' | 'notes'>)[] = [
    'fqbn',
    'notes',
  ]
  for (const property of scalarProperties) {
    const newValue = newProfile[property]
    const propertyNode = profileNode.get(property)
    if (!propertyNode && newValue) {
      profileNode.add({ key: property, value: newValue })
    } else if (typeof propertyNode === 'string') {
      if (propertyNode === newValue) {
        // noop
      } else if (newValue) {
        profileNode.set(property, newValue)
      }
    }
  }
  await fs.writeFile(sketchYamlPath, String(doc), { encoding: 'utf8' })
}

export async function readProfile(
  sketch: SketchPathLike,
  profileName = '.default',
  createIfAbsent = false
): Promise<Partial<Profile>> {
  const profiles = (await readProfiles(sketch, createIfAbsent)) ?? {
    profiles: [],
  }
  const profile = profiles.profiles?.[profileName]
  if (!profile && !createIfAbsent) {
    throw new Error(`Profile ${profileName} not found`)
  }
  return profile ?? {}
}
