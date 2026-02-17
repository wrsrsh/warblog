import * as fs from "fs";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting, Modal } from "obsidian";
import simpleGit, { SimpleGit } from "simple-git";
import { z } from "zod";
const matter = require("gray-matter");

const BlogSchema = z.object({
  title: z.string(),
  description: z.string(),
  pubDate: z.coerce.date(),
  updatedDate: z.coerce.date().optional(),
  heroImage: z.string().optional(),
  published: z.boolean().optional(),
});

interface Settings {
  astroRoot: string;
  contentFolder: string;
  symlinkName: string;
  password: string;
}

const DEFAULT_SETTINGS: Settings = {
  astroRoot: "",
  contentFolder: "src/content/blog",
  symlinkName: "Blog",
  password: "",
};

export default class WarBlog extends Plugin {
  settings: Settings;
  git: SimpleGit;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerExtensions(["mdx"], "markdown");

    if (this.settings.astroRoot) {
      await this.setupSymlink();
      this.git = simpleGit(this.settings.astroRoot);
    }

    this.addCommand({
      id: "update-blog",
      name: "Update blog to most recent changes",
      callback: () => new PasswordModal(this.app, this).open(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async selectFolder(): Promise<string | null> {
    const { dialog } = require("@electron/remote") || require("electron").remote;
    if (!dialog) {
      new Notice("File picker unavailable");
      return null;
    }

    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  }

  async setupSymlink() {
    const vaultRoot = (this.app.vault.adapter as any).basePath;
    const linkPath = path.join(vaultRoot, this.settings.symlinkName);
    const targetPath = path.join(this.settings.astroRoot, this.settings.contentFolder);

    if (!fs.existsSync(targetPath)) {
      new Notice("Blog folder not found");
      return;
    }

    if (fs.existsSync(linkPath)) {
      const stats = fs.lstatSync(linkPath);
      if (stats.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) === targetPath) return;
        fs.unlinkSync(linkPath);
      } else {
        new Notice(`Folder "${this.settings.symlinkName}" already exists`);
        return;
      }
    }

    try {
      fs.symlinkSync(targetPath, linkPath, "junction");
      new Notice("Blog linked successfully");
    } catch (err) {
      new Notice("Failed to create link");
      console.error(err);
    }
  }

  async removeSymlink() {
    const vaultRoot = (this.app.vault.adapter as any).basePath;
    const linkPath = path.join(vaultRoot, this.settings.symlinkName);

    if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    }
  }

  async validateFrontmatter(filePath: string): Promise<boolean> {
    try {
      const content = await this.app.vault.adapter.read(filePath);
      const { data } = matter(content);
      BlogSchema.parse(data);
      return true;
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
        new Notice(`Validation failed:\n${errors}`, 8000);
      }
      return false;
    }
  }

  async updateBlog() {
    if (!this.git) {
      new Notice("Git not configured");
      return;
    }

    try {
      new Notice("Updating blog...");

      const files = this.app.vault.getMarkdownFiles()
        .filter(f => f.path.startsWith(this.settings.symlinkName));

      for (const file of files) {
        const valid = await this.validateFrontmatter(file.path);
        if (!valid) {
          new Notice(`Validation failed for ${file.name}`);
          return;
        }
      }

      await this.git.add(`${this.settings.contentFolder}/*`);
      const status = await this.git.status();

      if (!status.modified.length && !status.created.length && !status.deleted.length) {
        new Notice("No changes to commit");
        return;
      }

      const timestamp = new Date().toLocaleString();
      await this.git.commit(`Update blog - ${timestamp}`, undefined, { '--no-gpg-sign': null });
      await this.git.push();

      new Notice("Blog updated successfully");
    } catch (err) {
      new Notice(`Update failed: ${err.message}`);
      console.error(err);
    }
  }
}

class PasswordModal extends Modal {
  plugin: WarBlog;
  password = "";

  constructor(app: App, plugin: WarBlog) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("warblog-modal");

    contentEl.createEl("h2", { text: "Update Blog" });

    const input = contentEl.createEl("input", {
      type: "password",
      placeholder: "Enter password",
    });
    input.style.width = "100%";
    input.style.marginTop = "1rem";

    input.addEventListener("input", (e) => {
      this.password = (e.target as HTMLInputElement).value;
    });

    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && this.password) this.submit();
    });

    const btnContainer = contentEl.createEl("div");
    btnContainer.style.marginTop = "1rem";
    btnContainer.style.display = "flex";
    btnContainer.style.gap = "0.5rem";
    btnContainer.style.justifyContent = "flex-end";

    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnContainer.createEl("button", { text: "Update", cls: "mod-cta" });
    submitBtn.addEventListener("click", () => this.submit());

    setTimeout(() => input.focus(), 10);
  }

  async submit() {
    if (!this.password) {
      new Notice("Enter password");
      return;
    }

    if (this.password !== this.plugin.settings.password) {
      new Notice("Incorrect password");
      return;
    }

    this.close();
    await this.plugin.updateBlog();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  plugin: WarBlog;

  constructor(app: App, plugin: WarBlog) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "WarBlog" });
    containerEl.createEl("p", { 
      text: "Edit and publish your Astro blog from Obsidian",
      cls: "setting-item-description" 
    });

    this.addSection(containerEl, "Configuration");

    new Setting(containerEl)
      .setName("Astro project root")
      .setDesc("The root directory of your Astro blog")
      .addButton(btn => btn
        .setButtonText("Browse")
        .onClick(async () => {
          const folder = await this.plugin.selectFolder();
          if (!folder || !fs.existsSync(folder)) return;

          this.plugin.settings.astroRoot = folder;
          await this.plugin.saveSettings();
          await this.plugin.removeSymlink();
          await this.plugin.setupSymlink();
          this.display();
        })
      );

    if (this.plugin.settings.astroRoot) {
      const pathEl = containerEl.createEl("div", { cls: "setting-item-description" });
      pathEl.style.marginTop = "-0.5rem";
      pathEl.style.marginBottom = "1rem";
      pathEl.style.fontFamily = "monospace";
      pathEl.style.fontSize = "0.9em";
      pathEl.textContent = this.plugin.settings.astroRoot;
    }

    new Setting(containerEl)
      .setName("Content folder")
      .setDesc("Path to blog posts within your Astro project")
      .addText(text => text
        .setPlaceholder("src/content/blog")
        .setValue(this.plugin.settings.contentFolder)
        .onChange(async value => {
          this.plugin.settings.contentFolder = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Vault folder name")
      .setDesc("Name of the linked folder in your vault")
      .addText(text => text
        .setPlaceholder("Blog")
        .setValue(this.plugin.settings.symlinkName)
        .onChange(async value => {
          this.plugin.settings.symlinkName = value.trim();
          await this.plugin.saveSettings();
        })
      );

    this.addSection(containerEl, "Security");

    new Setting(containerEl)
      .setName("Update password")
      .setDesc("Required to publish changes")
      .addText(text => {
        text
          .setPlaceholder("Set password")
          .setValue(this.plugin.settings.password)
          .onChange(async value => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
  }

  addSection(containerEl: HTMLElement, title: string) {
    const section = containerEl.createEl("div");
    section.style.marginTop = "2rem";
    section.createEl("h3", { text: title });
  }
}
