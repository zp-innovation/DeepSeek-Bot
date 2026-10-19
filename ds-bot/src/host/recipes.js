// Shared task recipes: reusable instructions with typed inputs. Running a recipe
// expands parameters into model instructions; it never executes code or grants extra
// permissions beyond the Bot's existing shell, sandbox, approval and Git boundaries.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const INPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/
const MAX_INPUTS = 20
const MAX_DESCRIPTION = 2_000
const MAX_INPUT_DESCRIPTION = 500
const MAX_TEMPLATE = 30_000
const MAX_DEFAULT = 4_000
const MAX_VALUE = 20_000
const MAX_RENDERED = 40_000

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, label, max, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const clean = value.trim()
  if (required && clean === '') throw new Error(`${label} is required.`)
  if (clean.length > max) throw new Error(`${label} is longer than ${max} characters.`)
  return clean
}

export function validateRecipeName(value) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name)) {
    throw new Error('Use a recipe name with lowercase letters, digits, and single hyphens.')
  }
  return name
}

export function parseRecipeInputs(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Recipe inputs must be a list.')
  if (value.length > MAX_INPUTS) throw new Error(`A recipe can have at most ${MAX_INPUTS} inputs.`)
  const names = new Set()
  return value.map((item, index) => {
    if (!plainObject(item)) throw new Error(`Recipe input ${index + 1} must be an object.`)
    const name = String(item.name ?? '').trim()
    if (!INPUT_NAME.test(name)) throw new Error(`Recipe input "${name || index + 1}" needs lowercase letters, digits, and underscores.`)
    if (names.has(name)) throw new Error(`Recipe input "${name}" appears more than once.`)
    names.add(name)
    const description = text(item.description, `Recipe input "${name}" description`, MAX_INPUT_DESCRIPTION)
    const fallback = item.default === undefined || item.default === null
      ? undefined
      : typeof item.default === 'string' || typeof item.default === 'number' || typeof item.default === 'boolean'
        ? String(item.default)
        : undefined
    if (item.default !== undefined && item.default !== null && fallback === undefined) {
      throw new Error(`Recipe input "${name}" default must be text, a number, or true/false.`)
    }
    if (fallback !== undefined && fallback.length > MAX_DEFAULT) throw new Error(`Recipe input "${name}" default is too long.`)
    return {
      name,
      ...(description === undefined ? {} : { description }),
      required: item.required !== false,
      ...(fallback === undefined ? {} : { default: fallback }),
    }
  })
}

const placeholders = (template, inputs) => {
  const known = new Set(inputs.map(input => input.name))
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = match[1].trim()
    if (!INPUT_NAME.test(name)) throw new Error(`Template placeholder "{{${match[1]}}}" is not a valid input name.`)
    if (!known.has(name)) throw new Error(`Template placeholder "{{${name}}}" has no matching input.`)
  }
  const rest = template.replace(/\{\{[^{}]*\}\}/g, '')
  if (rest.includes('{{') || rest.includes('}}')) throw new Error('Recipe template has an unclosed placeholder.')
  return template
}

export function renderRecipe(recipe, values = {}) {
  if (!plainObject(values)) throw new Error('Recipe values must be an object.')
  const inputs = parseRecipeInputs(recipe.inputs)
  const known = new Set(inputs.map(input => input.name))
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`Unknown recipe input "${key}".`)
  }
  let total = 0
  const renderedValues = {}
  for (const input of inputs) {
    const raw = values[input.name]
    if (raw !== undefined && raw !== null
      && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw new Error(`Recipe input "${input.name}" must be text, a number, or true/false.`)
    }
    const value = raw === undefined || raw === null ? input.default : String(raw)
    if (value === undefined && input.required) throw new Error(`Missing recipe input: ${input.name}`)
    const final = value ?? ''
    if (final.length > MAX_VALUE) throw new Error(`Recipe input "${input.name}" is too long.`)
    total += final.length
    if (total > MAX_RENDERED) throw new Error(`Recipe input values are longer than ${MAX_RENDERED} characters in total.`)
    renderedValues[input.name] = final
  }
  const body = String(recipe.template ?? '').replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_match, name) => renderedValues[name])
  const parameterLines = inputs.map(input => `- ${input.name}: ${renderedValues[input.name]}`)
  return [
    `<recipe_content name="${recipe.name}" revision="${recipe.revision ?? 1}">`,
    '<recipe_parameters>',
    ...(parameterLines.length === 0 ? ['(none)'] : parameterLines),
    '</recipe_parameters>',
    '<recipe_instructions>',
    body,
    '</recipe_instructions>',
    '</recipe_content>',
  ].join('\n')
}

export function install(rt) {
  const { ctx, state } = rt

  const library = () => state.recipes.items
  const ensureLibrary = () => {
    state.recipes ??= { items: {} }
    state.recipes.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && (bot.recipes ?? []).includes(name))
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw new Error(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) {
      throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
    }
  }
  const itemInput = (body, { botId, ui }) => {
    const name = validateRecipeName(body.name)
    const items = ensureLibrary()
    const previous = items[name]
    if (previous && !ui) editCheck(previous, botId, 'change')
    const template = text(body.template, 'Recipe template', MAX_TEMPLATE, { required: true })
    const inputs = parseRecipeInputs(body.inputs)
    placeholders(template, inputs)
    const now = Date.now()
    const content = {
      description: text(body.description, 'Recipe description', MAX_DESCRIPTION) ?? '',
      inputs,
      template,
    }
    const changed = previous === undefined || previous.description !== content.description
      || previous.template !== content.template
      || JSON.stringify(previous.inputs ?? []) !== JSON.stringify(content.inputs)
    return {
      name,
      ...content,
      revision: previous === undefined ? 1 : changed ? (previous.revision ?? 1) + 1 : previous.revision ?? 1,
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  }
  const recipeSave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    ensureLibrary()[item.name] = item
    await rt.save()
    return item
  }
  const recipeDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = items[String(name ?? '').trim()]
    if (!item) throw new Error(`No recipe named ${name}.`)
    if (!ui) editCheck(item, botId, 'delete')
    delete items[item.name]
    for (const bot of Object.values(state.bots)) bot.recipes = (bot.recipes ?? []).filter(attached => attached !== item.name)
    await rt.save()
    return true
  }
  const setAttached = async (bot, name, attached) => {
    bot.recipes ??= []
    if (attached && !bot.recipes.includes(name)) bot.recipes.push(name)
    if (!attached) bot.recipes = bot.recipes.filter(entry => entry !== name)
    await rt.save()
    return bot.recipes
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change recipes.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s recipes.')
    const item = ensureLibrary()[String(name ?? '').trim()]
    if (!item) throw new Error(`No recipe named ${name}.`)
    await setAttached(target, item.name, endpoint === 'attach')
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    inputs: (item.inputs ?? []).map(input => ({ ...input })),
  }))

  async function recipeEndpoint(endpoint, body = {}) {
    if (endpoint === 'recipe-save') return recipeSave(body, { ui: true })
    if (endpoint === 'recipe-delete') return recipeDelete(body.name, { ui: true })
    if (endpoint === 'bot-recipe') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      const name = String(body.name ?? '')
      if (!library()[name]) throw new Error(`No recipe named ${name}.`)
      return setAttached(bot, name, body.attached === true)
    }
    throw new Error('Unknown recipe operation.')
  }

  const callerBot = exec => rt.botOf(rt.selfOf(exec.agent?.id))
  ctx.tools.register(defineTool({
    name: 'recipe_list',
    description: 'List shared task recipes and show which ones are attached to you. Read-only.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      if (!bot) return 'Only Bots on the team can use recipe_list.'
      const items = Object.values(ensureLibrary())
      if (items.length === 0) return 'No shared recipes are saved yet.'
      return [
        'Shared recipes:',
        ...items.map(item => {
          const attached = (bot.recipes ?? []).includes(item.name)
          const inputs = (item.inputs ?? []).map(input => `${input.name}${input.required ? '' : '?'}`).join(', ') || 'none'
          return `- ${item.name} (revision ${item.revision ?? 1}); ${attached ? 'attached to you' : 'not attached'}${item.description ? ` — ${item.description}` : ''}\n  inputs: ${inputs}`
        }),
      ].join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'recipe_run',
    description: 'Expand an attached shared recipe with concrete input values. This returns instructions to follow; it does not execute code or grant permissions.',
    parameters: {
      name: { type: 'string', required: true, description: 'Recipe name from recipe_list' },
      values: { type: 'object', additionalProperties: true, description: 'Input values keyed by recipe input name' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      if (!bot) return 'Only Bots on the team can use recipe_run.'
      const item = ensureLibrary()[String(args.name ?? '').trim()]
      if (!item) return `No recipe named ${args.name}.`
      if (!(bot.recipes ?? []).includes(item.name)) return `Recipe ${item.name} is not attached to you. Ask the user or a Main Bot to attach it.`
      try { return renderRecipe(item, args.values ?? {}) } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'save_recipe',
    description: 'Create or update a shared task recipe with optional inputs. Recipes provide reusable instructions only.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase letters, digits, and single hyphens, up to 32 characters' },
      description: { type: 'string', description: 'What this recipe is for' },
      template: { type: 'string', required: true, description: `Instructions, up to ${MAX_TEMPLATE} characters; use {{input_name}} placeholders` },
      inputs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Lowercase letters, digits, and underscores' },
            description: { type: 'string', description: 'What value to provide' },
            required: { type: 'boolean', description: 'Defaults to true' },
            default: { type: 'string', description: 'Optional default value' },
          },
        },
        description: `At most ${MAX_INPUTS} inputs`,
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use save_recipe.'
      try {
        const item = await recipeSave(args, { botId: self })
        return `Saved recipe ${item.name} (revision ${item.revision}). Attached Bots use it from their next message.`
      } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'delete_recipe',
    description: 'Remove a shared recipe and detach it from every Bot.',
    parameters: { name: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use delete_recipe.'
      try {
        await recipeDelete(args.name, { botId: self })
        return `Deleted recipe ${args.name} and detached it from every Bot.`
      } catch (error) { return error.message }
    },
  }))
  for (const [name, endpoint, verb] of [['attach_recipe', 'attach', 'Attached'], ['detach_recipe', 'detach', 'Detached']]) {
    ctx.tools.register(defineTool({
      name,
      description: `${verb} a shared recipe to yourself, or to another Bot if you are a Main Bot.`,
      parameters: {
        name: { type: 'string', required: true, description: 'Recipe name from recipe_list' },
        bot: { type: 'string', description: 'Optional Bot name; only a Main Bot may change another Bot' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`
        try {
          const result = await changeAttachment(endpoint, args, self)
          return `${verb} ${args.name} ${args.bot ? `to ${result.bot}` : 'to yourself'}.`
        } catch (error) { return error.message }
      },
    }))
  }

  ctx.systemPrompt.section({
    name: 'bot-recipes',
    order: 647,
    text: context => rt.selfOf(context?.agent?.id) === undefined ? '' : [
      '# Skills and recipes',
      '- Shared skills attached to this Bot appear in the DSH skill catalog. Use the skill tool or a user /name invocation when it matches the task.',
      '- recipe_list shows shared recipes. recipe_run expands only a recipe attached to this Bot into instructions; it does not execute commands.',
      '- A recipe is guidance, not extra permission. Keep every shell, sandbox, approval, Git and data-access rule in force.',
    ].join('\n'),
  })

  Object.assign(rt, {
    recipeSave,
    recipeDelete,
    recipeEndpoint,
    recipeLibraryView: libraryView,
    changeRecipeAttachment: changeAttachment,
  })
}
