import { describe, expect, it } from 'vitest'
import { parseFrontmatter, parseSkillManifest, skillMetaFrom } from '../src/skills'

describe('Toolbox skill helpers', () => {
  it('parses front-matter and body', () => {
    const { meta, body } = parseFrontmatter('---\nname: Quiz\ndescription: Run a quiz\n---\nDo the thing.')
    expect(meta).toEqual({ name: 'Quiz', description: 'Run a quiz' })
    expect(body.trim()).toBe('Do the thing.')
  })

  it('tolerates a file with no front-matter', () => {
    const { meta, body } = parseFrontmatter('no front matter here')
    expect(meta).toEqual({})
    expect(body).toBe('no front matter here')
  })

  it('builds a SkillMeta, falling back to the folder id for a missing name', () => {
    expect(skillMetaFrom('MARKITDOWN', '---\ndescription: Convert files\n---\nbody')).toEqual({
      id: 'MARKITDOWN',
      name: 'MARKITDOWN',
      description: 'Convert files'
    })
  })

  it('parses a runnable skill.json, and returns null for a runless/malformed one', () => {
    expect(parseSkillManifest('{ "run": { "runnable": "markitdown", "argsFrom": ["path"] } }')).toEqual({
      runnable: 'markitdown',
      argsFrom: ['path']
    })
    expect(parseSkillManifest('{ "description": "no run" }')).toBeNull()
    expect(parseSkillManifest('not json')).toBeNull()
  })
})
