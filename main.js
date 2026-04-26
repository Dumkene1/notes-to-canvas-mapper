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

class NotesToCanvasMapperPlugin extends obsidian.Plugin {
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

    this.addSettingTab(new NotesToCanvasMapperSettingTab(this.app, this));
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
    const flowchartSource = extractFlowchartSource(markdown);
    if (flowchartSource) {
      const parsedFlowchart = parseFlowchartToGraph(flowchartSource, fallbackTitle || 'Flowchart Map');
      if (parsedFlowchart.nodes.size || parsedFlowchart.edges.length) {
        const canvasData = buildCanvasFromFlowchartGraph(parsedFlowchart, this.settings);
        const canvasPath = await saveCanvasFile(this.app, parsedFlowchart.title, canvasData, this.settings);
        new obsidian.Notice(`Canvas created from ${sourceLabel} flowchart: ${canvasPath}`);
        if (this.settings.autoOpenCanvas) await this.openCanvas(canvasPath);
        return;
      }
    }

    const parsed = parseMarkdownToStructure(markdown, fallbackTitle);
    const hasContent = parsed.sections.length > 0 || parsed.unsectionedItems.length > 0 || parsed.unsectionedMedia.length > 0;
    if (!hasContent) {
      new obsidian.Notice('No supported structure found. Use headings, bullet lists, image embeds, or simple flowchart syntax.');
      return;
    }

    const canvasData = buildCanvasFromParsedDoc(parsed, this.settings);
    const canvasPath = await saveCanvasFile(this.app, parsed.title, canvasData, this.settings);

    new obsidian.Notice(`Canvas created from ${sourceLabel}: ${canvasPath}`);
    if (this.settings.autoOpenCanvas) await this.openCanvas(canvasPath);
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
    if (!leaf) leaf = this.app.workspace.getMostRecentLeaf() || this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
}

class NotesToCanvasMapperSettingTab extends obsidian.PluginSettingTab {
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
      currentSection = { heading: trimmed.replace(/^##\s+/, '').trim(), items: [], media: [] };
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
  if (imageRef) return { kind: 'image', text: imageRef.label || imageRef.path, path: imageRef.path, children: [] };
  return { kind: 'text', text: content, children: [] };
}

function insertNestedItem(rootItems, item, indent) {
  if (indent <= 0) {
    rootItems.push(item);
    return;
  }
  const parent = findLastItemAtDepth(rootItems, indent - 1);
  if (!parent) rootItems.push(item);
  else parent.children.push(item);
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
    if (!childTree.length) childTree.push(makeTextNode(nextId('empty'), 'Empty section', 0, 0, false));
    sectionEntries.push({ heading: section.heading, subtree: makeTreeNode(sectionNode, childTree) });
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
      id: nextId('group'), type: 'group', label: entry.heading,
      x: bounds.minX - 40, y: bounds.minY - 55,
      width: bounds.maxX - bounds.minX + 80,
      height: bounds.maxY - bounds.minY + 80,
      color: '6'
    });
    emitTree(entry.subtree, root.id, nodes, edges, nextId);
    currentX += width + layoutSettings.sectionSpacing;
  });

  nodes.unshift(...groupBounds);
  sectionEntries.forEach(entry => {
    edges.push({ id: nextId('edge'), fromNode: root.id, fromSide: 'bottom', toNode: entry.subtree.node.id, toSide: 'top' });
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
    id, type: 'text', text, x, y,
    width: clamp(Math.max(240, maxLineLength(lines) * 8 + 60), 240, emphasized ? 420 : 360),
    height: Math.max(emphasized ? 100 : 86, lines.length * 24 + 40),
    color: emphasized ? '4' : '5'
  };
}

function makeFileNode(id, path, label) {
  return { id, type: 'file', file: path, x: 0, y: 0, width: 260, height: 220, color: '2' };
}

function convertMediaToTree(media, nextId) {
  return makeTreeNode(makeFileNode(nextId('image'), media.path, media.label), []);
}

function convertItemToTree(item, nextId) {
  const node = item.kind === 'image' ? makeFileNode(nextId('image'), item.path, item.text) : makeTextNode(nextId('item'), item.text, 0, 0, false);
  const children = (item.children || []).map(child => convertItemToTree(child, nextId));
  return makeTreeNode(node, children);
}

function makeTreeNode(node, children) { return { node, children }; }

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
    positionTree(child, currentX + childWidth / 2, childY, settings);
    currentX += childWidth + settings.horizontalSpacing;
  });
}

function collectBounds(tree) {
  let minX = tree.node.x, minY = tree.node.y, maxX = tree.node.x + tree.node.width, maxY = tree.node.y + tree.node.height;
  tree.children.forEach(child => {
    const bounds = collectBounds(child);
    minX = Math.min(minX, bounds.minX); minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX); maxY = Math.max(maxY, bounds.maxY);
  });
  return { minX, minY, maxX, maxY };
}

function emitTree(tree, parentId, nodes, edges, nextId) {
  nodes.push(tree.node);
  if (parentId && parentId !== tree.node.id) {
    edges.push({ id: nextId('edge'), fromNode: parentId, fromSide: 'bottom', toNode: tree.node.id, toSide: 'top' });
  }
  tree.children.forEach(child => emitTree(child, tree.node.id, nodes, edges, nextId));
}

// -------------------------
// Simple Flowchart Mode
// -------------------------

function extractFlowchartSource(markdown) {
  const text = String(markdown || '').trim();
  if (!text) return null;
  const fenced = text.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fenced && isFlowchartHeader(fenced[1])) return fenced[1].trim();
  if (isFlowchartHeader(text)) return text;
  return null;
}

function isFlowchartHeader(text) {
  return /^\s*(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.test(String(text || ''));
}

function parseFlowchartToGraph(source, fallbackTitle) {
  const lines = String(source || '').split(/\r?\n/);
  const graph = { title: fallbackTitle || 'Flowchart Map', direction: 'TD', nodes: new Map(), edges: [], groups: [], classDefs: new Map() };
  const groupStack = [];

  for (const rawLine of lines) {
    let line = stripMermaidComment(rawLine).trim();
    if (!line) continue;

    const header = line.match(/^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b\s*(.*)$/i);
    if (header) {
      graph.direction = normalizeDirection(header[2]);
      line = (header[3] || '').trim();
      if (!line) continue;
    }

    const classDef = line.match(/^classDef\s+([A-Za-z0-9_-]+)\s+(.+)$/i);
    if (classDef) {
      graph.classDefs.set(classDef[1], parseClassDefStyles(classDef[2]));
      continue;
    }

    const subgraph = line.match(/^subgraph\s+(.+)$/i);
    if (subgraph) {
      const label = cleanLabelText(subgraph[1]);
      const id = `group-${graph.groups.length + 1}`;
      const group = { id, label, direction: graph.direction, nodeIds: new Set() };
      graph.groups.push(group);
      groupStack.push(group);
      continue;
    }

    const direction = line.match(/^direction\s+(TD|TB|BT|LR|RL)\b/i);
    if (direction && groupStack.length) {
      groupStack[groupStack.length - 1].direction = normalizeDirection(direction[1]);
      continue;
    }

    if (/^end\b/i.test(line)) {
      groupStack.pop();
      continue;
    }

    const edge = splitFlowchartEdge(line);
    if (edge) {
      const leftNodes = splitOutsideBrackets(edge.left, '&').map(parseFlowchartNodeToken).filter(Boolean);
      const rightNodes = splitOutsideBrackets(edge.right, '&').map(parseFlowchartNodeToken).filter(Boolean);
      for (const from of leftNodes) {
        registerFlowchartNode(graph, from, groupStack);
        for (const to of rightNodes) {
          registerFlowchartNode(graph, to, groupStack);
          graph.edges.push({ from: from.id, to: to.id, label: edge.label || '' });
        }
      }
      continue;
    }

    const standalone = parseFlowchartNodeToken(line);
    if (standalone) registerFlowchartNode(graph, standalone, groupStack);
  }
  return graph;
}

function normalizeDirection(direction) {
  const value = String(direction || 'TD').toUpperCase();
  return value === 'TB' ? 'TD' : value;
}

function stripMermaidComment(line) {
  const value = String(line || '');
  const index = value.indexOf('%%');
  return index >= 0 ? value.slice(0, index) : value;
}

function parseClassDefStyles(styleText) {
  const styles = {};
  String(styleText || '').split(',').forEach(part => {
    const [rawKey, ...rawValue] = part.split(':');
    if (!rawKey || !rawValue.length) return;
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(':').trim();
    if (key && value) styles[key] = value;
  });
  return styles;
}

function splitFlowchartEdge(line) {
  const arrows = ['-.->', '==>', '-->', '---'];
  for (const arrow of arrows) {
    const index = findOutsideBrackets(line, arrow);
    if (index >= 0) {
      const left = line.slice(0, index).trim();
      let right = line.slice(index + arrow.length).trim();
      let label = '';
      const labelMatch = right.match(/^\|([^|]+)\|\s*(.*)$/);
      if (labelMatch) {
        label = labelMatch[1].trim();
        right = labelMatch[2].trim();
      }
      if (left && right) return { left, right, arrow, label };
    }
  }
  return null;
}

function findOutsideBrackets(text, needle) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i <= text.length - needle.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && text.slice(i, i + needle.length) === needle) return i;
  }
  return -1;
}

function splitOutsideBrackets(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function parseFlowchartNodeToken(token) {
  let value = String(token || '').trim().replace(/;$/, '').trim();
  if (!value) return null;
  let className = '';
  const classIndex = findOutsideBrackets(value, ':::');
  if (classIndex >= 0) {
    className = value.slice(classIndex + 3).trim().split(/\s+/)[0] || '';
    value = value.slice(0, classIndex).trim();
  }
  const bracketMatch = value.match(/^([A-Za-z0-9_.$:-]+)\s*\[([\s\S]*)\]$/);
  if (bracketMatch) {
    const id = bracketMatch[1].trim();
    const label = bracketMatch[2].trim();
    if (!id) return null;
    return { id, label: cleanLabelText(label) || id, className };
  }
  const idOnly = value.trim();
  if (!/^[A-Za-z0-9_.$:-]+$/.test(idOnly)) return null;
  return { id: idOnly, label: idOnly, className };
}

function cleanLabelText(text) {
  let value = String(text || '').trim();
  value = value.replace(/^\[|\]$/g, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.trim();
}

function registerFlowchartNode(graph, parsedNode, groupStack) {
  if (!graph.nodes.has(parsedNode.id)) {
    graph.nodes.set(parsedNode.id, { id: parsedNode.id, label: parsedNode.label || parsedNode.id, classes: new Set(), groupIds: new Set() });
  }
  const node = graph.nodes.get(parsedNode.id);
  if (parsedNode.label && node.label === node.id) node.label = parsedNode.label;
  if (parsedNode.className) node.classes.add(parsedNode.className);
  groupStack.forEach(group => {
    group.nodeIds.add(parsedNode.id);
    node.groupIds.add(group.id);
  });
}

function buildCanvasFromFlowchartGraph(graph, settings) {
  const layoutSettings = normalizeLayoutSettings(settings);
  const nodes = [];
  const edges = [];
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`;
  const nodeIdMap = new Map();
  const canvasNodes = new Map();

  for (const graphNode of graph.nodes.values()) {
    const canvasNode = makeTextNode(nextId('flow'), graphNode.label, 0, 0, false);
    const color = resolveFlowchartNodeColor(graphNode, graph.classDefs);
    if (color) canvasNode.color = color;
    nodeIdMap.set(graphNode.id, canvasNode.id);
    canvasNodes.set(graphNode.id, canvasNode);
  }

  positionFlowchartNodes(graph, canvasNodes, layoutSettings);
  nodes.push(...canvasNodes.values());

  const side = edgeSidesForDirection(graph.direction);
  graph.edges.forEach(edge => {
    const fromNode = nodeIdMap.get(edge.from);
    const toNode = nodeIdMap.get(edge.to);
    if (!fromNode || !toNode) return;
    const canvasEdge = { id: nextId('edge'), fromNode, fromSide: side.from, toNode, toSide: side.to };
    if (edge.label) canvasEdge.label = edge.label;
    edges.push(canvasEdge);
  });

  const groupNodes = [];
  graph.groups.forEach(group => {
    const memberNodes = [...group.nodeIds].map(id => canvasNodes.get(id)).filter(Boolean);
    if (!memberNodes.length) return;
    const bounds = collectNodeBounds(memberNodes);
    groupNodes.push({
      id: nextId('group'), type: 'group', label: group.label,
      x: bounds.minX - 60, y: bounds.minY - 70,
      width: bounds.maxX - bounds.minX + 120,
      height: bounds.maxY - bounds.minY + 120,
      color: '6'
    });
  });
  nodes.unshift(...groupNodes);
  return { nodes, edges };
}

function resolveFlowchartNodeColor(graphNode, classDefs) {
  for (const className of graphNode.classes) {
    const styles = classDefs.get(className);
    if (!styles) continue;
    const color = styles.fill || styles.stroke;
    if (color) return normalizeCanvasColor(color);
  }
  return null;
}

function normalizeCanvasColor(color) {
  const value = String(color || '').trim().toLowerCase();
  const named = {
    red: '#ff6666', orange: '#ffa94d', yellow: '#ffd43b', green: '#69db7c',
    blue: '#74c0fc', purple: '#b197fc', pink: '#faa2c1', gray: '#adb5bd', grey: '#adb5bd',
    black: '#000000', white: '#ffffff'
  };
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) return value;
  return named[value] || value;
}

function edgeSidesForDirection(direction) {
  switch ((direction || 'TD').toUpperCase()) {
    case 'LR': return { from: 'right', to: 'left' };
    case 'RL': return { from: 'left', to: 'right' };
    case 'BT': return { from: 'top', to: 'bottom' };
    case 'TD':
    default: return { from: 'bottom', to: 'top' };
  }
}

function positionFlowchartNodes(graph, canvasNodes, settings) {
  const ranks = computeGraphRanks(graph);
  const layers = new Map();
  for (const id of graph.nodes.keys()) {
    const rank = ranks.get(id) || 0;
    if (!layers.has(rank)) layers.set(rank, []);
    layers.get(rank).push(id);
  }
  const orderedRanks = [...layers.keys()].sort((a, b) => a - b);
  const direction = (graph.direction || 'TD').toUpperCase();
  const horizontal = direction === 'LR' || direction === 'RL';
  const reverse = direction === 'RL' || direction === 'BT';
  const maxRank = orderedRanks.length ? Math.max(...orderedRanks) : 0;
  const levelGap = Math.max(260, settings.horizontalSpacing + 240);
  const laneGap = Math.max(130, settings.verticalSpacing + 80);

  orderedRanks.forEach(rank => {
    const ids = layers.get(rank) || [];
    ids.sort();
    const layerSize = ids.length;
    ids.forEach((id, index) => {
      const node = canvasNodes.get(id);
      if (!node) return;
      const primaryRank = reverse ? maxRank - rank : rank;
      const centeredOffset = (index - (layerSize - 1) / 2) * laneGap;
      if (horizontal) {
        node.x = Math.round(60 + primaryRank * levelGap);
        node.y = Math.round(260 + centeredOffset);
      } else {
        node.x = Math.round(260 + centeredOffset);
        node.y = Math.round(60 + primaryRank * levelGap);
      }
    });
  });
}

function computeGraphRanks(graph) {
  const ranks = new Map();
  const indegree = new Map();
  const outgoing = new Map();
  for (const id of graph.nodes.keys()) {
    indegree.set(id, 0);
    outgoing.set(id, []);
    ranks.set(id, 0);
  }
  graph.edges.forEach(edge => {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) return;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  });
  const queue = [];
  for (const [id, count] of indegree.entries()) if (count === 0) queue.push(id);
  if (!queue.length) queue.push(...graph.nodes.keys());
  const visits = new Map();
  while (queue.length) {
    const id = queue.shift();
    const currentRank = ranks.get(id) || 0;
    visits.set(id, (visits.get(id) || 0) + 1);
    if ((visits.get(id) || 0) > graph.nodes.size + 2) continue;
    for (const next of outgoing.get(id) || []) {
      const proposed = currentRank + 1;
      if (proposed > (ranks.get(next) || 0) && proposed <= graph.nodes.size) {
        ranks.set(next, proposed);
        queue.push(next);
      }
    }
  }
  return ranks;
}

function collectNodeBounds(nodeList) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  nodeList.forEach(node => {
    minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width); maxY = Math.max(maxY, node.y + node.height);
  });
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
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
  if (file instanceof obsidian.TFile) await app.vault.modify(file, content);
  else await app.vault.create(path, content);
  return path;
}

function normalizeFolder(folder) { return String(folder || '').trim().replace(/^\/+|\/+$/g, ''); }
function sanitizeName(name) { return String(name || 'Untitled Map').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled Map'; }

function wrapText(text, charsPerLine) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if ((current + ' ' + word).length <= charsPerLine) current += ' ' + word;
    else { lines.push(current); current = word; }
  }
  lines.push(current);
  return lines;
}
function maxLineLength(lines) { return lines.reduce((max, line) => Math.max(max, line.length), 0); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function sumWidths(widths) { return widths.reduce((sum, width) => sum + width, 0); }

module.exports = NotesToCanvasMapperPlugin;
