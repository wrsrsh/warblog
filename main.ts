import { promises as fs } from "fs";
import { existsSync, lstatSync, readlinkSync } from "fs";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting, Modal, FileSystemAdapter } from "obsidian";
import simpleGit, { SimpleGit } from "simple-git";
import { z } from "zod";
import matter from "gray-matter";

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

interface ElectronDialog {
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronRemote {
  dialog: ElectronDialog;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as Settings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async selectFolder(): Promise<string | null> {
    let dialog: ElectronDialog | null = null;

    try {
      const remoteModule = await import("@electron/remote") as ElectronRemote;
      dialog = remoteModule.dialog;
    } catch {
      try {
        const electronModule = await import("electron") as { remote?: ElectronRemote };
        dialog = electronModule.remote?.dialog ?? null;
      } catch {
        // Electron not available
      }
    }

    if (!dialog) {
      new Notice("File picker unavailable");
      return null;
    }

    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  }

  async setupSymlink(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const vaultRoot = adapter.getBasePath();
    const linkPath = path.join(vaultRoot, this.settings.symlinkName);
    const targetPath = path.join(this.settings.astroRoot, this.settings.contentFolder);

    if (!existsSync(targetPath)) {
      new Notice("Blog folder not found");
      return;
    }

    if (existsSync(linkPath)) {
      const stats = lstatSync(linkPath);
      if (stats.isSymbolicLink()) {
        if (readlinkSync(linkPath) === targetPath) return;
        await fs.unlink(linkPath);
      } else {
        new Notice(`Folder "${this.settings.symlinkName}" already exists`);
        return;
      }
    }

    try {
      await fs.symlink(targetPath, linkPath, "junction");
      new Notice("Blog linked successfully");
    } catch (err) {
      new Notice("Failed to create link");
      console.error(err);
    }
  }

  async removeSymlink(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const vaultRoot = adapter.getBasePath();
    const linkPath = path.join(vaultRoot, this.settings.symlinkName);

    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
      await fs.unlink(linkPath);
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
      new Notice(`Update failed: ${(err as Error).message}`);
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

    new Setting(contentEl).setName("Update blog").setHeading();

    const input = contentEl.createEl("input", {
      type: "password",
      placeholder: "Enter password",
    });
    input.addClass("warblog-modal-input");

    input.addEventListener("input", (e) => {
      this.password = (e.target as HTMLInputElement).value;
    });

    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && this.password) {
        void this.submit();
      }
    });

    const btnContainer = contentEl.createEl("div");
    btnContainer.addClass("warblog-btn-container");

    const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnContainer.createEl("button", { text: "Update", cls: "mod-cta" });
    submitBtn.addEventListener("click", () => {
      void this.submit();
    });

    window.setTimeout(() => input.focus(), 10);
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

    containerEl.createEl("p", { 
      text: "Edit and publish your Astro blog from Obsidian.",
      cls: "setting-item-description" 
    });

    new Setting(containerEl).setName("Configuration").setHeading();

    new Setting(containerEl)
      .setName("Astro project root")
      .setDesc("The root directory of your Astro blog")
      .addButton(btn => btn
        .setButtonText("Browse")
        .onClick(async () => {
          const folder = await this.plugin.selectFolder();
          if (!folder || !existsSync(folder)) return;

          this.plugin.settings.astroRoot = folder;
          await this.plugin.saveSettings();
          await this.plugin.removeSymlink();
          await this.plugin.setupSymlink();
          this.display();
        })
      );

    if (this.plugin.settings.astroRoot) {
      const pathEl = containerEl.createEl("div", { 
        cls: "setting-item-description warblog-path-display" 
      });
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

    new Setting(containerEl).setName("Security").setHeading();

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
}
