import { createElement as h } from 'react'
import { t } from './i18n.js'

const stateLabel = entry => {
  if (!entry.enabled) return t('Disabled')
  if (entry.phase === 'failed') return t('Failed')
  if (entry.phase === 'active') return t('Active')
  if (entry.phase === 'loading' || entry.phase === 'pending' || entry.phase === 'unloading') return t('Loading…')
  return t('Not running')
}

function PluginRow({ entry }) {
  return h('div', { className: 'bt-connector', 'data-state': entry.phase === 'failed' ? 'error' : undefined },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, entry.name),
        h('span', { className: 'bt-connector-status' }, entry.description || entry.moduleName || t('No description'))),
      h('span', { className: 'bt-plugin-tags' },
        h('span', { className: 'bt-tag' }, stateLabel(entry)),
        entry.readOnly ? h('span', { className: 'bt-tag' }, t('Read-only')) : null)))
}

function BundleRow({ bundle }) {
  return h('div', { className: 'bt-connector' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, [bundle.name, bundle.version].filter(Boolean).join(' · ')),
        h('span', { className: 'bt-connector-status' }, bundle.description || bundle.packageName || t('No description'))),
      h('span', { className: 'bt-plugin-tags' },
        h('span', { className: 'bt-tag' }, bundle.enabled ? t('Enabled') : t('Disabled')),
        bundle.official ? h('span', { className: 'bt-tag' }, t('Official')) : null)))
}

export function PluginsPage({ roster, actions, run }) {
  const inventory = roster.plugins ?? {}
  const entries = inventory.entries ?? []
  const bundles = inventory.bundles ?? []
  const openManager = () => {
    actions.closeSettings()
    requestAnimationFrame(() => actions.selectPanel('plugins'))
  }
  return [
    h('section', { key: 'plugins', className: 'bt-set-section' },
      h('h3', null, t('Profile plugins')),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.refreshPlugins()) }, t('Refresh')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: openManager }, t('Open DSH plugin manager'))),
      h('div', { className: 'bt-set-hint bt-plugin-scope' }, t('Profile-wide: changes affect every Session and Bot.')),
      inventory.unavailable
        ? h('div', { className: 'bt-set-card' }, h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, inventory.unavailable)))
        : h('div', { className: 'bt-set-card bt-connectors-card' },
            entries.length === 0
              ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No profile plugins reported')))
              : entries.map(entry => h(PluginRow, { key: `${entry.moduleName}:${entry.name}`, entry })))),
    h('section', { key: 'bundles', className: 'bt-set-section' },
      h('h3', null, t('Bundles')),
      h('div', { className: 'bt-set-card bt-connectors-card' },
        bundles.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No bundles reported')))
          : bundles.map(bundle => h(BundleRow, { key: `${bundle.packageName}:${bundle.name}`, bundle })))),
  ]
}
