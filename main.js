const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
  outputFolder: '',
  autoOpenCanvas: true,
  overwriteExisting: true,
  horizontalSpacing: 180,
  verticalSpacing: 90,
  sectionSpacing: 260,
  placeCanvasBeside: false,
  layoutMode: 'hierarchy'
};

const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','avif']);

class MarkdownToCanvasMapperPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('workflow', 'Notes to Canvas Mapper', async () => {
      await this.generateCanvasSmart();
    });

    this.addCommand({
      id: 'generate-canvas-from-current-note',
      name: 'Generate Canvas from Current Note',
      callback: async () => {
        await this.generateCanvasFromCurrentNote();
      }
    });

    this.addCommand({
      id: 'generate-canvas-from-selected-text',
      name: 'Generate Canvas from Selected Text',
      editorCallback: async (editor, view) => {
        const selectedText = editor.getSelection().trim();
        if (!selectedText) {
          new obsidian.Notice('No text selected.');
          return;
        }
        const title = view?.file?.basename || 'Selected Text Map';
        await this.generateCanvasFromMarkdown(selectedText, title, 'selected text');
      }
    });

    this.addSettingTab(new MarkdownToCanvasMapperSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getActiveMarkdownView() {
    return this.app.workspace.getActiveViewOfType(obsidian.MarkdownView) || null;
  }

  async generateCanvasSmart() {
    const view = this.getActiveMarkdownView();
    if (!view) {
      new obsidian.Notice('No active markdown note found.');
      return;
    }

    const selectedText = view.editor?.getSelection?.().trim();
    if (selectedText) {
      const title = view.file?.basename || 'Selected Text Map';
      await this.generateCanvasFromMarkdown(selectedText, title, 'selected text');
      return;
    }

    await this.generateCanvasFromCurrentNote();
  }

  async generateCanvasFromCurrentNote() {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile) {
      new obsidian.Notice('No active note found.');
      return;
    }

    if (activeFile.extension !== 'md') {
      new obsidian.Notice('Active file is not a markdown note.');
      return;
    }

    const markdown = await this.app.vault.read(activeFile);
    await this.generateCanvasFromMarkdown(markdown, activeFile.basename, 'current note');
  }

  async generateCanvasFromMarkdown(markdown, fallbackTitle, sourceLabel) {
    const parsed = parseMarkdownToStructure(markdown, fallbackTitle);

    const hasContent = parsed.sections.length > 0 || parsed.unsectionedItems.length > 0 || parsed.unsectionedMedia.length > 0;
    if (!hasContent) {
      new obsidian.Notice('No supported structure found. Use headings, bullet lists, or image embeds.');
      return;
    }

    const canvasData = buildCanvasFromParsedDoc(parsed, this.settings);
    const canvasPath = await saveCanvasFile(this.app, parsed.title, canvasData, this.settings);

    new obsidian.Notice(`Canvas created from ${sourceLabel}: ${canvasPath}`);
    if (this.settings.autoOpenCanvas) {
      await this.openCanvas(canvasPath);
    }
  }

  async openCanvas(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) {
      new obsidian.Notice('Could not open generated canvas.');
      return;
    }

    let leaf = null;
    if (this.settings.placeCanvasBeside) {
      leaf = this.app.workspace.getLeaf('split', 'vertical');
    }
    if (!leaf) {
      leaf = this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(true);
    }
    await leaf.openFile(file);
  }
}

class MarkdownToCanvasMapperSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Notes to Canvas Mapper' });

    new obsidian.Setting(containerEl)
      .setName('Output folder')
      .setDesc('Leave blank to save canvases in the vault root.')
      .addText(text => text
        .setPlaceholder('Maps/Generated')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Auto-open canvas')
      .setDesc('Open the generated canvas immediately after creating it.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoOpenCanvas)
        .onChange(async (value) => {
          this.plugin.settings.autoOpenCanvas = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Open beside current note')
      .setDesc('Open the generated canvas in a split beside your current note.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.placeCanvasBeside)
        .onChange(async (value) => {
          this.plugin.settings.placeCanvasBeside = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Overwrite existing canvas')
      .setDesc('If disabled, a numbered canvas name will be created instead.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.overwriteExisting)
        .onChange(async (value) => {
          this.plugin.settings.overwriteExisting = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Horizontal spacing')
      .setDesc('Extra spacing between sibling branches.')
      .addSlider(slider => slider
        .setLimits(80, 420, 10)
        .setValue(this.plugin.settings.horizontalSpacing)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.horizontalSpacing = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Vertical spacing')
      .setDesc('Spacing between levels in the graph.')
      .addSlider(slider => slider
        .setLimits(40, 240, 10)
        .setValue(this.plugin.settings.verticalSpacing)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.verticalSpacing = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Section spacing')
      .setDesc('Extra gap between top-level sections.')
      .addSlider(slider => slider
        .setLimits(120, 520, 10)
        .setValue(this.plugin.settings.sectionSpacing)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.sectionSpacing = value;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Layout mode')
      .setDesc('Hierarchy is the current structured layout. Compact tightens the spacing a bit.')
      .addDropdown(dropdown => dropdown
        .addOption('hierarchy', 'Hierarchy')
        .addOption('compact', 'Compact')
        .setValue(this.plugin.settings.layoutMode)
        .onChange(async (value) => {
          this.plugin.settings.layoutMode = value;
          await this.plugin.saveSettings();
        }));
  }
}

function parseMarkdownToStructure(markdown, fallbackTitle) {
  const lines = markdown.split(/\r?\n/);
  let title = fallbackTitle || 'Untitled Map';
  const sections = [];
  let currentSection = null;
  const unsectionedItems = [];
  const unsectionedMedia = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] || '';
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (/^#\s+/.test(trimmed) && title === (fallbackTitle || 'Untitled Map')) {
      title = trimmed.replace(/^#\s+/, '').trim() || title;
      continue;
    }

    if (/^##\s+/.test(trimmed)) {
      currentSection = {
        heading: trimmed.replace(/^##\s+/, '').trim(),
        items: [],
        media: []
      };
      sections.push(currentSection);
      continue;
    }

    const imageRef = extractImageRef(trimmed);
    if (imageRef) {
      if (currentSection) currentSection.media.push(imageRef);
      else unsectionedMedia.push(imageRef);
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (listMatch) {
      const indent = normalizeIndent(listMatch[1]);
      const content = listMatch[2].trim();
      const item = makeListItem(content);
      const bucket = currentSection ? currentSection.items : unsectionedItems;
      insertNestedItem(bucket, item, indent);
      continue;
    }
  }

  return { title, sections, unsectionedItems, unsectionedMedia };
}

function normalizeIndent(indentStr) {
  const spaces = indentStr.replace(/\t/g, '    ').length;
  return Math.floor(spaces / 2);
}

function makeListItem(content) {
  const imageRef = extractImageRef(content);
  if (imageRef) {
    return { kind: 'image', text: imageRef.label || imageRef.path, path: imageRef.path, children: [] };
  }
  return { kind: 'text', text: content, children: [] };
}

function insertNestedItem(rootItems, item, indent) {
  if (indent <= 0) {
    rootItems.push(item);
    return;
  }
  const parent = findLastItemAtDepth(rootItems, indent - 1);
  if (!parent) {
    rootItems.push(item);
    return;
  }
  parent.children.push(item);
}

function findLastItemAtDepth(items, depth) {
  if (!items.length) return null;
  if (depth === 0) return items[items.length - 1];

  let cursor = items[items.length - 1];
  for (let i = 1; i <= depth; i++) {
    if (!cursor.children.length) return cursor;
    cursor = cursor.children[cursor.children.length - 1];
  }
  return cursor;
}

function extractImageRef(text) {
  let match = text.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
  if (match) {
    const path = cleanImagePath(match[1]);
    if (isImagePath(path)) return { path, label: getFileName(path) };
  }

  match = text.match(/^!\[\[([^\]]+)\]\]$/);
  if (match) {
    const raw = match[1].split('|')[0].trim();
    const path = cleanImagePath(raw);
    if (isImagePath(path)) return { path, label: getFileName(path) };
  }

  return null;
}

function cleanImagePath(value) {
  return String(value || '').trim().replace(/^</, '').replace(/>$/, '');
}

function getFileName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function isImagePath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function buildCanvasFromParsedDoc(parsed, settings) {
  const layoutSettings = normalizeLayoutSettings(settings);
  const nodes = [];
  const edges = [];
  let idCounter = 0;

  const nextId = (prefix) => `${prefix}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;

  const root = makeTextNode(nextId('root'), parsed.title, 0, 0, true);
  nodes.push(root);

  const sectionEntries = [];

  parsed.sections.forEach((section) => {
    const sectionNode = makeTextNode(nextId('section'), section.heading, 0, 0, true);
    const childTree = [];
    section.items.forEach(item => childTree.push(convertItemToTree(item, nextId)));
    section.media.forEach(media => childTree.push(convertMediaToTree(media, nextId)));
    if (!childTree.length) {
      childTree.push(makeTextNode(nextId('empty'), 'Empty section', 0, 0, false));
    }
    const subtree = makeTreeNode(sectionNode, childTree);
    sectionEntries.push({ heading: section.heading, subtree });
  });

  if (!sectionEntries.length && (parsed.unsectionedItems.length || parsed.unsectionedMedia.length)) {
    const sectionNode = makeTextNode(nextId('section'), 'General', 0, 0, true);
    const childTree = [];
    parsed.unsectionedItems.forEach(item => childTree.push(convertItemToTree(item, nextId)));
    parsed.unsectionedMedia.forEach(media => childTree.push(convertMediaToTree(media, nextId)));
    sectionEntries.push({ heading: 'General', subtree: makeTreeNode(sectionNode, childTree) });
  }

  const sectionWidths = sectionEntries.map(entry => measureTreeWidth(entry.subtree, layoutSettings));
  const totalWidth = sumWidths(sectionWidths) + Math.max(0, sectionEntries.length - 1) * layoutSettings.sectionSpacing;
  const rootCenterX = Math.round(totalWidth / 2);

  root.x = rootCenterX - Math.round(root.width / 2);
  root.y = 40;

  let currentX = 0;
  const groupBounds = [];

  sectionEntries.forEach((entry, index) => {
    const width = sectionWidths[index];
    const startX = currentX;
    const centerX = startX + Math.round(width / 2);
    positionTree(entry.subtree, centerX, root.y + root.height + layoutSettings.verticalSpacing + 70, layoutSettings);

    const bounds = collectBounds(entry.subtree);
    groupBounds.push({
      id: nextId('group'),
      type: 'group',
      label: entry.heading,
      x: bounds.minX - 40,
      y: bounds.minY - 55,
      width: bounds.maxX - bounds.minX + 80,
      height: bounds.maxY - bounds.minY + 80,
      color: '6'
    });

    emitTree(entry.subtree, root.id, nodes, edges, nextId);
    currentX += width + layoutSettings.sectionSpacing;
  });

  nodes.unshift(...groupBounds);

  sectionEntries.forEach(entry => {
    edges.push({
      id: nextId('edge'),
      fromNode: root.id,
      fromSide: 'bottom',
      toNode: entry.subtree.node.id,
      toSide: 'top'
    });
  });

  return { nodes, edges };
}

function normalizeLayoutSettings(settings) {
  const compactFactor = settings.layoutMode === 'compact' ? 0.8 : 1;
  return {
    horizontalSpacing: Math.round(settings.horizontalSpacing * compactFactor),
    verticalSpacing: Math.round(settings.verticalSpacing * compactFactor),
    sectionSpacing: Math.round(settings.sectionSpacing * compactFactor)
  };
}

function makeTextNode(id, text, x, y, emphasized) {
  const lines = wrapText(text, emphasized ? 26 : 30);
  return {
    id,
    type: 'text',
    text,
    x,
    y,
    width: clamp(Math.max(240, maxLineLength(lines) * 8 + 60), 240, emphasized ? 420 : 360),
    height: Math.max(emphasized ? 100 : 86, lines.length * 24 + 40),
    color: emphasized ? '4' : '5'
  };
}

function makeFileNode(id, path, label) {
  const width = 260;
  const height = 220;
  return {
    id,
    type: 'file',
    file: path,
    x: 0,
    y: 0,
    width,
    height,
    color: '2'
  };
}

function convertMediaToTree(media, nextId) {
  const node = makeFileNode(nextId('image'), media.path, media.label);
  return makeTreeNode(node, []);
}

function convertItemToTree(item, nextId) {
  const node = item.kind === 'image'
    ? makeFileNode(nextId('image'), item.path, item.text)
    : makeTextNode(nextId('item'), item.text, 0, 0, false);
  const children = (item.children || []).map(child => convertItemToTree(child, nextId));
  return makeTreeNode(node, children);
}

function makeTreeNode(node, children) {
  return { node, children };
}

function measureTreeWidth(tree, settings) {
  if (!tree.children.length) return tree.node.width;
  const childWidths = tree.children.map(child => measureTreeWidth(child, settings));
  const childrenTotal = sumWidths(childWidths) + Math.max(0, childWidths.length - 1) * settings.horizontalSpacing;
  return Math.max(tree.node.width, childrenTotal);
}

function positionTree(tree, centerX, y, settings) {
  tree.node.x = Math.round(centerX - tree.node.width / 2);
  tree.node.y = Math.round(y);

  if (!tree.children.length) return;

  const childWidths = tree.children.map(child => measureTreeWidth(child, settings));
  const totalChildrenWidth = sumWidths(childWidths) + Math.max(0, childWidths.length - 1) * settings.horizontalSpacing;
  let currentX = centerX - totalChildrenWidth / 2;
  const childY = y + tree.node.height + settings.verticalSpacing;

  tree.children.forEach((child, index) => {
    const childWidth = childWidths[index];
    const childCenterX = currentX + childWidth / 2;
    positionTree(child, childCenterX, childY, settings);
    currentX += childWidth + settings.horizontalSpacing;
  });
}

function collectBounds(tree) {
  let minX = tree.node.x;
  let minY = tree.node.y;
  let maxX = tree.node.x + tree.node.width;
  let maxY = tree.node.y + tree.node.height;

  tree.children.forEach(child => {
    const bounds = collectBounds(child);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  });

  return { minX, minY, maxX, maxY };
}

function emitTree(tree, parentId, nodes, edges, nextId) {
  nodes.push(tree.node);

  if (parentId && parentId !== tree.node.id) {
    edges.push({
      id: nextId('edge'),
      fromNode: parentId,
      fromSide: 'bottom',
      toNode: tree.node.id,
      toSide: 'top'
    });
  }

  tree.children.forEach(child => emitTree(child, tree.node.id, nodes, edges, nextId));
}

async function saveCanvasFile(app, canvasName, canvasData, settings) {
  const folder = normalizeFolder(settings.outputFolder);
  const safeName = sanitizeName(canvasName || 'Untitled Map');
  let path = folder ? `${folder}/${safeName}.canvas` : `${safeName}.canvas`;

  if (folder && !app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder).catch(() => {});
  }

  const existing = app.vault.getAbstractFileByPath(path);
  if (existing && !settings.overwriteExisting) {
    let count = 2;
    while (app.vault.getAbstractFileByPath(path)) {
      path = folder ? `${folder}/${safeName} ${count}.canvas` : `${safeName} ${count}.canvas`;
      count += 1;
    }
  }

  const content = JSON.stringify(canvasData, null, 2);
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof obsidian.TFile) {
    await app.vault.modify(file, content);
  } else {
    await app.vault.create(path, content);
  }
  return path;
}

function normalizeFolder(folder) {
  return String(folder || '').trim().replace(/^\/+|\/+$/g, '');
}

function sanitizeName(name) {
  return String(name || 'Untitled Map').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled Map';
}

function wrapText(text, charsPerLine) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if ((current + ' ' + word).length <= charsPerLine) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function maxLineLength(lines) {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sumWidths(widths) {
  return widths.reduce((sum, width) => sum + width, 0);
}

module.exports = MarkdownToCanvasMapperPlugin;
