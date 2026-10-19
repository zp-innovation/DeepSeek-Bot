import { createElement as h, useEffect, useState } from 'react'
import { PlusIcon, TrashIcon } from './icons.js'
import { t } from './i18n.js'

let inputId = 0
const nextInput = (input = {}) => ({
  uid: `recipe-input-${++inputId}`,
  name: input.name ?? '',
  description: input.description ?? '',
  required: input.required !== false,
  default: input.default ?? '',
})
const blank = () => ({
  name: '',
  description: '',
  template: '',
  inputs: [],
  originalName: undefined,
})

function TextField({ label, value, onChange, multiline = false, disabled = false, placeholder }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t(label))),
    h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'bt-input bt-input-area' : 'bt-input',
      value,
      disabled,
      maxLength: label === 'Name' ? 32 : undefined,
      placeholder,
      spellCheck: false,
      onChange: event => onChange(event.target.value),
    }))
}

function InputEditor({ inputs, setInputs }) {
  const update = (uid, patch) => setInputs(items => items.map(item => item.uid === uid ? { ...item, ...patch } : item))
  return h('div', { className: 'bt-recipe-inputs' },
    h('div', { className: 'bt-recipe-inputs-head' },
      h('span', null, t('Inputs')),
      h('span', { className: 'bt-set-hint' }, t('Use {{name}} in the template.'))),
    inputs.map((input, index) => h('div', { key: input.uid, className: 'bt-recipe-input-row' },
      h('input', {
        className: 'bt-input',
        value: input.name,
        maxLength: 32,
        'aria-label': t('Input name {count}', { count: index + 1 }),
        placeholder: t('Input name'),
        spellCheck: false,
        onChange: event => update(input.uid, { name: event.target.value }),
      }),
      h('input', {
        className: 'bt-input',
        value: input.description,
        maxLength: 500,
        'aria-label': t('Input description {count}', { count: index + 1 }),
        placeholder: t('Description'),
        onChange: event => update(input.uid, { description: event.target.value }),
      }),
      h('input', {
        className: 'bt-input',
        value: input.default,
        maxLength: 4000,
        'aria-label': t('Input default {count}', { count: index + 1 }),
        placeholder: t('Default'),
        onChange: event => update(input.uid, { default: event.target.value }),
      }),
      h('label', { className: 'bt-check bt-recipe-required' },
        h('input', {
          type: 'checkbox',
          checked: input.required,
          onChange: event => update(input.uid, { required: event.target.checked }),
        }),
        h('span', null, t('Required'))),
      h('button', {
        type: 'button',
        className: 'bt-icon-btn bt-recipe-remove',
        title: t('Remove input'),
        'aria-label': t('Remove input {count}', { count: index + 1 }),
        onClick: () => setInputs(items => items.filter(item => item.uid !== input.uid)),
      }, h(TrashIcon)))),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm bt-with-icon',
      disabled: inputs.length >= 20,
      onClick: () => setInputs(items => [...items, nextInput()]),
    }, h(PlusIcon), t('Add input')))
}

function RecipeForm({ draft, setDraft, actions, onClose }) {
  const [error, setError] = useState('')
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const setInputs = update => setDraft(previous => ({
    ...previous,
    inputs: typeof update === 'function' ? update(previous.inputs) : update,
  }))
  const submit = async event => {
    event.preventDefault()
    setError('')
    try {
      await actions.saveRecipe({
        name: draft.name.trim(),
        description: draft.description,
        template: draft.template,
        inputs: draft.inputs.map(input => ({
          name: input.name.trim(),
          ...(input.description.trim() === '' ? {} : { description: input.description }),
          required: input.required,
          ...(input.default === '' ? {} : { default: input.default }),
        })),
      })
      onClose()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  return h('form', { className: 'bt-connector-form bt-recipe-form', onSubmit: submit },
    h(TextField, { label: 'Name', value: draft.name, disabled: draft.originalName !== undefined, onChange: value => set('name', value), placeholder: 'review-change' }),
    h(TextField, { label: 'Description', value: draft.description, onChange: value => set('description', value) }),
    h(TextField, {
      label: 'Recipe instructions',
      value: draft.template,
      onChange: value => set('template', value),
      multiline: true,
      placeholder: t('Review {{path}} for {{goal}}.'),
    }),
    h(InputEditor, { inputs: draft.inputs, setInputs }),
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm' }, draft.originalName ? t('Save changes') : t('Add recipe'))))
}

function RecipeRow({ item, onEdit, onDelete, confirming }) {
  const inputs = (item.inputs ?? []).map(input => `${input.name}${input.required ? '' : '?'}`).join(', ')
  return h('div', { className: 'bt-connector' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, `${item.name} · v${item.revision ?? 1}`),
        h('span', { className: 'bt-connector-status' },
          [item.description, inputs ? t('Inputs: {inputs}', { inputs }) : t('No inputs')].filter(Boolean).join(' · '))),
      h('span', { className: 'bt-connector-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onEdit }, t('Edit')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDelete }, confirming ? t('Click again to delete.') : t('Delete')))))
}

export function RecipesPage({ roster, actions, run }) {
  const items = [...(roster.recipes ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [draft, setDraft] = useState(null)
  const [confirming, setConfirming] = useState('')
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const edit = item => setDraft({
    ...blank(),
    ...item,
    originalName: item.name,
    inputs: (item.inputs ?? []).map(nextInput),
  })
  const remove = item => {
    if (confirming !== item.name) { setConfirming(item.name); return }
    setConfirming('')
    void run(actions.deleteRecipe(item.name))
  }
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Recipes')),
    h('div', { className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setDraft(blank()) }, h(PlusIcon), t('Add recipe'))),
    draft ? h(RecipeForm, { draft, setDraft, actions, onClose: () => setDraft(null) }) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      items.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No recipes saved')))
        : items.map(item => h(RecipeRow, {
          key: item.name,
          item,
          confirming: confirming === item.name,
          onEdit: () => edit(item),
          onDelete: () => remove(item),
        }))))
}

export function BotRecipesCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const items = [...(roster.recipes ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  if (items.length === 0) return null
  const attached = new Set(bot.recipes ?? [])
  return h(Card, { title: t('Recipes') },
    items.map(item => h(SwitchRow, {
      key: item.name,
      label: item.name,
      hint: item.description || undefined,
      on: attached.has(item.name),
      onChange: enabled => void run(actions.setBotRecipe(bot.id, item.name, enabled)),
    })))
}
