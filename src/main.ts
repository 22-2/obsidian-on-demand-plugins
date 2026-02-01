import { Platform, Plugin, PluginManifest } from 'obsidian'
import {
  DEFAULT_DEVICE_SETTINGS,
  DEFAULT_SETTINGS,
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

  get obsidianPlugins () {
    return (this.app as unknown as { plugins: any }).plugins
  }

  get obsidianCommands () {
    return (this.app as unknown as { commands: any }).commands
  }

  async onload () {
    await this.loadSettings()
    this.updateManifests()

    await this.setInitialPluginsConfiguration()
    this.addSettingTab(new SettingsTab(this.app, this))

    await this.initializeCommandCache()
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

    await this.migrateSettings()
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
      if (this.settings.plugins?.[plugin.id]?.mode === undefined) {
        // There is no existing setting for this plugin, so create one
        this.settings.plugins[plugin.id] = { mode: this.getDefaultModeForPlugin(plugin.id) }
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
    this.settings.plugins[pluginId] = { mode }
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
    if (this.obsidianPlugins.enabledPlugins.has(pluginId)) {
      return 'keepEnabled'
    }

    return this.settings.defaultMode ?? 'disabled'
  }

  async initializeCommandCache () {
    await this.enableAllPluginsTemporarily()
    this.cacheAllPluginCommands()
    await this.applyStartupPolicy()
    this.registerCachedCommands()
  }

  async enableAllPluginsTemporarily () {
    for (const plugin of this.manifests) {
      if (!this.obsidianPlugins.enabledPlugins.has(plugin.id)) {
        await this.obsidianPlugins.enablePlugin(plugin.id)
      }
    }
  }

  cacheAllPluginCommands () {
    this.commandCache.clear()
    this.pluginCommandIndex.clear()

    for (const plugin of this.manifests) {
      this.cacheCommandsForPlugin(plugin.id)
    }
  }

  cacheCommandsForPlugin (pluginId: string) {
    const commands = this.getCommandsForPlugin(pluginId)
    if (!commands.length) return

    const ids = new Set<string>()
    commands.forEach(command => {
      this.commandCache.set(command.id, command)
      ids.add(command.id)
    })

    this.pluginCommandIndex.set(pluginId, ids)
  }

  getCommandsForPlugin (pluginId: string): CachedCommand[] {
    const commands = Object.values(this.obsidianCommands.commands) as CachedCommand[]
    return commands
      .filter(command => this.getCommandPluginId(command.id) === pluginId)
      .map(command => ({
        id: command.id,
        name: command.name,
        icon: command.icon,
        pluginId
      }))
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

    await this.writeCommunityPluginsFile([...desiredEnabled])

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
    if (this.pluginCommandIndex.has(pluginId)) return

    const wasEnabled = this.obsidianPlugins.enabledPlugins.has(pluginId)
    if (!wasEnabled) {
      await this.obsidianPlugins.enablePlugin(pluginId)
    }

    this.cacheCommandsForPlugin(pluginId)

    if (!wasEnabled) {
      await this.obsidianPlugins.disablePlugin(pluginId)
    }
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

      this.addCommand({
        id: cached.id,
        name: cached.name,
        icon: cached.icon,
        callback: async () => {
          await this.runLazyCommand(cached)
        }
      })

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

  async runLazyCommand (command: CachedCommand) {
    const isLoaded = this.obsidianPlugins.plugins?.[command.pluginId]?._loaded
    if (!this.obsidianPlugins.enabledPlugins.has(command.pluginId) || !isLoaded) {
      this.removeCommandWrapper(command.id)
      await this.obsidianPlugins.enablePlugin(command.pluginId)
      await this.waitForCommand(command.id)
    }

    await this.obsidianCommands.executeCommand(command.id)
  }

  async waitForCommand (commandId: string, timeoutMs = 5000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this.obsidianCommands.commands[commandId]) return
      await this.sleep(50)
    }
  }

  async sleep (ms: number) {
    await new Promise(resolve => setTimeout(resolve, ms))
  }

}
