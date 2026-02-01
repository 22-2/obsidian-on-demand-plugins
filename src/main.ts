import { Editor, MarkdownView, Platform, Plugin, PluginManifest } from 'obsidian'
import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SETTINGS,
  CommandCache,
  CachedCommandEntry,
  DeviceSettings,
  LazySettings,
  PluginMode,
  SettingsTab
} from './settings'

const lazyPluginId = require('../manifest.json').id

interface CachedCommand {
  id: string
  name: string
  icon?: string
  pluginId: string
}

export default class LazyPlugin extends Plugin {
  data: LazySettings
  settings: DeviceSettings
  device = 'desktop/global'
  manifests: PluginManifest[]
  commandCache = new Map<string, CachedCommand>()
  pluginCommandIndex = new Map<string, Set<string>>()
  registeredWrappers = new Set<string>()
  inFlightPlugins = new Set<string>()
  enabledPluginsFromDisk = new Set<string>()

  get obsidianPlugins () {
    return (this.app as unknown as { plugins: any }).plugins
  }

  get obsidianCommands () {
    return (this.app as unknown as { commands: any }).commands
  }

  async onload () {
    await this.loadSettings()
    await this.loadEnabledPluginsFromDisk()
    this.updateManifests()

    await this.migrateSettings()
    await this.setInitialPluginsConfiguration()
    this.addSettingTab(new SettingsTab(this.app, this))

    await this.loadCachedCommandsFromData()
    await this.initializeCommandCache()
  }

  async onunload () {
    // Remove registered command wrappers
    this.registeredWrappers.forEach(commandId => this.removeCommandWrapper(commandId))
    this.registeredWrappers.clear()

    // Clear in-memory caches
    this.commandCache.clear()
    this.pluginCommandIndex.clear()
    this.inFlightPlugins.clear()
    this.enabledPluginsFromDisk.clear()
  }

  async loadSettings () {
    this.data = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    // Object.assign only works 1 level deep, so need to clone the sub-level as well
    this.data.desktop = Object.assign({}, DEFAULT_DEVICE_SETTINGS, this.data.desktop)

    // If user has dual mobile/desktop settings enabled
    if (this.data.dualConfigs && Platform.isMobile) {
      if (!this.data.mobile) {
        // No existing configuration - copy the desktop one
        this.data.mobile = JSON.parse(JSON.stringify(this.data.desktop)) as DeviceSettings
      } else {
        this.data.mobile = Object.assign({}, DEFAULT_DEVICE_SETTINGS, this.data.mobile)
      }
      this.settings = this.data.mobile
      this.device = 'mobile'
    } else {
      this.settings = this.data.desktop
      this.device = 'desktop/global'
    }

  }

  async saveSettings () {
    await this.saveData(this.data)
  }

  async migrateSettings () {
    let hasChanges = false
    const settings = this.settings as DeviceSettings & { defaultKeepEnabled?: boolean }

    if (!settings.plugins) {
      settings.plugins = {}
      hasChanges = true
    }

    if (settings.defaultMode === undefined && settings.defaultKeepEnabled !== undefined) {
      settings.defaultMode = settings.defaultKeepEnabled ? 'keepEnabled' : 'disabled'
      delete settings.defaultKeepEnabled
      hasChanges = true
    }

    Object.entries(settings.plugins).forEach(([pluginId, pluginSettings]) => {
      const legacy = pluginSettings as { keepEnabled?: boolean, mode?: PluginMode }
      if (legacy.mode === undefined && legacy.keepEnabled !== undefined) {
        legacy.mode = legacy.keepEnabled ? 'keepEnabled' : 'disabled'
        delete legacy.keepEnabled
        settings.plugins[pluginId] = legacy
        hasChanges = true
      }
    })

    if (hasChanges) {
      await this.saveSettings()
    }
  }

  /**
   * Set the initial config value for all installed plugins. This will also set the value
   * for any new plugin in the future, depending on what default value is chosen in the
   * Settings page.
   */
  async setInitialPluginsConfiguration () {
    let hasChanges = false
    for (const plugin of this.manifests) {
      const current = this.settings.plugins?.[plugin.id]
      if (!current || current.mode === undefined) {
        // There is no existing setting for this plugin, so create one
        this.settings.plugins[plugin.id] = {
          mode: this.getDefaultModeForPlugin(plugin.id),
          userConfigured: false
        }
        hasChanges = true
        continue
      }

      if (!current.userConfigured && current.mode === 'disabled' && this.isPluginEnabledOnDisk(plugin.id)) {
        this.settings.plugins[plugin.id] = {
          mode: 'keepEnabled',
          userConfigured: false
        }
        hasChanges = true
      }
    }

    if (hasChanges) {
      await this.saveSettings()
    }
  }

  /**
   * Update an individual plugin's configuration in the settings file
   */
  async updatePluginSettings (pluginId: string, mode: PluginMode) {
    this.settings.plugins[pluginId] = { mode, userConfigured: true }
    await this.saveSettings()
    await this.applyPluginState(pluginId)
  }

  updateManifests () {
    // Get the list of installed plugins
    const manifests = Object.values(this.obsidianPlugins.manifests) as PluginManifest[]
    this.manifests = manifests
      .filter((plugin: PluginManifest) =>
        // Filter out the Lazy Loader plugin
        plugin.id !== lazyPluginId &&
        // Filter out desktop-only plugins from mobile
        !(Platform.isMobile && plugin.isDesktopOnly))
      .sort((a: PluginManifest, b: PluginManifest) => a.name.localeCompare(b.name))
  }

  getPluginMode (pluginId: string): PluginMode {
    return this.settings.plugins?.[pluginId]?.mode ??
      this.getDefaultModeForPlugin(pluginId)
  }

  getDefaultModeForPlugin (pluginId: string): PluginMode {
    if (this.isPluginEnabledOnDisk(pluginId)) {
      return 'keepEnabled'
    }

    return this.settings.defaultMode ?? 'disabled'
  }

  isPluginEnabledOnDisk (pluginId: string): boolean {
    return this.enabledPluginsFromDisk.has(pluginId) || this.obsidianPlugins.enabledPlugins.has(pluginId)
  }

  async initializeCommandCache () {
    await this.refreshCommandCache()
    await this.applyStartupPolicy()
    this.registerCachedCommands()
  }

  async refreshCommandCache () {
    let updated = false
    for (const plugin of this.manifests) {
      const mode = this.getPluginMode(plugin.id)
      if (mode === 'lazy') {
        if (this.isCommandCacheValid(plugin.id)) continue
        updated = (await this.refreshCommandsForPlugin(plugin.id)) || updated
      }
    }

    if (updated) {
      await this.persistCommandCache()
    }
  }

  async refreshCommandsForPlugin (pluginId: string): Promise<boolean> {
    const commands = await this.getCommandsForPlugin(pluginId)
    if (!commands.length) return false

    const ids = new Set<string>()
    commands.forEach(command => {
      this.commandCache.set(command.id, command)
      ids.add(command.id)
    })

    this.pluginCommandIndex.set(pluginId, ids)
    return true
  }

  async getCommandsForPlugin (pluginId: string): Promise<CachedCommand[]> {
    const wasEnabled = this.obsidianPlugins.enabledPlugins.has(pluginId)
    if (!wasEnabled) {
      await this.obsidianPlugins.enablePlugin(pluginId)
    }

    const commands = Object.values(this.obsidianCommands.commands) as CachedCommand[]
    const pluginCommands = commands
      .filter(command => this.getCommandPluginId(command.id) === pluginId)
      .map(command => ({
        id: command.id,
        name: command.name,
        icon: command.icon,
        pluginId
      }))

    if (!wasEnabled && this.getPluginMode(pluginId) !== 'keepEnabled') {
      await this.obsidianPlugins.disablePlugin(pluginId)
    }

    return pluginCommands
  }

  getCommandPluginId (commandId: string): string | null {
    const [prefix] = commandId.split(':')
    return this.manifests.some(plugin => plugin.id === prefix) ? prefix : null
  }

  async applyStartupPolicy () {
    const desiredEnabled = new Set<string>()
    this.manifests.forEach(plugin => {
      if (this.getPluginMode(plugin.id) === 'keepEnabled') {
        desiredEnabled.add(plugin.id)
      }
    })
    desiredEnabled.add(lazyPluginId)

    await this.writeCommunityPluginsFile([...desiredEnabled].sort((a, b) => a.localeCompare(b)))

    for (const plugin of this.manifests) {
      await this.applyPluginState(plugin.id)
    }
  }

  async applyPluginState (pluginId: string) {
    const mode = this.getPluginMode(pluginId)
    if (mode === 'keepEnabled') {
      if (!this.obsidianPlugins.enabledPlugins.has(pluginId)) {
        await this.obsidianPlugins.enablePlugin(pluginId)
      }
      this.removeCachedCommandsForPlugin(pluginId)
      return
    }

    if (mode === 'lazy') {
      await this.ensureCommandsCached(pluginId)
      if (this.obsidianPlugins.enabledPlugins.has(pluginId)) {
        await this.obsidianPlugins.disablePlugin(pluginId)
      }
      this.registerCachedCommandsForPlugin(pluginId)
      return
    }

    if (this.obsidianPlugins.enabledPlugins.has(pluginId)) {
      await this.obsidianPlugins.disablePlugin(pluginId)
    }
    this.removeCachedCommandsForPlugin(pluginId)
  }

  async writeCommunityPluginsFile (enabledPlugins: string[]) {
    const adapter = this.app.vault.adapter
    const path = '.obsidian/community-plugins.json'
    const content = JSON.stringify(enabledPlugins, null, '\t')

    try {
      await adapter.write(path, content)
    } catch (error) {
      if (this.data?.showConsoleLog) {
        console.error('Failed to write community-plugins.json', error)
      }
    }
  }

  async ensureCommandsCached (pluginId: string) {
    if (this.isCommandCacheValid(pluginId)) return
    await this.refreshCommandsForPlugin(pluginId)
    await this.persistCommandCache()
  }

  registerCachedCommands () {
    for (const plugin of this.manifests) {
      if (this.getPluginMode(plugin.id) === 'lazy') {
        this.registerCachedCommandsForPlugin(plugin.id)
      }
    }
  }

  registerCachedCommandsForPlugin (pluginId: string) {
    const commandIds = this.pluginCommandIndex.get(pluginId)
    if (!commandIds) return

    commandIds.forEach(commandId => {
      if (this.registeredWrappers.has(commandId)) return
      if (this.obsidianCommands.commands[commandId]) return

      const cached = this.commandCache.get(commandId)
      if (!cached) return

      const cmd = {
        id: commandId,
        name: cached.name,
        icon: cached.icon,
        callback: async () => {
          await this.runLazyCommand(commandId)
        }
      }

      this.obsidianCommands.addCommand(cmd)
      this.registeredWrappers.add(commandId)
    })
  }

  removeCachedCommandsForPlugin (pluginId: string) {
    const commandIds = this.pluginCommandIndex.get(pluginId)
    if (!commandIds) return

    commandIds.forEach(commandId => this.removeCommandWrapper(commandId))
  }

  removeCommandWrapper (commandId: string) {
    const commands = this.obsidianCommands as unknown as { removeCommand?: (id: string) => void, commands?: Record<string, unknown> }
    if (typeof commands.removeCommand === 'function') {
      commands.removeCommand(commandId)
    } else if (commands.commands && commands.commands[commandId]) {
      delete commands.commands[commandId]
    }
    this.registeredWrappers.delete(commandId)
  }

  async runLazyCommand (commandId: string) {
    const cached = this.commandCache.get(commandId)
    if (!cached) return

    if (this.inFlightPlugins.has(cached.pluginId)) return
    this.inFlightPlugins.add(cached.pluginId)

    try {
      const isLoaded = this.obsidianPlugins.plugins?.[cached.pluginId]?._loaded
      if (!this.obsidianPlugins.enabledPlugins.has(cached.pluginId) || !isLoaded) {
        this.removeCachedCommandsForPlugin(cached.pluginId)
        await this.obsidianPlugins.enablePlugin(cached.pluginId)
        const ready = await this.waitForCommand(cached.id)
        if (!ready) return
      }

      if (this.data.showConsoleLog) {
        console.log(`Executing lazy command: ${cached.id}`)
      }

      await new Promise<void>(resolve => {
        queueMicrotask(() => {
          this.executeCommandDirect(cached.id)
          resolve()
        })
      })
    } catch (error) {
      if (this.data.showConsoleLog) {
        console.error(`Error executing lazy command ${commandId}:`, error)
      }
    } finally {
      this.inFlightPlugins.delete(cached.pluginId)
    }
  }

  async waitForCommand (commandId: string, timeoutMs = 8000): Promise<boolean> {
    if (this.isCommandExecutable(commandId)) return true

    return await new Promise<boolean>(resolve => {
      const viewRegistry = (this.app as unknown as { viewRegistry?: any }).viewRegistry
      let done = false

      const cleanup = () => {
        if (done) return
        done = true
        if (viewRegistry?.off) viewRegistry.off('view-registered', onEvent)
        if (this.app.workspace?.off) this.app.workspace.off('layout-change', onEvent)
        if (timeoutId) window.clearTimeout(timeoutId)
      }

      const onEvent = () => {
        if (this.isCommandExecutable(commandId)) {
          cleanup()
          resolve(true)
        }
      }

      if (viewRegistry?.on) viewRegistry.on('view-registered', onEvent)
      if (this.app.workspace?.on) this.app.workspace.on('layout-change', onEvent)

      queueMicrotask(onEvent)

      const timeoutId = window.setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
    })
  }

  executeCommandDirect (commandId: string): boolean {
    const command = this.obsidianCommands.commands[commandId] as {
      callback?: () => void
      checkCallback?: (checking: boolean) => boolean | void
      editorCallback?: (editor: Editor, ctx?: unknown) => void
      editorCheckCallback?: (checking: boolean, editor: Editor, ctx?: unknown) => boolean | void
    } | undefined

    if (!command) return false

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    const file = view?.file

    if (editor && typeof command.editorCheckCallback === 'function') {
      const ok = command.editorCheckCallback(true, editor, file)
      if (ok === false) return false
      command.editorCheckCallback(false, editor, file)
      return true
    }

    if (editor && typeof command.editorCallback === 'function') {
      command.editorCallback(editor, file)
      return true
    }

    if (typeof command.checkCallback === 'function') {
      const ok = command.checkCallback(true)
      if (ok === false) return false
      command.checkCallback(false)
      return true
    }

    if (typeof command.callback === 'function') {
      command.callback()
      return true
    }

    return false
  }

  isCommandExecutable (commandId: string): boolean {
    const command = this.obsidianCommands.commands[commandId] as {
      callback?: () => void
      checkCallback?: (checking: boolean) => boolean | void
      editorCallback?: (editor: Editor, ctx?: unknown) => void
      editorCheckCallback?: (checking: boolean, editor: Editor, ctx?: unknown) => boolean | void
    } | undefined

    if (!command) return false

    return typeof command.callback === 'function' ||
      typeof command.checkCallback === 'function' ||
      typeof command.editorCallback === 'function' ||
      typeof command.editorCheckCallback === 'function'
  }

  async loadCachedCommandsFromData () {
    if (!this.data.commandCache) return

    this.commandCache.clear()
    this.pluginCommandIndex.clear()

    Object.entries(this.data.commandCache).forEach(([pluginId, commands]) => {
      const ids = new Set<string>()
      commands.forEach(command => {
        const cached: CachedCommand = {
          id: command.id,
          name: command.name,
          icon: command.icon,
          pluginId
        }
        this.commandCache.set(cached.id, cached)
        ids.add(cached.id)
      })
      this.pluginCommandIndex.set(pluginId, ids)
    })
  }

  async loadEnabledPluginsFromDisk () {
    const adapter = this.app.vault.adapter
    const path = '.obsidian/community-plugins.json'
    this.enabledPluginsFromDisk.clear()

    try {
      const raw = await adapter.read(path)
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        parsed.forEach(id => {
          if (typeof id === 'string') this.enabledPluginsFromDisk.add(id)
        })
      }
    } catch (error) {
      if (this.data?.showConsoleLog) {
        console.warn('Failed to read community-plugins.json', error)
      }
    }
  }

  async persistCommandCache () {
    const cache: CommandCache = {}
    this.manifests.forEach(plugin => {
      const commands = Array.from(this.commandCache.values())
        .filter(command => command.pluginId === plugin.id)
        .map(command => ({
          id: command.id,
          name: command.name,
          icon: command.icon
        }))
      if (commands.length) {
        cache[plugin.id] = commands
      }
    })

    this.data.commandCache = cache
    this.data.commandCacheUpdatedAt = Date.now()
    await this.saveSettings()
  }

  isCommandCacheValid (pluginId: string): boolean {
    if (!this.pluginCommandIndex.has(pluginId)) return false
    const cached = this.data.commandCache?.[pluginId]
    return Array.isArray(cached) && cached.length > 0
  }

}
