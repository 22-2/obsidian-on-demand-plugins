# 🦥 Lazy Loader

Lazy load plugins by caching their commands. Plugins are enabled on-demand when you trigger their commands (or open specific views), keeping startup fast.

**Important note #1**: It may take up to 2 restarts of Obsidian to see the full speed increase, if it's the first time you're using the plugin. This will only be an issue on the first install.

**Important note #2**: There is no way for this plugin to know if you've manually disabled or enabled a plugin. If you want disabling a plugin to persist through an Obsidian restart, make sure you disable it inside Lazy Loader's settings page rather than simply disabling the plugin in Obsidian's plugins page.

## ✨ Features

- **Command-based Loading**: Plugins are loaded only when you execute one of their commands.
- **🖼️ View-based Loading**: Automatically load plugins when a specific view type is displayed. This is useful for plugins that enhance specific file types or views.
- **Customizable Startup Policy**: Individual settings for each plugin to decide how they should be loaded.

## ⚠️ Recommended Usage & Warnings

### Periodic Execution & Hooks
Plugins that rely on the following should **not** be lazy-loaded:
- **Periodic tasks**: Plugins using `setInterval` or `setTimeout` for background sync, backups, or timers.
- **Global Event Hooks**: Plugins that register events like `this.app.vault.on('modify', ...)` or `this.app.workspace.on('layout-change', ...)` right at startup.

Since these plugins are only enabled when triggered, their background tasks or hooks will not be active until the plugin is loaded.

### Plugin Guidelines
For more information on plugin management and standards, please refer to the [guidelines](myfiles/guidelines.txt).

## 🙏 Acknowledgements

- **Obsidian Team**: For creating such a flexible and powerful platform.
- **Original Idea & Foundation**: This project is a fork of and inspired by the original work of [Alan Grainger](https://github.com/alangrainger/obsidian-lazy-plugins).
