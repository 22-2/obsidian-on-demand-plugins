const { Plugin, ItemView } = require("obsidian");

module.exports = class extends Plugin {
    async onload() {
        this.addCommand({ id: "early", name: "Early command", callback() {} });
        await new Promise((resolve) => setTimeout(resolve, 200));
        this.addCommand({ id: "late", name: "Late command", callback() {} });
        this.registerView("cache-async-view", (leaf) => new (class extends ItemView {
            getViewType() { return "cache-async-view"; }
            getDisplayText() { return "Cache fixture"; }
        })(leaf));
    }
};
