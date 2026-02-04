# 🦥 Lazy Loader

Lazy load plugins by caching their commands. Plugins are enabled on-demand when you trigger their commands (or open specific views), keeping startup fast.

**Important note #1**: It may take up to 2 restarts of Obsidian to see the full speed increase, if it's the first time you're using the plugin. This will only be an issue on the first install.

**Important note #2**: There is no way for this plugin to know if you've manually disabled or enabled a plugin. If you want disabling a plugin to persist through an Obsidian restart, make sure you disable it inside Lazy Loader's settings page rather than simply disabling the plugin in Obsidian's plugins page.

## ✅ How to Use

1. Open **Settings → On‑Demand Plugins**.
2. In the plugin list, choose a mode for each plugin:
	- **Lazy on command**: Loads when you run one of its commands.
	- **Lazy on view**: Loads when a specific view type is opened.
	- **Always enabled**: Loads normally at startup.
	- **Disabled**: Keeps the plugin off.
3. Click **Apply changes** to activate your selections.
4. (Optional) Set **Default behavior for new plugins** at the top of the settings page.

## ✨ Features

- **Command-based Loading**: Plugins are loaded only when you execute one of their commands.
- **🖼️ View-based Loading**: Automatically load plugins when a specific view type is displayed. This is useful for plugins that enhance specific file types or views.
- **Automatic View Type Detection**: When a plugin is set to **Lazy on view**, its view types are captured automatically during **Apply changes**. You do not need to enter view types manually.
- **Customizable Startup Policy**: Individual settings for each plugin to decide how they should be loaded.

## 📷 Screenshot

Add a screenshot of the On‑Demand Plugins settings page to make the setup clearer for reviewers and users.
<!-- Replace with your screenshot file -->
<!-- ![On‑Demand Plugins settings](docs/settings.png) -->

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
