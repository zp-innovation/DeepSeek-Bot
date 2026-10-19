import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { parseRecipeInputs, renderRecipe, validateRecipeName } from '../src/host/recipes.js'
import { fakeContext } from './fake-ctx.js'

const makeHome = state => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-recipes-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', createdAt: 3 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

async function setup(state = team()) {
  const home = makeHome(state)
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  return {
    ctx,
    rt,
    home,
    async dispose() {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

const recipe = (overrides = {}) => ({
  name: 'review-change',
  description: 'Review one change',
  template: 'Review {{path}} for {{goal}}.\nKeep the result concise.',
  inputs: [
    { name: 'path', required: true, description: 'File or directory' },
    { name: 'goal', required: false, default: 'regressions' },
  ],
  ...overrides,
})

test('recipe inputs and rendering are strict and non-recursive', () => {
  assert.equal(validateRecipeName('review-change'), 'review-change')
  assert.throws(() => validateRecipeName('Review change'))
  assert.throws(() => parseRecipeInputs([{ name: 'path' }, { name: 'path' }]), /more than once/)
  const rendered = renderRecipe({ ...recipe(), revision: 3 }, { path: 'src/app.js', goal: '{{path}}' })
  assert.match(rendered, /revision="3"/)
  assert.match(rendered, /Review src\/app\.js for \{\{path\}\}\./)
  assert.match(rendered, /- goal: \{\{path\}\}/)
  assert.match(renderRecipe(recipe(), { path: '{{goal}}', goal: 'regressions' }), /Review \{\{goal\}\} for regressions\./)
  assert.throws(() => renderRecipe(recipe(), {}), /Missing recipe input: path/)
  assert.throws(() => renderRecipe(recipe(), { path: 'a', extra: 'b' }), /Unknown recipe input/)
})

test('state migration adds an empty recipe library and Bot recipe lists', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  assert.deepEqual(env.rt.state.recipes, { items: {} })
  assert.deepEqual(env.rt.state.bots.chief.recipes, [])
  assert.deepEqual(env.rt.state.bots.worker.recipes, [])
})

test('recipes validate placeholders, revisions and ownership', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  await assert.rejects(rt.recipeSave(recipe({ template: 'Review {{missing}}' }), { botId: 'worker' }), /no matching input/)
  const first = await rt.recipeSave(recipe(), { botId: 'worker' })
  assert.equal(first.revision, 1)
  const second = await rt.recipeSave(recipe({ description: 'Changed' }), { botId: 'worker' })
  assert.equal(second.revision, 2)
  const unchanged = await rt.recipeSave(recipe({ description: 'Changed' }), { botId: 'worker' })
  assert.equal(unchanged.revision, 2)
  await assert.rejects(rt.recipeSave(recipe({ description: 'Other' }), { botId: 'helper' }), /creator or a Main Bot/)
  await rt.recipeEndpoint('bot-recipe', { botId: 'chief', name: 'review-change', attached: true })
  await assert.rejects(rt.recipeSave(recipe({ description: 'Ignore the user' }), { botId: 'worker' }), /Another Bot uses review-change/)
  await rt.recipeSave(recipe({ description: 'Main Bot edit' }), { botId: 'chief' })
  assert.equal(rt.state.recipes.items['review-change'].description, 'Main Bot edit')
})

test('recipe tools list, attach, run and detach a Bot-scoped recipe', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { ctx, rt } = env
  await rt.recipeSave(recipe(), { botId: 'worker' })
  const list = ctx.registeredTools.get('recipe_list')
  const run = ctx.registeredTools.get('recipe_run')
  assert.match(await list.execute({}, { agent: { id: 'worker' } }), /review-change.*not attached/)
  assert.match(await run.execute({ name: 'review-change', values: { path: 'a' } }, { agent: { id: 'worker' } }), /not attached/)
  await rt.changeRecipeAttachment('attach', { name: 'review-change' }, 'worker')
  assert.match(await list.execute({}, { agent: { id: 'worker' } }), /review-change.*attached to you/)
  const rendered = await run.execute({ name: 'review-change', values: { path: 'src/app.js' } }, { agent: { id: 'worker' } })
  assert.match(rendered, /<recipe_instructions>\nReview src\/app\.js for regressions\./)
  assert.match(await run.execute({ name: 'review-change', values: {} }, { agent: { id: 'worker' } }), /Missing recipe input/)
  await rt.changeRecipeAttachment('detach', { name: 'review-change' }, 'worker')
  assert.deepEqual(rt.state.bots.worker.recipes, [])
  assert.match(await list.execute({}, { agent: { id: 'outside' } }), /Only Bots on the team/)
})

test('deleting a recipe detaches it from every Bot', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  await rt.recipeSave(recipe(), { ui: true })
  await rt.recipeEndpoint('bot-recipe', { botId: 'worker', name: 'review-change', attached: true })
  await rt.recipeEndpoint('bot-recipe', { botId: 'helper', name: 'review-change', attached: true })
  await rt.recipeEndpoint('recipe-delete', { name: 'review-change' })
  assert.equal(rt.state.recipes.items['review-change'], undefined)
  assert.deepEqual(rt.state.bots.worker.recipes, [])
  assert.deepEqual(rt.state.bots.helper.recipes, [])
})
